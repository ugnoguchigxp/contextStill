import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Space } from "../../../infrastructure/scope";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	migrations as distillMigrations,
	type PairVerdict,
} from "../../distill";
import { migrations as experienceMigrations } from "../../experience";
import {
	type KnowledgeInput,
	migrations as knowledgeMigrations,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
} from "../../knowledge";
import {
	finishImportRun,
	migrations as legacyMigrations,
	putImportMap,
	startImportRun,
} from "../../legacy";
import { migrations as mapMigrations, upsertEdge } from "../../map";
import type { SearchHit, SearchRequest, SearchService } from "../../search";
import { migrations as sourcesMigrations } from "../../sources";
import { runEvaluation } from "../index";
import { loadCandidates } from "../service/legacy-lexical";

const T = "2026-10-01T00:00:00.000Z";
const NOW = new Date("2026-10-30T01:02:03.000Z");
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (n: number) => `legacy:knowledge_items:${uuid(n)}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function item(n: number, over: Partial<KnowledgeInput> = {}): KnowledgeInput {
	return {
		id: uuid(n),
		layer: "atom",
		type: "rule",
		polarity: "positive",
		title: `item ${n}`,
		body: `body ${n}`,
		appliesWhen: [],
		notAppliesWhen: [],
		steps: [],
		facets: {},
		confidence: 0.8,
		importance: 0.7,
		status: "active",
		space: "coding" as Space,
		scope: "global",
		repoKey: null,
		validFrom: null,
		validUntil: null,
		provenanceStatus: "resolved",
		metadata: {},
		createdAt: T,
		updatedAt: T,
		...over,
	};
}
const canonical = (n: number, over: Partial<KnowledgeInput> = {}) =>
	item(n, { layer: "canonical", situation: `situation ${n}`, ...over });

function setup() {
	const t = tempStore([
		...sourcesMigrations,
		...experienceMigrations,
		...knowledgeMigrations,
		...legacyMigrations,
		...mapMigrations,
		...distillMigrations,
	]);
	const dir = mkdtempSync(join(tmpdir(), "context-still-eval-"));
	cleanups.push(t.dispose, () => rmSync(dir, { recursive: true, force: true }));
	return { store: t.store, dir };
}
type Store = ReturnType<typeof setup>["store"];

/** Rows, import map for the atoms in `mapped`, `supersedes` edges (src canonical -> dst). */
async function seed(
	store: Store,
	items: KnowledgeInput[],
	mapped: number[],
	supersedes: [number, number][] = [],
	after?: (db: Parameters<Parameters<Store["write"]>[0]>[0]) => void,
) {
	await store.write((db) => {
		startImportRun(db, {
			id: "run1",
			importerVersion: "legacy-import.v1",
			snapshotFingerprint: "fp",
			startedAt: T,
		});
		for (const row of items) upsertKnowledgeItem(db, row);
		for (const n of mapped)
			putImportMap(db, {
				legacyTable: "knowledge_items",
				legacyId: uuid(n),
				targetTable: "knowledge_items",
				targetId: uuid(n),
				legacyDigest: "d",
				importRunId: "run1",
				importedAt: T,
			});
		finishImportRun(db, "run1", "succeeded", {}, T);
		for (const [src, dst] of supersedes)
			upsertEdge(db, {
				src: { kind: "knowledge", id: uuid(src) },
				relation: "supersedes",
				dst: { kind: "knowledge", id: uuid(dst) },
				origin: "llm",
				status: "active",
				confidence: 0.9,
				evidence: {},
				extractorVersion: "test",
				at: T,
			});
		after?.(db);
	});
}

const dispose = (
	db: Parameters<Parameters<Store["write"]>[0]>[0],
	id: number,
	d: { status?: "superseded" | "retracted"; retrieval?: "evidence_only" },
) => setKnowledgeDisposition(db, uuid(id), { ...d, updatedAt: T });

function judgment(
	db: Parameters<Parameters<Store["write"]>[0]>[0],
	x: number,
	y: number,
	verdict: string,
	resolution = "none",
	digests?: [string, string],
) {
	const [a, b] = uuid(x) < uuid(y) ? [uuid(x), uuid(y)] : [uuid(y), uuid(x)];
	const digestOf = (id: string) =>
		db
			.query<{ content_digest: string }, [string]>(
				"SELECT content_digest FROM knowledge_items WHERE id = ?",
			)
			.get(id)!.content_digest;
	db.query(
		`INSERT INTO distill_pair_judgments
		 (a_id, b_id, a_digest, b_digest, verdict, resolution, detail_json, call_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, '{}', NULL, ?, ?)`,
	).run(
		a,
		b,
		digests?.[0] ?? digestOf(a),
		digests?.[1] ?? digestOf(b),
		verdict,
		resolution,
		T,
		T,
	);
}

function writeSet(dir: string, cases: unknown[]) {
	const path = join(dir, "set.jsonl");
	writeFileSync(path, `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`);
	return path;
}
const evalCase = (over: Record<string, unknown>) => ({
	spaces: ["coding"],
	kinds: ["knowledge"],
	labelSource: "agent-draft",
	style: "scenario",
	...over,
});

const handleOf = (store: Store, n: number) =>
	store.read(
		(db) =>
			db
				.query<{ handle: string }, [string]>(
					"SELECT handle FROM knowledge_items WHERE id = ?",
				)
				.get(uuid(n))!.handle,
	);

/** Returns `responder(req)` as ids of knowledge rows, in order. */
function fakeSearch(store: Store, responder: (req: SearchRequest) => number[]) {
	const requests: SearchRequest[] = [];
	const service: SearchService = {
		async search(req) {
			requests.push(req);
			return {
				hits: responder(req).map((n): SearchHit => ({
					kind: "knowledge",
					id: uuid(n),
					handle: handleOf(store, n),
					title: "",
					summary: "",
					type: null,
					polarity: null,
					status: "active",
					layer: null,
					situation: "",
					themes: [],
					space: "coding",
					confidence: 0.8,
					score: 1,
					lanes: [],
				})),
				degraded: [],
				lanesUsed: req.lanes ?? ["fts"],
				candidateCounts: { fts: 0, short: 0, vector: 0 },
			};
		},
	};
	return { service, requests };
}

const run = (
	store: Store,
	dir: string,
	search: SearchService,
	systems: ("legacy-lexical" | "v2-hybrid" | "v2-atom-baseline")[],
	cases: unknown[],
	judge = false,
	judgePairs?: (pairs: { a: string; b: string }[]) => Promise<PairVerdict[]>,
	k = 10,
) =>
	runEvaluation(
		{ store, search, now: () => NOW, log: () => {} },
		{
			setPath: writeSet(dir, cases),
			systems,
			lanes: ["fts"],
			k,
			outPath: join(dir, "r.json"),
			judge,
		},
		{ judgePairs },
	);

const verdict = (
	a: number,
	b: number,
	kind: PairVerdict["verdict"],
): PairVerdict => ({
	a: uuid(a),
	b: uuid(b),
	verdict: kind,
	aNotAppliesWhen: [],
	bNotAppliesWhen: [],
	note: "",
});

// ---- supersedes ---------------------------------------------------------------------------

test("a superseded atom stands for the active canonical that replaced it: several stages, the highest grade, evidence_only left out", async () => {
	const { store, dir } = setup();
	// atoms 1, 2 -> canonical 11 -> canonical 12 (active); atom 3 -> canonical 13 (active)
	// atom 4 is evidence_only and absorbed by nothing; atom 5 is a plain active atom
	await seed(
		store,
		[
			item(1),
			item(2),
			item(3),
			item(4),
			item(5),
			canonical(11),
			canonical(12),
			canonical(13),
		],
		[1, 2, 3, 4, 5],
		[
			[11, 1],
			[11, 2],
			[12, 11],
			[13, 3],
		],
		(db) => {
			for (const id of [1, 2, 3]) dispose(db, id, { status: "superseded" });
			dispose(db, 11, { status: "superseded" });
			dispose(db, 4, { retrieval: "evidence_only" });
		},
	);
	// atom 1 (grade 2) and atom 2 (grade 3) land on canonical 12: the grade is 3
	const search = fakeSearch(store, (req) =>
		req.layers ? [2, 1, 5] : [12, 13, 5],
	);
	const cases = [
		evalCase({
			id: "c1",
			query: "q",
			relevant: [
				{ ref: ref(1), grade: 2 },
				{ ref: ref(2), grade: 3 },
				{ ref: ref(3), grade: 2 },
				{ ref: ref(4), grade: 3 },
				{ ref: ref(5), grade: 1 },
			],
		}),
	];
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid", "v2-atom-baseline"],
		cases,
	);

	expect(report.unreachableRefs).toEqual([ref(4)]);
	expect(report.unresolvedRefs).toEqual([]);

	// v2-hybrid: {12: 3, 13: 2, 5: 1}, ranked [12, 13, 5] -> perfect
	expect(report.systems["v2-hybrid"].recallAtK).toBe(1);
	expect(report.systems["v2-hybrid"].mrrAtK).toBe(1);
	expect(report.systems["v2-hybrid"].ndcgAtK).toBeCloseTo(1, 12);
	// v2-atom-baseline: the same three claims on the atoms: {1, 2}: 3, {3}: 2, {5}: 1.
	// Ranked [2, 1, 5]: atom 1 repeats the claim atom 2 found
	const dcg = 7 / Math.log2(2) + 1 / Math.log2(4);
	const ideal = 7 / Math.log2(2) + 3 / Math.log2(3) + 1 / Math.log2(4);
	expect(report.systems["v2-atom-baseline"].recallAtK).toBe(2 / 3);
	expect(report.systems["v2-atom-baseline"].ndcgAtK).toBeCloseTo(
		dcg / ideal,
		12,
	);

	// the baseline asks for the atoms before distillation, the gate system for the default layers
	expect(search.requests[0]).toEqual({
		query: "q",
		kinds: ["knowledge"],
		spaces: ["coding"],
		lanes: ["fts"],
		limit: 10,
	});
	expect(search.requests[1]).toEqual({
		query: "q",
		kinds: ["knowledge"],
		spaces: ["coding"],
		lanes: ["fts"],
		limit: 10,
		layers: ["atom"],
		includeSuperseded: true,
	});
});

test("a canonical replaced by canonicals is followed three times and no further", async () => {
	const { store, dir } = setup();
	// atom 1 -> 11 -> 12 -> 13 -> 14 (active, three canonical stages after the first)
	// atom 2 -> 21 -> 22 -> 23 -> 24 -> 25 (active, one stage too many)
	await seed(
		store,
		[
			item(1),
			item(2),
			...[11, 12, 13, 14, 21, 22, 23, 24, 25].map((n) => canonical(n)),
		],
		[1, 2],
		[
			[11, 1],
			[12, 11],
			[13, 12],
			[14, 13],
			[21, 2],
			[22, 21],
			[23, 22],
			[24, 23],
			[25, 24],
		],
		(db) => {
			for (const id of [1, 2, 11, 12, 13, 21, 22, 23, 24])
				dispose(db, id, { status: "superseded" });
		},
	);
	const search = fakeSearch(store, () => [14]);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[
			evalCase({
				id: "c1",
				query: "q",
				relevant: [
					{ ref: ref(1), grade: 3 },
					{ ref: ref(2), grade: 3 },
				],
			}),
		],
	);
	expect(report.unreachableRefs).toEqual([ref(2)]);
	expect(report.systems["v2-hybrid"].recallAtK).toBe(1);
});

test("an edge that is not active, or a retracted canonical, does not carry the ref", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[item(1), item(2), canonical(11), canonical(12)],
		[1, 2],
		[
			[11, 1],
			[12, 2],
		],
		(db) => {
			dispose(db, 1, { status: "superseded" });
			dispose(db, 2, { status: "superseded" });
			dispose(db, 12, { status: "retracted" });
			db.query(
				"UPDATE map_edges SET status = 'retracted' WHERE src_id = ?",
			).run(uuid(11));
		},
	);
	const search = fakeSearch(store, () => []);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[
			evalCase({
				id: "c1",
				query: "q",
				relevant: [
					{ ref: ref(1), grade: 3 },
					{ ref: ref(2), grade: 3 },
				],
			}),
		],
	);
	expect(report.unreachableRefs).toEqual([ref(1), ref(2)]);
	expect(report.systems["v2-hybrid"].queries).toBe(0);
});

test("the legacy pool keeps superseded atoms, so it is the same before and after the re-distillation", async () => {
	const { store } = setup();
	await seed(
		store,
		[item(1), item(2), canonical(11)],
		[1, 2],
		[[11, 1]],
		(db) => {
			dispose(db, 1, { status: "superseded" });
			dispose(db, 2, { retrieval: "evidence_only" });
		},
	);
	const ids = store
		.read((db) => loadCandidates(db, ["coding"], ["knowledge"]))
		.map((c) => c.id)
		.sort();
	expect(ids).toEqual([uuid(1), uuid(2)]);
});

// ---- duplicates and conflicts -------------------------------------------------------------

/** Four canonicals (11..14), an atom (1) absorbed into 11, and the judged pairs below. */
async function seedPairs(store: Store) {
	await seed(
		store,
		[item(1), canonical(11), canonical(12), canonical(13), canonical(14)],
		[1],
		[[11, 1]],
		(db) => {
			dispose(db, 1, { status: "superseded" });
			judgment(db, 11, 12, "duplicate");
			judgment(db, 11, 13, "conflict", "none");
			judgment(db, 12, 13, "compatible");
			judgment(db, 11, 14, "unrelated");
			judgment(db, 12, 14, "unrelated");
			judgment(db, 13, 14, "conflict", "owner_pending");
		},
	);
}
const relevant11 = [{ ref: ref(1), grade: 3 }];

test("dupRate@k and conflictRate@k match a hand calculation", async () => {
	const { store, dir } = setup();
	await seedPairs(store);
	// q1 top: 11, 12 (duplicate of 11), 13 (conflict with 11, resolution none: search warns),
	// atom 1 (same claim as 11), 14 -> 2 of 5 repeat a higher hit
	// q2 top: 13, 14 (conflict that is owner_pending: search warns) -> 0 of 2
	// no conflict is silent: the table holds both, and the MCP warns about both
	const search = fakeSearch(store, (req) =>
		req.query === "q1" ? [11, 12, 13, 1, 14] : [13, 14],
	);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[
			evalCase({ id: "c1", query: "q1", relevant: relevant11 }),
			evalCase({ id: "c2", query: "q2", relevant: relevant11 }),
		],
	);
	expect(report.systems["v2-hybrid"].dupRateAtK).toBe(2 / 7);
	expect(report.systems["v2-hybrid"].conflictRateAtK).toBe(0);
	expect(report.byStyle.scenario["v2-hybrid"]?.dupRateAtK).toBe(2 / 7);
	// systems that did not run stay null
	expect(report.systems["legacy-lexical"].dupRateAtK).toBeNull();
	expect(report.systems["v2-atom-baseline"].conflictRateAtK).toBeNull();
});

test("without --judge a pair without a judgment gives null; atoms alone need none", async () => {
	const { store, dir } = setup();
	await seedPairs(store);
	await store.write((db) => {
		// 14 changed since the judgments were made: the stored ones are stale
		db.query(
			"UPDATE knowledge_items SET content_digest = 'changed' WHERE id = ?",
		).run(uuid(14));
	});
	const search = fakeSearch(store, (req) => (req.layers ? [1] : [11, 14]));
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid", "v2-atom-baseline"],
		[evalCase({ id: "c1", query: "q", relevant: relevant11 })],
	);
	expect(report.systems["v2-hybrid"].dupRateAtK).toBeNull();
	expect(report.systems["v2-hybrid"].conflictRateAtK).toBeNull();
	expect(report.systems["v2-atom-baseline"].dupRateAtK).toBe(0);
	expect(report.systems["v2-atom-baseline"].conflictRateAtK).toBe(0);
});

test("--judge judges the missing pairs through judgePairs and only those", async () => {
	const { store, dir } = setup();
	await seedPairs(store);
	await store.write((db) => {
		db.query(
			"UPDATE knowledge_items SET content_digest = 'changed' WHERE id = ?",
		).run(uuid(14));
	});
	const asked: { a: string; b: string }[][] = [];
	const search = fakeSearch(store, () => [11, 12, 14, 13]);
	// the answer names a pair in the other order and one extra pair nobody asked for
	const judgePairs = async (pairs: { a: string; b: string }[]) => {
		asked.push(pairs);
		return [
			verdict(14, 12, "duplicate"),
			verdict(11, 14, "conflict"),
			verdict(13, 14, "compatible"),
			verdict(11, 99, "conflict"),
		];
	};
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[evalCase({ id: "c1", query: "q", relevant: relevant11 })],
		true,
		judgePairs,
	);
	// 11-12, 11-13, 12-13 are judged in the table; the three pairs with 14 are not
	expect(asked).toHaveLength(1);
	expect(asked[0]!.map((p) => `${p.a}|${p.b}`).sort()).toEqual(
		[
			`${uuid(11)}|${uuid(14)}`,
			`${uuid(12)}|${uuid(14)}`,
			`${uuid(13)}|${uuid(14)}`,
		].sort(),
	);
	// top [11, 12, 14, 13]: 12 repeats 11 (table), 14 repeats 12 (judged duplicate), 13 none
	expect(report.systems["v2-hybrid"].dupRateAtK).toBe(2 / 4);
	// 11 and 13 conflict in the table but the MCP warns about it; 11-14 conflicts (judged now)
	expect(report.systems["v2-hybrid"].conflictRateAtK).toBe(1);
});

test("--judge with a pair judgePairs does not answer leaves the rates null", async () => {
	const { store, dir } = setup();
	await seedPairs(store);
	await store.write((db) => {
		db.query(
			"UPDATE knowledge_items SET content_digest = 'changed' WHERE id = ?",
		).run(uuid(14));
	});
	const search = fakeSearch(store, () => [11, 14]);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[evalCase({ id: "c1", query: "q", relevant: relevant11 })],
		true,
		async () => [],
	);
	expect(report.systems["v2-hybrid"].dupRateAtK).toBeNull();
});

test("--judge asks nothing when every pair already has a judgment", async () => {
	const { store, dir } = setup();
	await seedPairs(store);
	let calls = 0;
	const search = fakeSearch(store, () => [11, 12, 13, 14]);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[evalCase({ id: "c1", query: "q", relevant: relevant11 })],
		true,
		async () => {
			calls += 1;
			return [];
		},
	);
	expect(calls).toBe(0);
	expect(report.systems["v2-hybrid"].dupRateAtK).toBe(1 / 4);
});

test("--judge without a judgePairs fails before any work", async () => {
	const { store, dir } = setup();
	await seedPairs(store);
	const search = fakeSearch(store, () => [11]);
	await expect(
		run(store, dir, search.service, ["v2-hybrid"], [], true),
	).rejects.toThrow("eval_judge_unavailable");
	expect(search.requests).toEqual([]);
});

// ---- review fixes (R3-1, R3-2, R3-4, R3-8) -----------------------------------------------

test("a conflict the MCP warns about, or that is settled with both rows active, is not a silent conflict", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[11, 12, 13, 14, 15, 16, 17, 18].map((n) => canonical(n)),
		[11, 13, 15, 17],
		[],
		(db) => {
			judgment(db, 11, 12, "conflict", "owner_resolved"); // settled, both active: compatible
			judgment(db, 13, 14, "conflict", "a_wins"); // settled
			judgment(db, 15, 16, "unknown", "none"); // the MCP warns
			judgment(db, 17, 18, "conflict", "none"); // the MCP warns
		},
	);
	const search = fakeSearch(store, (req) => [
		Number(req.query),
		Number(req.query) + 1,
	]);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[11, 13, 15, 17].map((n) =>
			evalCase({
				id: `c${n}`,
				query: String(n),
				relevant: [{ ref: ref(n), grade: 3 }],
			}),
		),
	);
	expect(report.systems["v2-hybrid"].conflictRateAtK).toBe(0);
});

test("a conflict judged in this run (not in the table yet) is a silent conflict", async () => {
	const { store, dir } = setup();
	await seed(store, [canonical(11), canonical(12)], [11], [], (db) => {
		judgment(db, 11, 12, "conflict", "owner_resolved", ["old", "old"]); // stale digests
	});
	const search = fakeSearch(store, () => [11, 12]);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid"],
		[
			evalCase({
				id: "c1",
				query: "q",
				relevant: [{ ref: ref(11), grade: 3 }],
			}),
		],
		true,
		async () => [verdict(11, 12, "conflict")],
	);
	expect(report.systems["v2-hybrid"].conflictRateAtK).toBe(1);
});

test("atoms absorbed into one canonical are one claim for the baseline too: recall and nDCG share one population", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[item(1), item(2), item(3), canonical(11)],
		[1, 2, 3],
		[
			[11, 1],
			[11, 2],
			[11, 3],
		],
		(db) => {
			for (const id of [1, 2, 3]) dispose(db, id, { status: "superseded" });
		},
	);
	// the gate system finds the canonical once; the baseline finds one atom of the claim once
	const search = fakeSearch(store, (req) => (req.layers ? [2, 1] : [11]));
	const report = await run(
		store,
		dir,
		search.service,
		["v2-hybrid", "v2-atom-baseline"],
		[
			evalCase({
				id: "c1",
				query: "q",
				relevant: [
					{ ref: ref(1), grade: 1 },
					{ ref: ref(2), grade: 3 },
					{ ref: ref(3), grade: 2 },
				],
			}),
		],
	);
	for (const system of ["v2-hybrid", "v2-atom-baseline"] as const) {
		expect(report.systems[system].recallAtK).toBe(1);
		expect(report.systems[system].mrrAtK).toBe(1);
		expect(report.systems[system].ndcgAtK).toBeCloseTo(1, 12);
	}
});

test("a baseline hit on a second atom of a found claim adds nothing", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[item(1), item(2), item(5), canonical(11)],
		[1, 2, 5],
		[
			[11, 1],
			[11, 2],
		],
		(db) => {
			for (const id of [1, 2]) dispose(db, id, { status: "superseded" });
		},
	);
	const search = fakeSearch(store, () => [1, 2, 5]);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-atom-baseline"],
		[
			evalCase({
				id: "c1",
				query: "q",
				relevant: [
					{ ref: ref(1), grade: 2 },
					{ ref: ref(2), grade: 3 },
					{ ref: ref(5), grade: 3 },
				],
			}),
		],
	);
	// claims {1, 2}: grade 3, {5}: grade 3; found at ranks 1 and 3 (atom 2 repeats the first)
	const dcg = 7 / Math.log2(2) + 7 / Math.log2(4);
	const ideal = 7 / Math.log2(2) + 7 / Math.log2(3);
	expect(report.systems["v2-atom-baseline"].recallAtK).toBe(1);
	expect(report.systems["v2-atom-baseline"].ndcgAtK).toBeCloseTo(
		dcg / ideal,
		12,
	);
});

test("an atom absorbed into several canonicals does not make the hits that share one of them a duplicate", async () => {
	const { store, dir } = setup();
	// atom 1 is in both canonicals 11 and 12; atom 2 only in 12
	await seed(
		store,
		[item(1), item(2), canonical(11), canonical(12)],
		[1],
		[
			[11, 1],
			[12, 1],
			[12, 2],
		],
		(db) => {
			for (const id of [1, 2]) dispose(db, id, { status: "superseded" });
		},
	);
	const relevant = [{ ref: ref(1), grade: 3 }];
	const search = fakeSearch(store, (req) =>
		req.query === "unrelated" ? [2, 1] : [1, 11],
	);
	const report = await run(
		store,
		dir,
		search.service,
		["v2-atom-baseline"],
		[
			evalCase({ id: "c1", query: "unrelated", relevant }),
			evalCase({ id: "c2", query: "own", relevant }),
		],
	);
	// [2, 1]: atom 1 only shares canonical 12 with atom 2: not a repeat; [1, 11]: 11 absorbed atom 1
	expect(report.systems["v2-atom-baseline"].dupRateAtK).toBe(1 / 4);
});

test("a run with v2-atom-baseline says its dupRate is measured after re-distillation", async () => {
	const { store, dir } = setup();
	await seed(store, [item(1)], [1]);
	const search = fakeSearch(store, () => [1]);
	const logs: string[] = [];
	await runEvaluation(
		{ store, search: search.service, now: () => NOW, log: (m) => logs.push(m) },
		{
			setPath: writeSet(dir, [
				evalCase({
					id: "c1",
					query: "q",
					relevant: [{ ref: ref(1), grade: 3 }],
				}),
			]),
			systems: ["v2-atom-baseline"],
			lanes: ["fts"],
			k: 10,
			outPath: join(dir, "r.json"),
			judge: false,
		},
	);
	expect(logs.some((line) => line.includes("after"))).toBe(true);
});
