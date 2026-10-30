import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import type { Space } from "../../../infrastructure/scope";
import {
	migrations as experienceMigrations,
	upsertEpisode,
} from "../../experience";
import {
	type KnowledgeInput,
	migrations as knowledgeMigrations,
	upsertKnowledgeItem,
} from "../../knowledge";
import {
	finishImportRun,
	migrations as legacyMigrations,
	putImportMap,
	startImportRun,
} from "../../legacy";
import type { SearchHit, SearchRequest, SearchService } from "../../search";
import { migrations as sourcesMigrations } from "../../sources";
import { migrations as mapMigrations } from "../../map";
import { migrations as distillMigrations } from "../../distill";
import { type EvalReport, runEvaluation } from "../index";
import { rankLegacy, loadCandidates } from "../service/legacy-lexical";

const T = "2026-10-01T00:00:00.000Z";
const NOW = new Date("2026-10-30T01:02:03.000Z");
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const knRef = (n: number) => `legacy:knowledge_items:${uuid(n)}`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function knowledge(
	n: number,
	over: Partial<KnowledgeInput> = {},
): KnowledgeInput {
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
		// A canonical states a situation (5.3); one that no query matches.
		...(over.layer === "canonical" ? { situation: "◇◇◇" } : {}),
		...over,
	};
}

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

async function seed(
	store: ReturnType<typeof setup>["store"],
	items: KnowledgeInput[],
	mapped: number[],
	episodes: { id: number; legacy: number }[] = [],
) {
	await store.write((db) => {
		startImportRun(db, {
			id: "run1",
			importerVersion: "legacy-import.v1",
			snapshotFingerprint: "fp",
			startedAt: T,
		});
		for (const item of items) upsertKnowledgeItem(db, item);
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
		for (const e of episodes) {
			upsertEpisode(db, {
				id: uuid(e.id),
				title: "migration notes",
				situation: "database migration went wrong",
				intent: "",
				decision: "",
				observations: "",
				action: "",
				outcome: "",
				lesson: "back up first",
				openQuestions: [],
				outcomeKind: "success",
				eventStart: null,
				eventEnd: null,
				timePrecision: "unknown",
				confidence: 0.8,
				importance: 0.7,
				status: "active",
				space: "coding",
				scope: "global",
				repoKey: null,
				facets: {},
				metadata: {},
				createdAt: T,
				updatedAt: T,
			});
			putImportMap(db, {
				legacyTable: "episode_cards",
				legacyId: uuid(e.legacy),
				targetTable: "episodes",
				targetId: uuid(e.id),
				legacyDigest: "d",
				importRunId: "run1",
				importedAt: T,
			});
		}
		finishImportRun(db, "run1", "succeeded", {}, T);
	});
}

function evalCase(over: Record<string, unknown>) {
	return {
		spaces: ["coding"],
		kinds: ["knowledge"],
		labelSource: "agent-draft",
		style: "keyword",
		...over,
	};
}

function writeSet(dir: string, cases: unknown[]) {
	const path = join(dir, "set.jsonl");
	writeFileSync(path, `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`);
	return path;
}

function fakeSearch(
	responder: (
		req: SearchRequest,
	) => Pick<SearchHit, "kind" | "id" | "handle">[],
) {
	const requests: SearchRequest[] = [];
	const service: SearchService = {
		async search(req) {
			requests.push(req);
			return {
				hits: responder(req).map((h) => ({
					...h,
					title: "",
					summary: "",
					type: null,
					polarity: null,
					status: "active",
					layer: null,
					situation: "",
					themes: [],
					space: "coding" as Space,
					confidence: 0.8,
					score: 1,
					lanes: [],
				})),
				degraded: [],
				lanesUsed: req.lanes ?? ["fts", "short", "vector"],
				candidateCounts: { fts: 0, short: 0, vector: 0 },
			};
		},
	};
	return { service, requests };
}

const handleOf = (store: ReturnType<typeof setup>["store"], n: number) =>
	store.read(
		(db) =>
			db
				.query<{ handle: string }, [string]>(
					"SELECT handle FROM knowledge_items WHERE id = ?",
				)
				.get(uuid(n))!.handle,
	);

test("runEvaluation: report shape, both systems, unresolved refs, written file", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[
			knowledge(1, {
				title: "データベース移行の前にバックアップを取る",
				body: "本番の移行前に必ず退避する",
			}),
			knowledge(2, { title: "UIのボタン文言を変更する", body: "表示を直す" }),
			knowledge(3, {
				title: "別件のメモ",
				body: "x",
				metadata: { legacy: { dynamicScore: 2.4 } },
			}),
			knowledge(4, {
				title: "データベース移行の注意",
				body: "y",
				metadata: { legacy: { dynamicScore: -100 } },
			}),
		],
		[1, 2, 3, 4],
	);
	const h = (n: number) => handleOf(store, n);
	const search = fakeSearch(() => [
		{ kind: "knowledge", id: uuid(3), handle: h(3) },
		{ kind: "knowledge", id: uuid(1), handle: h(1) },
	]);
	const setPath = writeSet(dir, [
		evalCase({
			id: "c1",
			query: "データベース移行",
			relevant: [
				{ ref: knRef(1), grade: 3 },
				{ ref: knRef(99), grade: 2 }, // not in the import map
			],
		}),
		evalCase({
			id: "c2",
			query: "ボタン",
			relevant: [{ ref: knRef(98), grade: 3 }], // nothing resolves: case is dropped
		}),
	]);
	const outPath = join(dir, "out", "report.json");
	const lines: string[] = [];
	const report = await runEvaluation(
		{
			store,
			search: search.service,
			now: () => NOW,
			log: (l) => lines.push(l),
		},
		{
			setPath,
			systems: ["legacy-lexical", "v2-hybrid"],
			lanes: ["fts", "short"],
			k: 10,
			outPath,
			judge: false,
		},
	);

	expect(report.set).toBe("set");
	expect(report.k).toBe(10);
	expect(report.lanes).toEqual(["fts", "short"]);
	expect(report.generatedAt).toBe("2026-10-30T01:02:03.000Z");
	expect(report.unresolvedRefs).toEqual([knRef(98), knRef(99)]);

	// legacy-lexical: item 1 matches the phrase, item 3 enters through dynamicScore 2,
	// item 2 scores 0 and item 4 is pushed to <= 0 by dynamicScore -100
	const legacy = report.perQuery.filter((p) => p.system === "legacy-lexical");
	expect(legacy).toEqual([
		{
			id: "c1",
			system: "legacy-lexical",
			hits: [h(1), h(3)],
			firstRelevantRank: 1,
		},
	]);
	const v2 = report.perQuery.filter((p) => p.system === "v2-hybrid");
	expect(v2).toEqual([
		{ id: "c1", system: "v2-hybrid", hits: [h(3), h(1)], firstRelevantRank: 2 },
	]);

	// only the resolvable ref (item 1, grade 3) counts as relevant
	expect(report.systems["legacy-lexical"]).toEqual({
		recallAtK: 1,
		mrrAtK: 1,
		ndcgAtK: 1,
		queries: 1,
		zeroHit: 0,
		dupRateAtK: 0,
		conflictRateAtK: 0,
	});
	expect(report.systems["v2-hybrid"].queries).toBe(1);
	expect(report.systems["v2-hybrid"].recallAtK).toBe(1);
	expect(report.systems["v2-hybrid"].mrrAtK).toBe(1 / 2);
	expect(report.systems["v2-hybrid"].ndcgAtK).toBeCloseTo(1 / Math.log2(3), 12);
	expect(report.wins).toEqual({ v2: 0, legacy: 1, tie: 0 });

	// the v2 system was called with the case's filters, the lanes and limit k
	expect(search.requests).toEqual([
		{
			query: "データベース移行",
			kinds: ["knowledge"],
			spaces: ["coding"],
			lanes: ["fts", "short"],
			limit: 10,
		},
	]);
	// the report is written (parent directory created) and equals the returned value
	expect(JSON.parse(readFileSync(outPath, "utf8")) as EvalReport).toEqual(
		report,
	);
	expect(lines.some((l) => l.includes("c2"))).toBe(true);
});

test("runEvaluation: a single system leaves the other zeroed and wins empty", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[knowledge(1, { title: "alpha rule", body: "alpha" })],
		[1],
	);
	const search = fakeSearch(() => []);
	const setPath = writeSet(dir, [
		evalCase({
			id: "c1",
			query: "alpha",
			relevant: [{ ref: knRef(1), grade: 3 }],
		}),
	]);
	const report = await runEvaluation(
		{ store, search: search.service, now: () => NOW, log: () => {} },
		{
			setPath,
			systems: ["v2-hybrid"],
			lanes: ["fts"],
			k: 5,
			outPath: join(dir, "r.json"),
			judge: false,
		},
	);
	expect(report.systems["v2-hybrid"]).toEqual({
		recallAtK: 0,
		mrrAtK: 0,
		ndcgAtK: 0,
		queries: 1,
		zeroHit: 1,
		dupRateAtK: 0,
		conflictRateAtK: 0,
	});
	expect(report.systems["legacy-lexical"].queries).toBe(0);
	expect(report.perQuery.map((p) => p.system)).toEqual(["v2-hybrid"]);
	expect(report.wins).toEqual({ v2: 0, legacy: 0, tie: 0 });
	expect(search.requests[0]?.limit).toBe(5);
});

test("legacy baselines apply the same row filter as search and break ties by importance desc, updated_at desc, id asc", async () => {
	const { store } = setup();
	const at = (date: string) => ({ createdAt: date, updatedAt: date });
	await seed(
		store,
		[
			knowledge(1, {
				title: "backup first",
				...at("2026-01-01T00:00:00.000Z"),
			}),
			knowledge(2, {
				title: "backup first",
				...at("2026-03-01T00:00:00.000Z"),
			}),
			knowledge(3, {
				title: "backup first",
				...at("2026-03-01T00:00:00.000Z"),
			}),
			knowledge(8, {
				title: "backup first",
				importance: 0.9,
				...at("2025-01-01T00:00:00.000Z"),
			}),
			knowledge(4, { title: "backup first", status: "candidate" }),
			knowledge(5, { title: "backup first", space: "general" }),
			knowledge(6, { title: "backup first", scope: "repo", repoKey: "r" }),
			knowledge(7, { title: "backup first", layer: "canonical" }),
		],
		[],
	);
	const candidates = store.read((db) =>
		loadCandidates(db, ["coding"], ["knowledge"]),
	);
	expect(candidates.map((c) => c.id).sort()).toEqual([
		uuid(1),
		uuid(2),
		uuid(3),
		uuid(8),
	]);
	const order = [uuid(8), uuid(2), uuid(3), uuid(1)];
	for (const mode of ["lexical", "query-first"] as const) {
		expect(
			rankLegacy(candidates, "backup first", 10, mode).map((r) => r.id),
		).toEqual(order);
		expect(
			rankLegacy(candidates, "backup first", 2, mode).map((r) => r.id),
		).toEqual(order.slice(0, 2));
	}
	// a general-space case sees the general row only
	expect(
		store
			.read((db) => loadCandidates(db, ["general"], ["knowledge"]))
			.map((c) => c.id),
	).toEqual([uuid(5)]);
});

test("legacy-query-first drops rows without a query match, which dynamicScore alone keeps in legacy-lexical", async () => {
	const { store } = setup();
	await seed(
		store,
		[
			knowledge(1, { title: "backup first", body: "x" }),
			// no query match, but dynamicScore 90 pushes it first in legacy-lexical
			knowledge(2, {
				title: "unrelated memo",
				body: "y",
				metadata: { legacy: { dynamicScore: 90 } },
			}),
			// matches the query less than item 1 but more dynamicScore
			knowledge(3, {
				title: "first",
				body: "backup",
				metadata: { legacy: { dynamicScore: 5 } },
			}),
		],
		[],
	);
	const candidates = store.read((db) =>
		loadCandidates(db, ["coding"], ["knowledge"]),
	);
	const ids = (mode: "lexical" | "query-first") =>
		rankLegacy(candidates, "backup first", 10, mode).map((r) => r.id);
	expect(ids("lexical")).toEqual([uuid(2), uuid(3), uuid(1)]);
	expect(ids("query-first")).toEqual([uuid(1), uuid(3)]);
});

test("runEvaluation: unreachable refs are reported and left out of the relevant set; byStyle splits the metrics", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[
			knowledge(1, { title: "alpha rule", body: "alpha" }),
			knowledge(2, {
				title: "alpha stale",
				body: "alpha",
				status: "superseded",
			}),
			knowledge(3, {
				title: "alpha repo",
				body: "alpha",
				scope: "repo",
				repoKey: "r",
			}),
			knowledge(4, {
				title: "alpha canon",
				body: "alpha",
				layer: "canonical",
				situation: "alpha",
				status: "retracted",
			}),
			knowledge(5, { title: "alpha general", body: "alpha", space: "general" }),
			knowledge(6, { title: "beta rule", body: "beta" }),
			knowledge(7, {
				title: "gamma rule",
				body: "gamma",
				status: "superseded",
			}),
		],
		[1, 2, 3, 4, 5, 6, 7],
	);
	const h = (n: number) => handleOf(store, n);
	const search = fakeSearch((req) =>
		req.query === "alpha"
			? [{ kind: "knowledge", id: uuid(1), handle: h(1) }]
			: [],
	);
	const setPath = writeSet(dir, [
		evalCase({
			id: "c1",
			query: "alpha",
			style: "keyword",
			relevant: [
				{ ref: knRef(1), grade: 3 },
				{ ref: knRef(2), grade: 2 },
				{ ref: knRef(3), grade: 2 },
				{ ref: knRef(4), grade: 2 },
				{ ref: knRef(5), grade: 2 },
			],
		}),
		evalCase({
			id: "c2",
			query: "beta",
			style: "question",
			relevant: [{ ref: knRef(6), grade: 3 }],
		}),
		// the only relevant row can never be returned: the case leaves the metrics
		evalCase({
			id: "c3",
			query: "gamma",
			style: "question",
			relevant: [{ ref: knRef(7), grade: 3 }],
		}),
	]);
	const lines: string[] = [];
	const report = await runEvaluation(
		{
			store,
			search: search.service,
			now: () => NOW,
			log: (l) => lines.push(l),
		},
		{
			setPath,
			systems: ["legacy-query-first", "v2-hybrid"],
			lanes: ["fts"],
			k: 10,
			outPath: join(dir, "r.json"),
			judge: false,
		},
	);
	expect(report.unreachableRefs).toEqual(
		[knRef(2), knRef(3), knRef(4), knRef(5), knRef(7)].sort(),
	);
	expect(report.unresolvedRefs).toEqual([]);
	expect(lines.some((l) => l.includes("c3") && l.includes("skipped"))).toBe(
		true,
	);
	// c1 has only item 1 left as relevant: it is found at rank 1 by both systems
	expect(report.perQuery.map((p) => `${p.id}:${p.system}`)).toEqual([
		"c1:legacy-query-first",
		"c1:v2-hybrid",
		"c2:legacy-query-first",
		"c2:v2-hybrid",
	]);
	expect(report.systems["legacy-query-first"].queries).toBe(2);
	expect(report.systems["legacy-lexical"].queries).toBe(0);

	// byStyle: only the systems that ran, and only the styles that have queries carry data
	expect(Object.keys(report.byStyle).sort()).toEqual([
		"keyword",
		"paraphrase",
		"question",
		"scenario",
	]);
	expect(report.byStyle.paraphrase).toEqual({});
	expect(report.byStyle.scenario).toEqual({});
	expect(report.byStyle.keyword).toEqual({
		"legacy-query-first": {
			recallAtK: 1,
			mrrAtK: 1,
			ndcgAtK: 1,
			queries: 1,
			zeroHit: 0,
			dupRateAtK: 0,
			conflictRateAtK: 0,
		},
		"v2-hybrid": {
			recallAtK: 1,
			mrrAtK: 1,
			ndcgAtK: 1,
			queries: 1,
			zeroHit: 0,
			dupRateAtK: 0,
			conflictRateAtK: 0,
		},
	});
	expect(report.byStyle.question["v2-hybrid"]).toEqual({
		recallAtK: 0,
		mrrAtK: 0,
		ndcgAtK: 0,
		queries: 1,
		zeroHit: 1,
		dupRateAtK: 0,
		conflictRateAtK: 0,
	});
	expect(report.byStyle.question["legacy-query-first"]?.recallAtK).toBe(1);
	expect(report.byStyle.keyword["legacy-lexical"]).toBeUndefined();
	// wins compare against the matching baseline only
	expect(report.wins).toEqual({ v2: 0, legacy: 0, tie: 0 });
	expect(report.winsVsQueryFirst).toEqual({ v2: 0, legacy: 1, tie: 1 });
});

test("episodes are matched by their episodes row and scored on title, situation and lesson", async () => {
	const { store, dir } = setup();
	await seed(
		store,
		[knowledge(1, { title: "unrelated", body: "zzz" })],
		[1],
		[{ id: 10, legacy: 20 }],
	);
	const epHandle = store.read(
		(db) =>
			db
				.query<{ handle: string }, [string]>(
					"SELECT handle FROM episodes WHERE id = ?",
				)
				.get(uuid(10))!.handle,
	);
	const search = fakeSearch(() => [
		{ kind: "episode", id: uuid(10), handle: epHandle },
	]);
	const setPath = writeSet(dir, [
		evalCase({
			id: "c1",
			query: "database migration",
			kinds: ["knowledge", "episode"],
			relevant: [{ ref: `legacy:episode_cards:${uuid(20)}`, grade: 3 }],
		}),
	]);
	const report = await runEvaluation(
		{ store, search: search.service, now: () => NOW, log: () => {} },
		{
			setPath,
			systems: ["legacy-lexical", "v2-hybrid"],
			lanes: ["fts", "short"],
			k: 10,
			outPath: join(dir, "r.json"),
			judge: false,
		},
	);
	expect(report.perQuery).toEqual([
		{
			id: "c1",
			system: "legacy-lexical",
			hits: [epHandle],
			firstRelevantRank: 1,
		},
		{ id: "c1", system: "v2-hybrid", hits: [epHandle], firstRelevantRank: 1 },
	]);
	expect(report.wins).toEqual({ v2: 0, legacy: 0, tie: 1 });
});
