import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import {
	getEpisodeById,
	upsertEpisode,
	type EpisodeInput,
} from "../../experience";
import { getKnowledgeById } from "../../knowledge";
import { LarmError, type ChatRequest } from "../../larm";
import { getCluster, memberDigest, memberKey, upsertCluster } from "../../map";
import type { Generality } from "../contracts";
import {
	createRun,
	getAssessment,
	getRun,
	listAssessments,
	upsertAssessment,
} from "../repository";
import { ASSESS_PROMPT_VERSION, createAssess } from "../service/assess";
import { atom, createTestDistill, seedAtoms, T0 } from "./fixtures";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});
const setup = () => {
	const t = createTestDistill();
	ts.push(t);
	return t;
};

/** The notes of an assess request, as the model sees them. */
function promptItems(req: ChatRequest) {
	const user = req.messages[1]!.content;
	return (
		JSON.parse(user.slice(user.indexOf("\n") + 1)) as {
			items: { ref: string; title: string; hints: Record<string, unknown> }[];
		}
	).items;
}

/** Answers by the title: SPECIFIC, UNUSABLE, GENERALIZABLE, otherwise general. */
function verdictOf(title: string): Generality {
	if (title.includes("SPECIFIC")) return "repo_specific";
	if (title.includes("UNUSABLE")) return "unusable";
	if (title.includes("GENERALIZABLE")) return "generalizable";
	return "general";
}
function answerByTitle(req: ChatRequest) {
	return {
		schemaVersion: 1,
		items: promptItems(req).map((i) => ({
			ref: i.ref,
			generality: verdictOf(i.title),
			reason: `reason ${i.ref}`,
		})),
	};
}

async function runStage(
	t: ReturnType<typeof createTestDistill>,
	module: { start: (...a: never[]) => unknown },
	stage: "assess" | "incremental",
	opts: { limit?: number; dryRun?: boolean } = {},
) {
	const runId = `run_${Math.random().toString(36).slice(2)}`;
	await t.deps.store.write((db) =>
		createRun(db, { id: runId, stage, params: { ...opts }, at: T0 }),
	);
	const enqueued = await (
		module as unknown as {
			start: (s: string, r: string, o: object) => Promise<number>;
		}
	).start(stage, runId, { dryRun: false, ...opts });
	if (enqueued > 0 && !opts.dryRun)
		await waitFor(
			async () => {
				await t.deps.queue.tick();
				return (
					t.deps.store.read((db) => getRun(db, runId))!.state !== "running"
				);
			},
			{ timeout: 10_000 },
		);
	return {
		runId,
		enqueued,
		run: t.deps.store.read((db) => getRun(db, runId))!,
	};
}

const episode = (
	id: string,
	over: Partial<EpisodeInput> = {},
): EpisodeInput => ({
	id,
	title: `episode ${id}`,
	situation: "s",
	intent: "",
	decision: "",
	observations: "",
	action: "a",
	outcome: "o",
	lesson: "l",
	openQuestions: [],
	outcomeKind: "success",
	eventStart: null,
	eventEnd: null,
	timePrecision: "unknown",
	confidence: 0.5,
	importance: 0.5,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	facets: {},
	metadata: {},
	createdAt: T0,
	updatedAt: T0,
	...over,
});
const assessOf = (t: ReturnType<typeof createTestDistill>, id: string) =>
	t.deps.store.read((db) => getAssessment(db, "knowledge", id));
const retrievalOf = (t: ReturnType<typeof createTestDistill>, id: string) =>
	t.deps.store.read((db) => getKnowledgeById(db, id))!.retrieval;

test("signals are extracted, the verdict is the model's, repo_specific and unusable become evidence_only", async () => {
	const t = setup();
	await seedAtoms(t.deps, [
		atom("k1", { title: "plain lesson", body: "Pin the lockfile in CI." }),
		atom("k2", {
			title: "SPECIFIC port",
			body: "The nightworkers API listens on localhost:4100.",
			scope: "repo",
			repoKey: "nightworkers",
		}),
		atom("k3", { title: "UNUSABLE note", body: "did stuff" }),
		atom("k4", {
			title: "GENERALIZABLE lesson",
			body: "Run the tests first.",
			metadata: { legacy: { scope: "repo", classificationStatus: "auto" } },
		}),
	]);
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	const { run } = await runStage(t, assess, "assess");
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({
		processed: 4,
		general: 1,
		generalizable: 1,
		repo_specific: 1,
		unusable: 1,
		evidenceOnly: 2,
	});
	expect(assessOf(t, "k1")).toMatchObject({
		generality: "general",
		origin: "llm",
		promptVersion: ASSESS_PROMPT_VERSION,
		reason: "reason a1",
	});
	expect(assessOf(t, "k2")?.generality).toBe("repo_specific");
	expect(assessOf(t, "k2")?.signals).toMatchObject({
		repoTerms: ["nightworkers"],
		ports: ["localhost:4100"],
		scope: "repo",
		repoKey: "nightworkers",
	});
	expect(assessOf(t, "k4")?.signals).toMatchObject({
		legacy: { scope: "repo", classificationStatus: "auto" },
	});
	expect(retrievalOf(t, "k1")).toBe("searchable");
	expect(retrievalOf(t, "k2")).toBe("evidence_only");
	expect(retrievalOf(t, "k3")).toBe("evidence_only");
	expect(retrievalOf(t, "k4")).toBe("searchable");
	// The model is told the mechanical findings as hints, and never an id.
	const first = promptItems(t.llm.calls[0]!);
	expect(first.map((i) => i.ref)).toEqual(["a1", "a2", "a3", "a4"]);
	expect(JSON.stringify(t.llm.calls[0]!.messages)).not.toContain("k1");
	expect(first[1]!.hints).toMatchObject({
		repoTerms: ["nightworkers"],
		ports: 1,
		legacyScope: "repo",
	});
});

test("a general verdict with a path or a port in the text is lowered to generalizable", async () => {
	const t = setup();
	await seedAtoms(t.deps, [
		atom("k1", {
			title: "path",
			body: "Edit /Users/me/work/app/src/a.ts first.",
		}),
		atom("k2", { title: "relative", body: "Look at src/queue/runner.ts." }),
		atom("k3", { title: "port", body: "Open localhost:3000 in the browser." }),
		atom("k4", { title: "clean", body: "Write a test first." }),
	]);
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	const { run } = await runStage(t, assess, "assess");
	for (const id of ["k1", "k2", "k3"]) {
		expect(assessOf(t, id)?.generality).toBe("generalizable");
		expect(assessOf(t, id)?.signals).toMatchObject({ downgraded: true });
	}
	expect(assessOf(t, "k4")?.generality).toBe("general");
	expect(assessOf(t, "k4")?.signals.downgraded).toBeUndefined();
	expect(run.counts).toMatchObject({
		general: 1,
		generalizable: 3,
		downgraded: 3,
	});
	expect(retrievalOf(t, "k1")).toBe("searchable");
});

test("episodes: only the global ones are assessed", async () => {
	const t = setup();
	await t.deps.store.write((db) => {
		upsertEpisode(db, episode("e-global"));
		upsertEpisode(db, episode("e-specific", { title: "SPECIFIC thing" }));
		upsertEpisode(db, episode("e-repo", { scope: "repo", repoKey: "app" }));
		upsertEpisode(db, episode("e-stale", { status: "stale" }));
	});
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	const { run } = await runStage(t, assess, "assess");
	expect(run.counts).toMatchObject({ processed: 2, evidenceOnly: 1 });
	const rows = t.deps.store.read((db) => listAssessments(db));
	expect(rows.map((r) => [r.ownerKind, r.ownerId, r.generality])).toEqual([
		["episode", "e-global", "general"],
		["episode", "e-specific", "repo_specific"],
	]);
	const get = (id: string) =>
		t.deps.store.read((db) => getEpisodeById(db, id))!;
	expect(get("e-specific").retrieval).toBe("evidence_only");
	expect(get("e-global").retrieval).toBe("searchable");
	expect(get("e-repo").retrieval).toBe("searchable");
	// Episode refs are e1..eN.
	expect(promptItems(t.llm.calls[0]!).map((i) => i.ref)).toEqual(["e1", "e2"]);
});

test("a second run assesses nothing; a changed text, a new prompt version and a human verdict", async () => {
	const t = setup();
	await seedAtoms(t.deps, [
		atom("k1", { title: "one", body: "b1" }),
		atom("k2", { title: "two", body: "b2" }),
		atom("k3", { title: "three", body: "b3" }),
	]);
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	await runStage(t, assess, "assess");
	expect(t.llm.calls).toHaveLength(1);

	const again = await runStage(t, assess, "assess");
	expect(again.enqueued).toBe(0);
	expect(t.llm.calls).toHaveLength(1);

	// k1's text changes: only it is assessed again, and now it is repo specific.
	await seedAtoms(t.deps, [
		atom("k1", { title: "SPECIFIC one", body: "b1 changed" }),
	]);
	const changed = await runStage(t, assess, "assess");
	expect(changed.run.counts.processed).toBe(1);
	expect(assessOf(t, "k1")?.generality).toBe("repo_specific");
	expect(retrievalOf(t, "k1")).toBe("evidence_only");

	// It becomes general again: the stage gives back the retrieval it took.
	await seedAtoms(t.deps, [
		atom("k1", { title: "one again", body: "b1 again" }),
	]);
	await runStage(t, assess, "assess");
	expect(assessOf(t, "k1")?.generality).toBe("general");
	expect(retrievalOf(t, "k1")).toBe("searchable");

	// A human verdict for the current text is kept even when the prompt version moves on.
	const k2 = assessOf(t, "k2")!;
	await t.deps.store.write((db) => {
		upsertAssessment(db, {
			...k2,
			generality: "unusable",
			origin: "human",
			promptVersion: "assess.v0",
			at: T0,
		});
		const k3 = getAssessment(db, "knowledge", "k3")!;
		upsertAssessment(db, { ...k3, promptVersion: "assess.v0", at: T0 });
	});
	const versioned = await runStage(t, assess, "assess");
	expect(versioned.run.counts.processed).toBe(1);
	expect(assessOf(t, "k2")).toMatchObject({
		generality: "unusable",
		origin: "human",
	});
	expect(assessOf(t, "k3")?.promptVersion).toBe(ASSESS_PROMPT_VERSION);
});

test("the work is a chain of 20 item jobs; limit caps the rows; a dry run enqueues nothing", async () => {
	const t = setup();
	await seedAtoms(
		t.deps,
		Array.from({ length: 45 }, (_, i) =>
			atom(`k${String(i).padStart(2, "0")}`, { title: `note ${i}` }),
		),
	);
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();

	const dry = await runStage(t, assess, "assess", { dryRun: true });
	expect(dry.enqueued).toBe(3);
	expect(t.llm.calls).toHaveLength(0);
	expect(t.deps.queue.stats().openJobs).toBe(0);

	const limited = await runStage(t, assess, "assess", { limit: 25 });
	expect(limited.enqueued).toBe(1);
	expect(limited.run.state).toBe("completed");
	expect(limited.run.counts.processed).toBe(25);
	expect(t.llm.calls.map((c) => promptItems(c).length)).toEqual([20, 5]);

	const rest = await runStage(t, assess, "assess");
	expect(rest.run.counts.processed).toBe(20);
	expect(t.deps.store.read((db) => listAssessments(db))).toHaveLength(45);
});

test("an unusable answer leaves the rows unassessed; missing refs are counted", async () => {
	const t = setup();
	await seedAtoms(t.deps, [atom("k1"), atom("k2")]);
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	t.llm.fallback = "not json at all";
	const bad = await runStage(t, assess, "assess");
	expect(bad.run.state).toBe("completed");
	expect(bad.run.counts).toMatchObject({ processed: 2, invalid: 2 });
	expect(t.deps.store.read((db) => listAssessments(db))).toEqual([]);

	t.llm.fallback = (req: ChatRequest) => ({
		schemaVersion: 1,
		items: [
			{ ref: promptItems(req)[0]!.ref, generality: "general", reason: "ok" },
			{ ref: "a9", generality: "general", reason: "no such ref" },
		],
	});
	const partial = await runStage(t, assess, "assess");
	expect(partial.run.counts).toMatchObject({
		processed: 2,
		general: 1,
		missing: 1,
	});
	expect(assessOf(t, "k1")?.generality).toBe("general");
	expect(assessOf(t, "k2")).toBeNull();
});

test("a provider that cannot serve fails the run", async () => {
	const t = setup();
	await seedAtoms(t.deps, [atom("k1")]);
	t.llm.fallback = new LarmError("larm_provider_conflict");
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	const { run } = await runStage(t, assess, "assess");
	expect(run.state).toBe("failed");
	expect(t.deps.store.read((db) => listAssessments(db))).toEqual([]);
});

test("personal rows are not assessed, atoms or episodes", async () => {
	const t = setup();
	await seedAtoms(t.deps, [
		atom("k-ok"),
		atom("k-personal", { space: "personal" }),
	]);
	await t.deps.store.write((db) => {
		upsertEpisode(db, episode("e-ok"));
		upsertEpisode(db, episode("e-personal", { space: "personal" }));
	});
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	const { run } = await runStage(t, assess, "assess");
	expect(run.counts).toMatchObject({ processed: 2 });
	expect(
		t.deps.store
			.read((db) => listAssessments(db))
			.map((r) => [r.ownerKind, r.ownerId]),
	).toEqual([
		["episode", "e-ok"],
		["knowledge", "k-ok"],
	]);
	const sent = t.llm.calls.map((c) => c.messages[1]!.content).join("\n");
	expect(sent).not.toContain("k-personal");
	expect(sent).not.toContain("e-personal");
});

test("a superseded atom whose text changed is assessed again and its distilled cluster goes pending", async () => {
	const t = setup();
	await seedAtoms(t.deps, [
		atom("k1", { title: "one", body: "b1" }),
		atom("k2", { title: "two", body: "b2" }),
	]);
	t.llm.fallback = answerByTitle;
	const assess = createAssess(t.deps);
	assess.registerHandlers();
	await runStage(t, assess, "assess");
	// k1 was absorbed into a canonical; its claim cluster was distilled.
	await t.deps.store.write((db) => {
		const digests = new Map(
			["k1", "k2"].map((id) => [
				memberKey("knowledge", id),
				getKnowledgeById(db, id)!.contentDigest,
			]),
		);
		const members = ["k1", "k2"].map((id) => ({
			kind: "knowledge" as const,
			id,
			role: "member" as const,
			similarity: 0.99,
		}));
		upsertCluster(db, {
			id: "cl_x",
			kind: "claim",
			parentId: null,
			level: 0,
			name: "x",
			aliases: [],
			description: "",
			summary: {},
			state: "distilled",
			algorithm: "avglink.v1|t=0.950|cap=12|e=0.930",
			memberDigest: memberDigest(members, digests),
			members,
			createdAt: T0,
			updatedAt: T0,
		});
	});
	await seedAtoms(t.deps, [
		atom("k1", { title: "one", body: "b1", status: "superseded" }),
	]);
	const untouched = await runStage(t, assess, "assess");
	expect(untouched.enqueued).toBe(0); // same text: nothing to do
	const before = t.deps.store.read((db) => getCluster(db, "cl_x"))!;
	expect(before.state).toBe("distilled");

	await seedAtoms(t.deps, [
		atom("k1", { title: "one", body: "b1 rewritten", status: "superseded" }),
	]);
	const { run } = await runStage(t, assess, "assess");
	expect(run.counts).toMatchObject({ processed: 1, reopened: 1 });
	expect(assessOf(t, "k1")?.contentDigest).toBe(
		t.deps.store.read((db) => getKnowledgeById(db, "k1"))!.contentDigest,
	);
	const after = t.deps.store.read((db) => getCluster(db, "cl_x"))!;
	expect(after.state).toBe("pending");
	expect(after.memberDigest).not.toBe(before.memberDigest);
	// the superseded atom keeps its retrieval; an unassessed superseded atom is never judged
	await seedAtoms(t.deps, [atom("k9", { status: "superseded" })]);
	expect((await runStage(t, assess, "assess")).enqueued).toBe(0);
});
