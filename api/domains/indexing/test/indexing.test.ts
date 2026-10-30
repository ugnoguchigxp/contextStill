import { afterEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { knowledgeContentDigest } from "../../knowledge";
import { LarmError } from "../../larm";
import { getVector } from "../../vectors";
import {
	EmbedAbortedError,
	embedMissing,
	embeddingText,
	verifyLegacyVectors,
} from "../index";
import {
	addEpisode,
	addKnowledge,
	busy,
	fakeVector,
	initSpace,
	kText,
	putVector,
	setup,
} from "./fixtures";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});
async function ready() {
	const s = setup();
	disposers.push(s.dispose);
	await initSpace(s.deps);
	return s;
}
const vectorOf = (
	s: Awaited<ReturnType<typeof ready>>,
	kind: "knowledge" | "episode",
	id: string,
) => s.store.read((db) => getVector(db, kind, id, s.deps.spaceKey));
const runs = (s: Awaited<ReturnType<typeof ready>>) =>
	s.store.read((db) =>
		db.query("SELECT * FROM vector_verifications").all(),
	) as any[];

const VERIFY = {
	sampleSize: 32,
	thresholdMin: 0.995,
	thresholdMean: 0.999,
	dryRun: false,
};

describe("embeddingText", () => {
	test("knowledge is title + newline + body, the legacy content_hash input", () => {
		const text = embeddingText("knowledge", { title: "T", body: "B" });
		expect(text).toBe("T\nB");
		expect(sha256Hex(text)).toBe(knowledgeContentDigest("T", "B"));
		expect(sha256Hex(text)).toBe(sha256Hex("T" + "\n" + "B"));
	});
	test("knowledge with an empty body still has the newline", () => {
		expect(embeddingText("knowledge", { title: "T", body: "" })).toBe("T\n");
	});
	test("episode joins the non-empty fields", () => {
		expect(
			embeddingText("episode", {
				title: "t",
				situation: "s",
				action: "",
				outcome: "o",
				lesson: "l",
			}),
		).toBe("t\ns\no\nl");
		expect(embeddingText("episode", { title: "t" })).toBe("t");
	});
});

describe("verifyLegacyVectors", () => {
	async function seed(
		s: Awaited<ReturnType<typeof ready>>,
		n: number,
		vectorText = (t: string) => t,
	) {
		for (let i = 0; i < n; i++) {
			const id = `k${i}`;
			await addKnowledge(s.deps, id);
			await putVector(s.deps, {
				ownerId: id,
				text: vectorText(kText(`title ${id}`, `body ${id}`)),
				// A legacy vector's digest is the row's content digest, whatever text made it.
				digest: knowledgeContentDigest(`title ${id}`, `body ${id}`),
			});
		}
	}

	test("pass: every unverified legacy vector becomes verified and a run is recorded", async () => {
		const s = await ready();
		await seed(s, 5);
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report).toMatchObject({
			sampleSize: 5,
			passed: true,
			prefixDiagnostic: null,
			updatedRows: 5,
		});
		expect(report.minCosine).toBeGreaterThan(0.9999);
		for (let i = 0; i < 5; i++)
			expect((await vectorOf(s, "knowledge", `k${i}`))!.verification).toBe(
				"verified",
			);
		const [run] = runs(s);
		expect(run).toMatchObject({
			id: report.runId,
			owner_kind: "knowledge",
			origin: "legacy_import",
			sample_size: 5,
			passed: 1,
			threshold_min: 0.995,
			threshold_mean: 0.999,
		});
		expect(s.larm.calls).toHaveLength(1);
		expect(s.larm.calls[0]!.type).toBe("passage");
		expect(s.larm.calls[0]!.texts[0]!.startsWith("passage: ")).toBe(false);
	});

	test("pass verifies the whole population, not only the sample", async () => {
		const s = await ready();
		await seed(s, 6);
		const report = await verifyLegacyVectors(s.deps, {
			...VERIFY,
			sampleSize: 2,
		});
		expect(report.sampleSize).toBe(2);
		expect(report.updatedRows).toBe(6);
	});

	test("fail: vectors become mismatch and the prefix diagnostic is filled", async () => {
		const s = await ready();
		// Stored vectors were made from prefixed text; a plain embed of the text does not match.
		await seed(s, 4, (t) => `passage: ${t}`);
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report.passed).toBe(false);
		expect(report.minCosine!).toBeLessThan(0.5);
		expect(report.prefixDiagnostic!.minCosine).toBeGreaterThan(0.9999);
		expect(report.prefixDiagnostic!.meanCosine).toBeGreaterThan(0.9999);
		expect(report.updatedRows).toBe(4);
		expect((await vectorOf(s, "knowledge", "k0"))!.verification).toBe(
			"mismatch",
		);
		expect(runs(s)[0].passed).toBe(0);
		expect(
			s.logs.some((l) =>
				l.includes("vectors:embed -- --owner knowledge --all"),
			),
		).toBe(true);
		expect(
			s.larm.calls.map((c) => c.texts[0]!.startsWith("passage: ")),
		).toEqual([false, true]);
	});

	test("fail without any prefix relation gives a low diagnostic", async () => {
		const s = await ready();
		await addKnowledge(s.deps, "k0");
		await putVector(s.deps, {
			ownerId: "k0",
			text: "unrelated",
			digest: knowledgeContentDigest("title k0", "body k0"),
		});
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report.passed).toBe(false);
		expect(report.prefixDiagnostic!.minCosine).toBeLessThan(0.5);
	});

	test("a min below the threshold fails even when the mean is high", async () => {
		const s = await ready();
		await seed(s, 3);
		await addKnowledge(s.deps, "bad");
		await putVector(s.deps, {
			ownerId: "bad",
			text: "other",
			digest: knowledgeContentDigest("title bad", "body bad"),
		});
		const report = await verifyLegacyVectors(s.deps, {
			...VERIFY,
			thresholdMean: 0.1,
		});
		expect(report.passed).toBe(false);
	});

	test("the sample is the sha256(id)-ascending head and is deterministic", async () => {
		const s = await ready();
		await seed(s, 8);
		await verifyLegacyVectors(s.deps, {
			...VERIFY,
			sampleSize: 3,
			dryRun: true,
		});
		await verifyLegacyVectors(s.deps, {
			...VERIFY,
			sampleSize: 3,
			dryRun: true,
		});
		const expected = [...Array(8).keys()]
			.map((i) => `k${i}`)
			.sort((a, b) => (sha256Hex(a) < sha256Hex(b) ? -1 : 1))
			.slice(0, 3)
			.map((id) => kText(`title ${id}`, `body ${id}`));
		expect(s.larm.calls[0]!.texts).toEqual(expected);
		expect(s.larm.calls[1]!.texts).toEqual(expected);
	});

	test("dry-run reads and embeds but writes nothing", async () => {
		const s = await ready();
		await seed(s, 3);
		const report = await verifyLegacyVectors(s.deps, {
			...VERIFY,
			dryRun: true,
		});
		expect(report).toMatchObject({
			passed: true,
			updatedRows: 0,
			sampleSize: 3,
		});
		expect(runs(s)).toHaveLength(0);
		expect((await vectorOf(s, "knowledge", "k0"))!.verification).toBe(
			"unverified",
		);
	});

	test("only unverified legacy_import vectors are in the population", async () => {
		const s = await ready();
		await seed(s, 2);
		await addKnowledge(s.deps, "done");
		await putVector(s.deps, {
			ownerId: "done",
			text: "x",
			verification: "verified",
		});
		await addKnowledge(s.deps, "larm1");
		await putVector(s.deps, {
			ownerId: "larm1",
			text: "x",
			origin: "larm",
			verification: "unverified",
		});
		const report = await verifyLegacyVectors(s.deps, {
			...VERIFY,
			dryRun: true,
		});
		expect(report.sampleSize).toBe(2);
	});

	test("nothing to verify returns an empty report without calling LARM", async () => {
		const s = await ready();
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report).toMatchObject({
			sampleSize: 0,
			passed: false,
			minCosine: null,
			meanCosine: null,
			updatedRows: 0,
		});
		expect(s.larm.calls).toHaveLength(0);
		expect(runs(s)).toHaveLength(0);
	});

	test("a vector made from an older text is not in the population and stays unverified", async () => {
		const s = await ready();
		await seed(s, 2);
		await addKnowledge(s.deps, "old");
		await putVector(s.deps, { ownerId: "old", text: "an older text" });
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report).toMatchObject({
			sampleSize: 2,
			passed: true,
			updatedRows: 2,
		});
		expect((await vectorOf(s, "knowledge", "old"))!.verification).toBe(
			"unverified",
		);
		expect((await vectorOf(s, "knowledge", "k0"))!.verification).toBe(
			"verified",
		);
	});

	test("an orphan vector (no owner row) is not touched by a pass or a failure", async () => {
		for (const prefixed of [false, true]) {
			const s = await ready();
			await seed(s, 2, prefixed ? (t) => `passage: ${t}` : (t) => t);
			await putVector(s.deps, { ownerId: "orphan", text: "x" });
			const report = await verifyLegacyVectors(s.deps, VERIFY);
			expect(report.passed).toBe(!prefixed);
			expect(report.updatedRows).toBe(2);
			expect((await vectorOf(s, "knowledge", "orphan"))!.verification).toBe(
				"unverified",
			);
			expect((await vectorOf(s, "knowledge", "k0"))!.verification).toBe(
				prefixed ? "mismatch" : "verified",
			);
		}
	});

	test("a row added while the sample is embedded is not verified", async () => {
		const s = await ready();
		await seed(s, 2);
		const embed = s.larm.embed.bind(s.larm);
		s.larm.embed = async (texts, type) => {
			await addKnowledge(s.deps, "late");
			await putVector(s.deps, {
				ownerId: "late",
				text: kText("title late", "body late"),
			});
			return embed(texts, type);
		};
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report).toMatchObject({ passed: true, updatedRows: 2 });
		expect((await vectorOf(s, "knowledge", "late"))!.verification).toBe(
			"unverified",
		);
	});

	test("a population made only of stale-text vectors changes nothing and records no run", async () => {
		const s = await ready();
		for (const id of ["a", "b"]) {
			await addKnowledge(s.deps, id);
			await putVector(s.deps, { ownerId: id, text: "an older text" });
		}
		const report = await verifyLegacyVectors(s.deps, VERIFY);
		expect(report).toMatchObject({
			sampleSize: 0,
			passed: false,
			minCosine: null,
			meanCosine: null,
			updatedRows: 0,
		});
		expect(s.larm.calls).toHaveLength(0);
		expect(runs(s)).toHaveLength(0);
		expect((await vectorOf(s, "knowledge", "a"))!.verification).toBe(
			"unverified",
		);
	});

	test("a LARM stop error aborts without writing", async () => {
		const s = await ready();
		await seed(s, 2);
		s.larm.onEmbed = () => {
			throw new LarmError("larm_embedding_space_mismatch");
		};
		await expect(verifyLegacyVectors(s.deps, VERIFY)).rejects.toThrow(
			"larm_embedding_space_mismatch",
		);
		expect((await vectorOf(s, "knowledge", "k0"))!.verification).toBe(
			"unverified",
		);
		expect(runs(s)).toHaveLength(0);
	});
});

describe("embedMissing", () => {
	const ARGS = {
		owner: "knowledge" as const,
		mode: "missing" as const,
		batchSize: 2,
		dryRun: false,
	};

	test("missing: no vector, other digest, mismatch and stale are embedded; up to date is skipped", async () => {
		const s = await ready();
		for (const id of [
			"none",
			"digest",
			"mismatch",
			"stale",
			"ok",
			"unverified",
		])
			await addKnowledge(s.deps, id);
		await addKnowledge(s.deps, "retracted", { status: "retracted" });
		const text = (id: string) => kText(`title ${id}`, `body ${id}`);
		await putVector(s.deps, { ownerId: "digest", text: "old text" });
		await putVector(s.deps, {
			ownerId: "mismatch",
			text: text("mismatch"),
			verification: "mismatch",
		});
		await putVector(s.deps, {
			ownerId: "stale",
			text: text("stale"),
			origin: "larm",
			verification: "stale",
		});
		await putVector(s.deps, {
			ownerId: "ok",
			text: text("ok"),
			origin: "larm",
			verification: "verified",
		});
		await putVector(s.deps, {
			ownerId: "unverified",
			text: text("unverified"),
		});

		const report = await embedMissing(s.deps, ARGS);
		expect(report).toEqual({
			owner: "knowledge",
			candidates: 4,
			embedded: 4,
			skipped: 2,
			failed: 0,
			busyWaits: 0,
		});
		expect(s.larm.calls.map((c) => c.texts.length)).toEqual([2, 2]);
		for (const id of ["none", "digest", "mismatch", "stale"]) {
			const v = (await vectorOf(s, "knowledge", id))!;
			expect(v).toMatchObject({
				origin: "larm",
				verification: "verified",
				contentDigest: sha256Hex(text(id)),
			});
			expect(Array.from(v.vector)).toEqual(Array.from(fakeVector(text(id))));
		}
		expect((await vectorOf(s, "knowledge", "unverified"))!.origin).toBe(
			"legacy_import",
		);
		expect(await vectorOf(s, "knowledge", "retracted")).toBeNull();
	});

	test("all re-embeds every active row, replacing legacy vectors", async () => {
		const s = await ready();
		await addKnowledge(s.deps, "a");
		await addKnowledge(s.deps, "b");
		await putVector(s.deps, { ownerId: "a", text: kText("title a", "body a") });
		const report = await embedMissing(s.deps, { ...ARGS, mode: "all" });
		expect(report).toMatchObject({ candidates: 2, embedded: 2, skipped: 0 });
		expect(await vectorOf(s, "knowledge", "a")).toMatchObject({
			origin: "larm",
			verification: "verified",
		});
	});

	test("limit caps the candidates; a second run continues", async () => {
		const s = await ready();
		for (const id of ["a", "b", "c"]) await addKnowledge(s.deps, id);
		const first = await embedMissing(s.deps, { ...ARGS, limit: 2 });
		expect(first).toMatchObject({ candidates: 2, embedded: 2 });
		const second = await embedMissing(s.deps, ARGS);
		expect(second).toMatchObject({ candidates: 1, embedded: 1, skipped: 2 });
	});

	test("dry-run counts but neither calls LARM nor writes", async () => {
		const s = await ready();
		await addKnowledge(s.deps, "a");
		const report = await embedMissing(s.deps, { ...ARGS, dryRun: true });
		expect(report).toMatchObject({ candidates: 1, embedded: 0 });
		expect(s.larm.calls).toHaveLength(0);
		expect(await vectorOf(s, "knowledge", "a")).toBeNull();
	});

	test("episodes use the episode text and the episode table", async () => {
		const s = await ready();
		await addEpisode(s.deps, "e1", { action: "" });
		const report = await embedMissing(s.deps, { ...ARGS, owner: "episode" });
		expect(report).toMatchObject({
			owner: "episode",
			candidates: 1,
			embedded: 1,
		});
		const text = "episode e1\nsituation\noutcome\nlesson";
		expect(s.larm.calls[0]!.texts).toEqual([text]);
		expect((await vectorOf(s, "episode", "e1"))!.contentDigest).toBe(
			sha256Hex(text),
		);
		expect(await vectorOf(s, "knowledge", "e1")).toBeNull();
	});

	test("busy waits retryAfterMs and retries the same batch", async () => {
		const s = await ready();
		await addKnowledge(s.deps, "a");
		s.larm.onEmbed = (call) => {
			if (call <= 2) throw busy(1500);
		};
		const report = await embedMissing(s.deps, ARGS);
		expect(report).toMatchObject({ embedded: 1, failed: 0, busyWaits: 2 });
		expect(s.sleeps).toEqual([1500, 1500]);
		expect(s.larm.calls).toHaveLength(3);
	});

	test("busy gives up after 5 retries: the batch fails and the next one runs", async () => {
		const s = await ready();
		for (const id of ["a", "b", "c"]) await addKnowledge(s.deps, id);
		s.larm.onEmbed = (_call, texts) => {
			if (texts[0]!.includes("title a")) throw busy(10);
		};
		const report = await embedMissing(s.deps, ARGS);
		expect(report).toMatchObject({
			candidates: 3,
			embedded: 1,
			failed: 2,
			busyWaits: 5,
		});
		expect(s.sleeps).toEqual([10, 10, 10, 10, 10]);
		expect(s.larm.calls).toHaveLength(6 + 1);
		expect(await vectorOf(s, "knowledge", "a")).toBeNull();
		expect(await vectorOf(s, "knowledge", "c")).not.toBeNull();
	});

	for (const code of [
		"larm_provider_conflict",
		"larm_embedding_space_mismatch",
		"larm_not_configured",
		"larm_token_missing",
	] as const) {
		test(`${code} stops immediately and keeps earlier batches`, async () => {
			const s = await ready();
			for (const id of ["a", "b", "c"]) await addKnowledge(s.deps, id);
			s.larm.onEmbed = (call) => {
				if (call === 2) throw new LarmError(code);
			};
			await expect(embedMissing(s.deps, ARGS)).rejects.toThrow(code);
			expect(s.larm.calls).toHaveLength(2);
			expect(s.sleeps).toEqual([]);
			expect(await vectorOf(s, "knowledge", "a")).not.toBeNull();
			expect(await vectorOf(s, "knowledge", "c")).toBeNull();
		});
	}

	test("other failures count the batch as failed and continue", async () => {
		const s = await ready();
		for (const id of ["a", "b", "c"]) await addKnowledge(s.deps, id);
		s.larm.onEmbed = (call) => {
			if (call === 1) throw new LarmError("larm_unreachable");
		};
		const report = await embedMissing(s.deps, ARGS);
		expect(report).toMatchObject({ embedded: 1, failed: 2 });
	});

	test("a short response counts as a failed batch", async () => {
		const s = await ready();
		await addKnowledge(s.deps, "a");
		s.larm.embed = async () => [];
		const report = await embedMissing(s.deps, ARGS);
		expect(report).toMatchObject({ embedded: 0, failed: 1 });
	});

	test("3 failed batches in a row abort with embed_aborted and keep earlier saves", async () => {
		const s = await ready();
		for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"])
			await addKnowledge(s.deps, id);
		s.larm.onEmbed = (call) => {
			if (call >= 2) throw new LarmError("larm_unreachable");
		};
		const error = await embedMissing(s.deps, { ...ARGS, batchSize: 1 }).catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(EmbedAbortedError);
		expect(error.message).toBe(
			"embed_aborted: 3 consecutive batch failures (last: larm_unreachable)",
		);
		expect(error).toMatchObject({ embedded: 1, failed: 3 });
		expect(s.larm.calls).toHaveLength(4);
		expect(await vectorOf(s, "knowledge", "a")).not.toBeNull();
		expect(await vectorOf(s, "knowledge", "b")).toBeNull();
		expect(s.logs.some((l) => l.startsWith("stopped: 3 consecutive"))).toBe(
			true,
		);
	});

	test("a success resets the consecutive failure count", async () => {
		const s = await ready();
		for (const id of ["a", "b", "c", "d", "e", "f"])
			await addKnowledge(s.deps, id);
		// Calls 1,2 fail, 3 succeeds, 4,5 fail, 6 succeeds: never 3 in a row.
		s.larm.onEmbed = (call) => {
			if (call % 3 !== 0) throw new LarmError("larm_unreachable");
		};
		const report = await embedMissing(s.deps, { ...ARGS, batchSize: 1 });
		expect(report).toMatchObject({ embedded: 2, failed: 4 });
	});

	test("an unreachable LARM costs 3 calls, not one per batch", async () => {
		const s = await ready();
		for (let i = 0; i < 20; i++) await addKnowledge(s.deps, `k${i}`);
		s.larm.onEmbed = () => {
			throw new LarmError("larm_unreachable");
		};
		await expect(
			embedMissing(s.deps, { ...ARGS, batchSize: 1 }),
		).rejects.toThrow("embed_aborted");
		expect(s.larm.calls).toHaveLength(3);
	});

	test("busy waits stay: a batch that recovers after busy does not count as a failure", async () => {
		const s = await ready();
		for (const id of ["a", "b", "c"]) await addKnowledge(s.deps, id);
		s.larm.onEmbed = (call) => {
			if (call <= 2) throw busy(20);
		};
		const report = await embedMissing(s.deps, { ...ARGS, batchSize: 1 });
		expect(report).toMatchObject({ embedded: 3, failed: 0, busyWaits: 2 });
	});
});
