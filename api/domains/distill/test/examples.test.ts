import { afterEach, expect, test } from "bun:test";
import { DistillError } from "../contracts";
import {
	replaceEpisodeSources,
	setEpisodeRetrieval,
	upsertEpisode,
	type EpisodeInput,
} from "../../experience";
import {
	getKnowledgeById,
	replaceKnowledgeEvidence,
	upsertKnowledgeItem,
} from "../../knowledge";
import { edgesTo } from "../../map";
import type { HandlerDefinition } from "../../queue";
import { upsertSourceRecord } from "../../sources";
import { ensureVectorSpace, upsertVector } from "../../vectors";
import { createRun, getParam, getRun, listReviews } from "../repository";
import { createExamples } from "../service/examples";
import { pickCandidates } from "../service/examples/candidates";
import {
	atom,
	createTestDistill,
	messageText,
	T0,
	type TestDistill,
} from "./fixtures";

const ts: TestDistill[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});

type AnyHandler = HandlerDefinition<unknown, unknown, unknown>;
const pad = (i: number) => String(i).padStart(3, "0");
/** A small deterministic disturbance in [-0.5, 0.5). */
const noise = (i: number, d: number) => ((i * 31 + d * 17) % 13) / 13 - 0.5;
const unit = (v: number[]) => {
	const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return Float32Array.from(v.map((x) => x / n));
};
/** A point near the axis `group` of a `dim`-dimensional space. */
const near = (group: number, i: number, dim: number) =>
	unit(
		Array.from(
			{ length: dim },
			(_, d) => (d === group ? 1 : 0) + 0.08 * noise(i, d),
		),
	);

function setup() {
	const t = createTestDistill();
	ts.push(t);
	const handlers = new Map<string, AnyHandler>();
	const real = t.deps.queue;
	t.deps.queue = {
		...real,
		registerHandler<P, I, O>(h: HandlerDefinition<P, I, O>) {
			handlers.set(h.kind, h as unknown as AnyHandler);
			real.registerHandler(h);
		},
	};
	return { t, handlers };
}

async function space(t: TestDistill, dimension: number) {
	await t.deps.store.write((db) => {
		t.deps.spaceKey = ensureVectorSpace(
			db,
			{ model: { id: "m", revision: "r", artifactDigest: "d" }, dimension },
			T0,
		);
	});
}

/** Canonicals c000.. with a vector near the axis group(i). */
async function seedCanonicals(
	t: TestDistill,
	count: number,
	group: (i: number) => number,
	dim = 4,
	over: (i: number) => Parameters<typeof atom>[1] = () => ({}),
	from = 0,
) {
	await t.deps.store.write((db) => {
		for (let i = from; i < from + count; i++) {
			const id = `c${pad(i)}`;
			upsertKnowledgeItem(
				db,
				atom(id, {
					layer: "canonical",
					title: `title ${id}`,
					situation: `situation ${id}`,
					body: `guidance ${id}`,
					...over(i),
				}),
			);
			upsertVector(db, {
				ownerKind: "knowledge",
				ownerId: id,
				spaceKey: t.deps.spaceKey,
				contentDigest: getKnowledgeById(db, id)!.contentDigest,
				vector: near(group(i), i, dim),
				origin: "larm",
				verification: "verified",
				now: T0,
			});
		}
	});
}

/** Runs every queued job of the queue by hand, in order; the real runner is never started. */
async function drive(
	t: TestDistill,
	handlers: Map<string, AnyHandler>,
	options: { limit?: number } = {},
) {
	const done = new Set<string>();
	let runs = 0;
	for (;;) {
		const queued = [];
		let cursor: string | null = null;
		do {
			const page = t.deps.queue.list(
				{ scope: "distill", state: "queued" },
				cursor,
				100,
			);
			queued.push(...page.items.filter((j) => !done.has(j.id)));
			cursor = page.nextCursor;
		} while (cursor);
		if (queued.length === 0 || runs >= (options.limit ?? 10_000)) return runs;
		for (const dto of queued) {
			done.add(dto.id);
			runs++;
			const job = t.deps.queue.get(dto.id)!;
			const handler = handlers.get(job.kind)!;
			const claim = {
				jobId: job.id,
				scope: job.scope,
				kind: job.kind,
				payloadVersion: job.payloadVersion,
				payload: JSON.parse(job.payloadJson) as unknown,
				subjectRef: job.subjectRef,
				owner: "test",
				attempt: 1,
				generation: 0,
				maxAttempts: 3,
				deadlineAtMs: null,
			};
			const prepared = await t.deps.store.write((db) =>
				handler.prepareInTransaction(db, claim),
			);
			if (prepared.status === "stale") continue;
			let outcome:
				| { type: "success"; result: unknown }
				| { type: "failed"; errorCode: string };
			try {
				outcome = {
					type: "success",
					result: await handler.execute(prepared.input, {
						signal: new AbortController().signal,
						jobId: job.id,
						attempt: 1,
						generation: 0,
					}),
				};
			} catch (error) {
				outcome = { type: "failed", errorCode: (error as Error).message };
			}
			await t.deps.store.write((db) =>
				handler.settleInTransaction(db, claim, prepared.input, outcome),
			);
		}
	}
}

const startRun = async (t: TestDistill, id: string, stage = "theme") => {
	await t.deps.store.write((db) =>
		createRun(db, { id, stage: stage as "theme", params: {}, at: T0 }),
	);
	return id;
};

const episodeRow = (
	id: string,
	over: Partial<EpisodeInput> = {},
): EpisodeInput => ({
	id,
	title: `episode ${id}`,
	situation: `situation of ${id}`,
	intent: "",
	decision: "",
	observations: "",
	action: `action of ${id}`,
	outcome: `outcome of ${id}`,
	lesson: `lesson of ${id}`,
	openQuestions: [],
	outcomeKind: "success",
	eventStart: null,
	eventEnd: null,
	timePrecision: "unknown",
	confidence: 0.8,
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

/** Episode `id` with a vector near the axis `group`; `source` is its original record. */
async function seedEpisode(
	t: TestDistill,
	id: string,
	group: number | null,
	source: string | null = null,
	over: Partial<EpisodeInput> = {},
	i = 0,
) {
	await t.deps.store.write((db) => {
		upsertEpisode(db, episodeRow(id, over));
		if (source !== null)
			replaceEpisodeSources(db, id, [
				{ sourceId: source, locator: "", role: "derived_from" },
			]);
		if (group !== null)
			upsertVector(db, {
				ownerKind: "episode",
				ownerId: id,
				spaceKey: t.deps.spaceKey,
				contentDigest: "episode-digest",
				vector: near(group, i, 4),
				origin: "larm",
				verification: "verified",
				now: T0,
			});
	});
}

async function seedSource(t: TestDistill, id: string) {
	await t.deps.store.write((db) =>
		upsertSourceRecord(db, {
			id,
			kind: "document",
			uri: `file://${id}`,
			title: null,
			content: "x",
			space: "coding",
			scope: "repo",
			repoKey: "nightworkers",
			recordedAt: T0,
			metadata: {},
			createdAt: T0,
			updatedAt: T0,
		}),
	);
}

/** The canonical `canonicalId` was derived from an atom that came from `source`. */
async function deriveFrom(t: TestDistill, canonicalId: string, source: string) {
	await t.deps.store.write((db) => {
		upsertKnowledgeItem(
			db,
			atom(`atom-${canonicalId}`, { status: "superseded" }),
		);
		replaceKnowledgeEvidence(
			db,
			`atom-${canonicalId}`,
			"pipeline",
			[
				{
					targetKind: "source",
					targetId: source,
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
			],
			T0,
		);
		replaceKnowledgeEvidence(
			db,
			canonicalId,
			"pipeline",
			[
				{
					targetKind: "atom",
					targetId: `atom-${canonicalId}`,
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
			],
			T0,
		);
	});
}

const startExamples = async (t: TestDistill, id: string) =>
	startRun(t, id, "examples");

/** A clean answer citing the first two candidates. */
const goodAnswer = {
	schemaVersion: 1,
	examples: [
		{
			situation: "a service restarted while jobs were running",
			action: "the jobs were made safe to run again",
			outcome: "no job was lost",
			episodes: ["e1", "e2"],
		},
	],
};

test("candidates are the episodes of the same original record, then the nearest ones above the threshold", () => {
	const unit = (...v: number[]) => Float32Array.from(v);
	const matrix = {
		ids: ["e-a", "e-b", "e-c", "e-d", "e-e", "e-f"],
		vectors: [
			unit(1, 0), // 1.0
			unit(0.95, 0.312), // ~0.95
			unit(0.95, 0.312), // ~0.95, tie with e-b: by id
			unit(0.92, 0.39), // ~0.92
			unit(0.5, 0.866), // 0.5: below
			unit(0.97, 0.243), // ~0.97
		],
	};
	const found = pickCandidates({
		sameSource: ["e-e", "e-e", "e-z"],
		vector: unit(1, 0),
		matrix,
		threshold: 0.9,
	});
	expect(found.map((c) => [c.id, c.via])).toEqual([
		["e-e", "source"], // the same original record first, once, by id
		["e-z", "source"], // known by the data even without a vector
		["e-a", "vector"],
		["e-f", "vector"],
		["e-b", "vector"],
	]);
	expect(found[1]!.similarity).toBeNull();
	// Without the canonical's vector only the same-source episodes remain.
	expect(
		pickCandidates({
			sameSource: ["e-a"],
			vector: null,
			matrix,
			threshold: 0.9,
		}).map((c) => c.via),
	).toEqual(["source"]);
	// At most four from the source and three near ones.
	const crowd = pickCandidates({
		sameSource: ["s1", "s2", "s3", "s4", "s5"],
		vector: unit(1, 0),
		matrix,
		threshold: 0,
	});
	expect(crowd.filter((c) => c.via === "source")).toHaveLength(4);
	expect(crowd.filter((c) => c.via === "vector")).toHaveLength(3);
});

test("the stage stops when no episode has a vector", async () => {
	const { t } = setup();
	await space(t, 4);
	await seedCanonicals(t, 3, () => 0);
	await seedEpisode(t, "ep-1", null); // an episode, but no vector
	const module = createExamples(t.deps);
	module.registerHandlers();
	await expect(
		module.start("examples", await startExamples(t, "run_1"), {
			dryRun: false,
		}),
	).rejects.toMatchObject({ code: "distill_vectors_unverified" });
	await expect(
		module.start("theme" as never, "run_1", { dryRun: true }),
	).rejects.toBeInstanceOf(DistillError);
	// An unverified vector does not count either.
	await t.deps.store.write((db) =>
		upsertVector(db, {
			ownerKind: "episode",
			ownerId: "ep-1",
			spaceKey: t.deps.spaceKey,
			contentDigest: "d",
			vector: near(0, 0, 4),
			origin: "legacy_import",
			verification: "unverified",
			now: T0,
		}),
	);
	await expect(
		module.start("examples", "run_1", { dryRun: false }),
	).rejects.toMatchObject({ code: "distill_vectors_unverified" });
	expect(t.llm.calls).toHaveLength(0);
});

test("examples are generalised from the candidates, stored on the canonical and linked as candidates", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 2, (i) => i); // c000 on axis 0, c001 on axis 1
	await seedSource(t, "src-1");
	await deriveFrom(t, "c000", "src-1");
	await seedEpisode(t, "ep-source", null, "src-1"); // same original record, no vector
	await seedEpisode(t, "ep-near", 0, null, {}, 1);
	await seedEpisode(t, "ep-far", 2, null, {}, 2); // other direction: not a candidate
	await seedEpisode(t, "ep-other", 1, null, {}, 3); // near c001
	t.llm.when("title c000", goodAnswer);
	t.llm.when("title c001", { schemaVersion: 1, examples: [] });
	const module = createExamples(t.deps);
	module.registerHandlers();
	const runId = await startExamples(t, "run_1");
	expect(await module.start("examples", runId, { dryRun: false })).toBe(1);
	await drive(t, handlers);

	t.deps.store.read((db) => {
		const c0 = getKnowledgeById(db, "c000")!;
		expect(c0.examples).toEqual([
			{
				situation: "a service restarted while jobs were running",
				action: "the jobs were made safe to run again",
				outcome: "no job was lost",
				// e1 is the same-source episode, e2 the nearest.
				episodeIds: ["ep-source", "ep-near"],
			},
		]);
		expect(getKnowledgeById(db, "c001")!.examples).toEqual([]);
		const edges = edgesTo(db, "knowledge", "c000", "example_of");
		expect(edges.map((e) => [e.src.id, e.origin, e.status]).sort()).toEqual([
			["ep-near", "clustering", "candidate"],
			["ep-source", "deterministic", "candidate"],
		]);
		expect(edgesTo(db, "knowledge", "c001", "example_of")).toHaveLength(0);
		const run = getRun(db, runId)!;
		expect(run.state).toBe("completed");
		expect(run.counts).toMatchObject({ planned: 1, settled: 1, ok: 2 });
	});

	// The model saw the candidates under aliases e1.. and never an id.
	const call = t.llm.calls.find((c) => messageText(c).includes("title c000"))!;
	const text = messageText(call);
	expect(text).toContain("[e1] episode ep-source");
	expect(text).toContain("[e2] episode ep-near");
	expect(text).not.toContain("ep-far");
	expect(text).not.toContain("[e3]");
	// c001 has a candidate (ep-other) of its own.
	expect(
		messageText(
			t.llm.calls.find((c) => messageText(c).includes("title c001"))!,
		),
	).toContain("[e1] episode ep-other");
});

test("an example that names a repository, or cites a stranger, is corrected once and then sent to review", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 2, (i) => i);
	await seedEpisode(t, "ep-1", 0, null, {}, 1);
	await seedEpisode(t, "ep-2", 1, null, {}, 2);
	// A repo episode is never a candidate, but its repository is a term the examples may not name.
	await seedEpisode(t, "ep-repo", null, null, {
		scope: "repo",
		repoKey: "nightworkers",
	});
	const leaky = {
		schemaVersion: 1,
		examples: [
			{
				situation: "in nightworkers the job runner stopped",
				action: "edited src/jobs/runner.ts and set port 8080",
				outcome: "fine",
				episodes: ["e1"],
			},
		],
	};
	const stranger = {
		schemaVersion: 1,
		examples: [
			{ situation: "s", action: "a", outcome: "o", episodes: ["e1", "e5"] },
		],
	};
	t.llm.when("title c000", leaky);
	t.llm.when("title c001", stranger);
	const module = createExamples(t.deps);
	module.registerHandlers();
	await module.start("examples", await startExamples(t, "run_1"), {
		dryRun: false,
	});
	await drive(t, handlers);
	expect(t.llm.calls).toHaveLength(4); // two canonicals, one correction each
	t.deps.store.read((db) => {
		expect(getKnowledgeById(db, "c000")!.examples).toEqual([]);
		expect(getKnowledgeById(db, "c001")!.examples).toEqual([]);
		expect(edgesTo(db, "knowledge", "c000", "example_of")).toHaveLength(0);
		const reviews = listReviews(db, "open");
		expect(reviews).toHaveLength(2);
		const findings = reviews.flatMap(
			(r) => (r.subject as { findings: string[] }).findings,
		);
		expect(findings).toContain("examples[0].situation: repo_term nightworkers");
		expect(findings).toContain(
			"examples[0].action: relative_path src/jobs/runner.ts",
		);
		expect(findings).toContain("examples[0].action: port port 8080");
		expect(findings).toContain("examples[0].episodes: e5 is not a candidate");
		expect(getRun(db, "run_1")!.state).toBe("completed");
	});
});

test("a canonical without candidates costs no model call, and a rerun changes nothing", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 2, (i) => i);
	await seedEpisode(t, "ep-1", 0, null, {}, 1); // a vector exists, near c000 only
	t.llm.when("title c000", goodAnswer);
	const module = createExamples(t.deps);
	module.registerHandlers();
	await module.start("examples", await startExamples(t, "run_1"), {
		dryRun: false,
	});
	await drive(t, handlers);
	// Only c000 has a candidate; its answer cites e2, which does not exist: one correction.
	expect(t.llm.calls).toHaveLength(2);
	expect(t.llm.calls.every((c) => messageText(c).includes("title c000"))).toBe(
		true,
	);
	const first = t.deps.store.read((db) => getKnowledgeById(db, "c000")!);
	// Rejected, so no examples yet.
	expect(first.examples).toEqual([]);

	t.llm.when("title c000", {
		...goodAnswer,
		examples: [{ ...goodAnswer.examples[0]!, episodes: ["e1"] }],
	});
	// The earlier answer was not stored (invalid), a fresh request gets the new one.
	await seedEpisode(t, "ep-2", 0, null, {}, 2);
	await module.start("examples", await startExamples(t, "run_2"), {
		dryRun: false,
	});
	await drive(t, handlers);
	const second = t.deps.store.read((db) => getKnowledgeById(db, "c000")!);
	expect(second.examples).toHaveLength(1);
	expect(second.revision).toBe(first.revision + 1);

	// Same answer again: the model is not called (the stored answer is reused) and the row is untouched.
	const calls = t.llm.calls.length;
	await module.start("examples", await startExamples(t, "run_3"), {
		dryRun: false,
	});
	await drive(t, handlers);
	expect(t.llm.calls).toHaveLength(calls);
	expect(
		t.deps.store.read((db) => getKnowledgeById(db, "c000")!).revision,
	).toBe(second.revision);
});

test("a changed answer retracts the candidate link it no longer cites", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 1, () => 0);
	await seedEpisode(t, "ep-1", 0, null, {}, 1);
	await seedEpisode(t, "ep-2", 0, null, {}, 2);
	const cite = (alias: string) => ({
		schemaVersion: 1,
		examples: [
			{ situation: "s", action: "a", outcome: "o", episodes: [alias] },
		],
	});
	const module = createExamples(t.deps);
	module.registerHandlers();
	t.llm.fallback = cite("e1");
	await module.start("examples", await startExamples(t, "run_1"), {
		dryRun: false,
	});
	await drive(t, handlers);
	const first = t.deps.store.read(
		(db) => getKnowledgeById(db, "c000")!.examples[0]!.episodeIds[0]!,
	);
	const other = first === "ep-1" ? "ep-2" : "ep-1";
	// The prompt is the same, so the stored answer would be reused: change a lesson in it.
	t.llm.fallback = cite("e2");
	t.setNow("2026-10-31T00:00:00.000Z");
	await seedEpisode(t, "ep-1", 0, null, { lesson: "a different lesson" }, 1);
	await seedEpisode(t, "ep-2", 0, null, { lesson: "a different lesson" }, 2);
	await module.start("examples", await startExamples(t, "run_2"), {
		dryRun: false,
	});
	await drive(t, handlers);
	t.deps.store.read((db) => {
		const states = edgesTo(db, "knowledge", "c000", "example_of").map((e) => [
			e.src.id,
			e.status,
		]);
		expect(states.sort()).toEqual(
			[
				[first, "retracted"],
				[other, "candidate"],
			].sort(),
		);
		expect(getKnowledgeById(db, "c000")!.examples[0]!.episodeIds).toEqual([
			other,
		]);
	});
});

test("jobs are fed in a window: every canonical is handled though the queue holds fewer jobs", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 200, (i) => i % 4);
	await seedEpisode(t, "ep-1", 3, null, {}, 1); // far from the canonicals of axis 0..2? still one vector
	t.llm.fallback = { schemaVersion: 1, examples: [] };
	const module = createExamples(t.deps);
	module.registerHandlers();
	const runId = await startExamples(t, "run_1");
	expect(await module.start("examples", runId, { dryRun: false })).toBe(50); // 200 / 4
	const queued = () =>
		t.deps.queue.list({ scope: "distill", state: "queued" }, null, 100).items
			.length;
	expect(queued()).toBe(48);
	expect(await drive(t, handlers)).toBe(50);
	t.deps.store.read((db) => {
		const run = getRun(db, runId)!;
		expect(run.state).toBe("completed");
		expect(run.counts).toMatchObject({ planned: 50, settled: 50 });
	});
});

test("a dry run counts the jobs and limit caps them", async () => {
	const { t } = setup();
	await space(t, 4);
	await seedCanonicals(t, 9, () => 0);
	await seedEpisode(t, "ep-1", 0, null, {}, 1);
	const module = createExamples(t.deps);
	module.registerHandlers();
	expect(
		await module.start("examples", await startExamples(t, "run_1"), {
			dryRun: true,
		}),
	).toBe(3);
	expect(
		await module.start("examples", "run_1", { dryRun: true, limit: 2 }),
	).toBe(2);
	expect(t.deps.queue.list({ scope: "distill" }).items).toHaveLength(0);
});

test("only global, non-personal, searchable, active episodes are candidates and reach the prompt", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 1, () => 0);
	await seedSource(t, "src-1");
	await deriveFrom(t, "c000", "src-1");
	await seedEpisode(t, "ep-ok", 0, "src-1", { title: "episode ok" }, 1);
	const excluded: [string, Partial<EpisodeInput>][] = [
		["ep-repo", { scope: "repo", repoKey: "nightworkers" }],
		["ep-personal", { space: "personal" }],
		["ep-evidence", {}],
		["ep-stale", { status: "stale" }],
	];
	for (const [i, [id, over]] of excluded.entries()) {
		// Same original record and same direction as the canonical: only the filter keeps them out.
		await seedEpisode(
			t,
			id,
			0,
			"src-1",
			{ title: `episode ${id}`, ...over },
			2 + i,
		);
	}
	await t.deps.store.write((db) =>
		setEpisodeRetrieval(db, "ep-evidence", "evidence_only", T0),
	);
	// A direct link from the atom to an excluded episode is filtered the same way.
	await t.deps.store.write((db) =>
		replaceKnowledgeEvidence(
			db,
			"atom-c000",
			"pipeline",
			[
				{
					targetKind: "source",
					targetId: "src-1",
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
				{
					targetKind: "episode",
					targetId: "ep-personal",
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
			],
			T0,
		),
	);
	t.llm.fallback = { schemaVersion: 1, examples: [] };
	const module = createExamples(t.deps);
	module.registerHandlers();
	const runId = await startExamples(t, "run_1");
	await module.start("examples", runId, { dryRun: false });
	await drive(t, handlers);
	const text = t.llm.calls.map((c) => messageText(c)).join("\n");
	expect(text).toContain("episode ok");
	for (const [id] of excluded) expect(text).not.toContain(`episode ${id}`);
});

test("the stored items of a run are emptied when the run ends, completed or cancelled", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 200, (i) => i % 4); // 50 jobs: two beyond the window of 48
	await seedEpisode(t, "ep-1", 3, null, {}, 1);
	t.llm.fallback = { schemaVersion: 1, examples: [] };
	const module = createExamples(t.deps);
	module.registerHandlers();
	const tail = (runId: string) =>
		t.deps.store.read((db) =>
			[48, 49].map((seq) => getParam(db, `examples.work.${runId}.${seq}`)),
		);

	const done = await startExamples(t, "run_done");
	expect(await module.start("examples", done, { dryRun: false })).toBe(50);
	expect(tail(done).every((item) => item !== null)).toBe(true);
	await drive(t, handlers);
	expect(tail(done)).toEqual([null, null]);

	const cancelled = await startExamples(t, "run_cancelled");
	await module.start("examples", cancelled, { dryRun: false });
	expect(tail(cancelled).every((item) => item !== null)).toBe(true);
	const job = t.deps.queue
		.list({ scope: "distill", state: "queued" }, null, 5)
		.items.find(
			(j) =>
				JSON.parse(t.deps.queue.get(j.id)!.payloadJson).runId === cancelled,
		)!;
	const handler = handlers.get(job.kind)!;
	await t.deps.store.write((db) =>
		handler.cancelInTransaction(
			db,
			{
				jobId: job.id,
				subjectRef: job.subjectRef,
				payload: JSON.parse(t.deps.queue.get(job.id)!.payloadJson),
			},
			"test",
		),
	);
	expect(tail(cancelled)).toEqual([null, null]);
	expect(t.deps.store.read((db) => getRun(db, cancelled))!.state).toBe(
		"cancelled",
	);
});
