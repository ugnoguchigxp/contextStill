import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { LarmError } from "../../../larm";
import { DistillError, assessOutput } from "../../contracts";
import {
	findOkCallByDigest,
	getLlmCall,
	llmCallTotals,
} from "../../repository";
import {
	createFakeLlm,
	createTestDistill,
	isRepair,
	requestDigest,
} from "../../test/fixtures";
import { callJson, inputDigest, type JsonCall } from "./index";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});
const setup = () => {
	const t = createTestDistill();
	ts.push(t);
	return t;
};

const schema = z.strictObject({ n: z.number(), tag: z.string() });
const call = (
	over: Partial<JsonCall<z.infer<typeof schema>>> = {},
): JsonCall<z.infer<typeof schema>> => ({
	runId: null,
	stage: "assess",
	subjectRef: "k1",
	promptVersion: "p1",
	system: "SYSTEM",
	user: "USER a1",
	schema,
	maxOutputTokens: 100,
	signal: new AbortController().signal,
	...over,
});
const rows = (t: ReturnType<typeof setup>) =>
	t.deps.store.read((db) =>
		db
			.query(
				"SELECT id, outcome, input_digest, model, input_tokens FROM distill_llm_calls ORDER BY rowid",
			)
			.all(),
	) as {
		id: string;
		outcome: string;
		input_digest: string;
		model: string;
		input_tokens: number;
	}[];

test("an answer is reused only for the same model, and never before the model is known", async () => {
	const t = setup();
	t.llm.queue({ n: 1, tag: "x" }, { n: 2, tag: "y" }, { n: 3, tag: "z" });
	const first = await callJson(t.deps, call());
	expect((await callJson(t.deps, call())).callId).toBe(first.callId);
	// another model answers: the stored answer of fake-llm-1 is not reused
	const model = t.deps.llm.model;
	t.deps.llm.model = () => "other-model";
	expect((await callJson(t.deps, call())).cached).toBe(false);
	// not connected yet: no reuse at all
	t.deps.llm.model = () => null;
	expect((await callJson(t.deps, call())).cached).toBe(false);
	t.deps.llm.model = model;
});

test("a valid answer is parsed, recorded and returned", async () => {
	const t = setup();
	t.llm.queue({ n: 1, tag: "x" });
	const r = await callJson(t.deps, call());
	expect(r.value).toEqual({ n: 1, tag: "x" });
	expect(r.cached).toBe(false);
	const [row] = rows(t);
	expect(row).toMatchObject({
		id: r.callId,
		outcome: "ok",
		model: "fake-llm-1",
	});
	// The digest leaves the model out; the row's model column is matched on reuse.
	expect(row!.input_digest).toBe(inputDigest("fixture", null, call()));
	expect(t.deps.store.read((db) => getLlmCall(db, r.callId))!.response).toEqual(
		{ n: 1, tag: "x" },
	);
	// the request carried json:true and the two messages
	expect(t.llm.calls[0]).toMatchObject({ json: true, maxOutputTokens: 100 });
	expect(t.llm.calls[0]!.messages.map((m) => m.role)).toEqual([
		"system",
		"user",
	]);
});

test("the same input is answered from the stored call without asking the model", async () => {
	const t = setup();
	t.llm.queue({ n: 1, tag: "x" });
	const first = await callJson(t.deps, call());
	const second = await callJson(
		t.deps,
		call({ runId: null, subjectRef: "other-subject" }),
	);
	expect(second).toEqual({
		value: { n: 1, tag: "x" },
		callId: first.callId,
		cached: true,
	});
	expect(t.llm.calls.length).toBe(1);
	expect(rows(t).length).toBe(1);
	// another prompt version, another text or another model is another input
	t.llm.queue({ n: 2, tag: "y" }, { n: 3, tag: "z" });
	expect((await callJson(t.deps, call({ promptVersion: "p2" }))).value.n).toBe(
		2,
	);
	expect((await callJson(t.deps, call({ user: "USER a2" }))).value.n).toBe(3);
	expect(t.llm.calls.length).toBe(3);
	expect(inputDigest("fixture", "m1", call())).not.toBe(
		inputDigest("fixture", "m2", call()),
	);
	expect(inputDigest("fixture", "m1", call())).not.toBe(
		inputDigest("larm", "m1", call()),
	);
});

test("a stored answer that no longer fits the schema is not reused", async () => {
	const t = setup();
	t.llm.queue({ n: 1, tag: "x" }, { n: 2, tag: "yy" });
	await callJson(t.deps, call());
	const wider = z.strictObject({ n: z.number(), tag: z.string().min(2) });
	const r = await callJson(t.deps, call({ schema: wider }));
	expect(r.cached).toBe(false);
});

test("an invalid answer is corrected once, told only the paths of the problems", async () => {
	const t = setup();
	t.llm.when((req) => !isRepair(req), { n: "one", tag: "SECRET-VALUE" });
	t.llm.when(isRepair, { n: 1, tag: "x" });
	const r = await callJson(t.deps, call());
	expect(r.value).toEqual({ n: 1, tag: "x" });
	expect(r.cached).toBe(false);
	const [bad, ok] = rows(t);
	expect([bad!.outcome, ok!.outcome]).toEqual(["invalid_output", "ok"]);
	expect(bad!.input_digest).toBe(ok!.input_digest);
	expect(r.callId).toBe(ok!.id);
	const repair = t.llm.calls[1]!;
	expect(repair.messages.map((m) => m.role)).toEqual([
		"system",
		"user",
		"assistant",
		"user",
	]);
	expect(repair.messages[3]!.content).toContain("n");
	expect(repair.messages[3]!.content).not.toContain("SECRET-VALUE");
	// the corrected answer is what a re-run reuses
	expect((await callJson(t.deps, call())).cached).toBe(true);
});

test("broken JSON is corrected once; a code fence around valid JSON is accepted", async () => {
	const t = setup();
	t.llm.queue("{not json", '```json\n{"n": 4, "tag": "f"}\n```');
	const r = await callJson(t.deps, call());
	expect(r.value).toEqual({ n: 4, tag: "f" });
	expect(t.llm.calls[1]!.messages[3]!.content).toContain("not valid JSON");
});

test("a second invalid answer is recorded and ends in llm_invalid_output", async () => {
	const t = setup();
	t.llm.fallback = { n: "bad" };
	await expect(callJson(t.deps, call())).rejects.toMatchObject({
		code: "llm_invalid_output",
	});
	await expect(
		callJson(t.deps, call({ user: "again" })),
	).rejects.toBeInstanceOf(DistillError);
	expect(rows(t).map((r) => r.outcome)).toEqual([
		"invalid_output",
		"invalid_output",
		"invalid_output",
		"invalid_output",
	]);
	expect(t.deps.store.read(llmCallTotals).invalidOutput).toBe(4);
	// nothing was cached
	expect(
		t.deps.store.read((db) => findOkCallByDigest(db, rows(t)[0]!.input_digest)),
	).toBeNull();
});

test("a LarmError is recorded as provider_error and rethrown unchanged; other errors are only rethrown", async () => {
	const t = setup();
	const busy = new LarmError("larm_busy", 2000);
	t.llm.queue(busy, new Error("boom"));
	await expect(callJson(t.deps, call())).rejects.toBe(busy);
	expect(rows(t).map((r) => r.outcome)).toEqual(["provider_error"]);
	await expect(callJson(t.deps, call())).rejects.toThrow("boom");
	expect(rows(t).length).toBe(1);
});

test("an aborted signal stops the call", async () => {
	const t = setup();
	t.llm.fallback = { n: 1, tag: "x" };
	const controller = new AbortController();
	controller.abort();
	await expect(
		callJson(t.deps, call({ signal: controller.signal })),
	).rejects.toThrow();
	expect(rows(t)).toEqual([]);
});

test("the contract schema assessOutput accepts the documented shape only", () => {
	const ok = {
		schemaVersion: 1,
		items: [{ ref: "a1", generality: "general", reason: "" }],
	};
	expect(assessOutput.safeParse(ok).success).toBe(true);
	expect(assessOutput.safeParse({ ...ok, extra: 1 }).success).toBe(false);
	expect(
		assessOutput.safeParse({
			schemaVersion: 1,
			items: [{ ref: "uuid-1", generality: "general", reason: "" }],
		}).success,
	).toBe(false);
	expect(assessOutput.safeParse({ schemaVersion: 1, items: [] }).success).toBe(
		false,
	);
});

test("the fake LLM replies by rule, digest and sequence, and counts releases", async () => {
	const llm = createFakeLlm({ model: null, chatModel: "m-x" });
	const ask = (text: string) =>
		llm.chat({
			messages: [{ role: "user", content: text }],
			maxOutputTokens: 10,
			json: true,
		});
	llm.when("alpha", { who: "alpha" });
	llm.when(/beta/, "raw text");
	llm.onDigest(
		requestDigest({ messages: [{ role: "user", content: "gamma" }] }),
		{ who: "g1" },
		{ who: "g2" },
	);
	llm.queue({ who: "q1" });
	expect(JSON.parse((await ask("an alpha")).text)).toEqual({ who: "alpha" });
	expect((await ask("beta!")).text).toBe("raw text");
	expect(JSON.parse((await ask("gamma")).text).who).toBe("g1");
	expect(JSON.parse((await ask("gamma")).text).who).toBe("g2");
	expect(JSON.parse((await ask("gamma")).text).who).toBe("g2");
	const r = await ask("unmatched");
	expect(JSON.parse(r.text)).toEqual({ who: "q1" });
	expect(r).toMatchObject({ model: "m-x", finishReason: "stop" });
	await expect(ask("unmatched")).rejects.toThrow("fake_llm_no_reply");
	expect(llm.model?.()).toBeNull();
	expect(llm.calls.length).toBe(7);
	await llm.release();
	expect(llm.released).toBe(1);
	expect(llm.status().connection).toBe("ready");
});
