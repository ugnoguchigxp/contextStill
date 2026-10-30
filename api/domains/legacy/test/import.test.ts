import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { vectorSpaceKey } from "../../../infrastructure/vector";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	getEpisodeById,
	listEpisodeSources,
	migrations as experienceMigrations,
} from "../../experience";
import {
	getKnowledgeById,
	listKnowledgeEvidence,
	migrations as knowledgeMigrations,
	setKnowledgeDisposition,
} from "../../knowledge";
import { LARM_EMBEDDING_SPACE } from "../../larm";
import {
	getSourceRecord,
	migrations as sourcesMigrations,
} from "../../sources";
import { migrations as usageMigrations } from "../../usage";
import { getVector, migrations as vectorsMigrations } from "../../vectors";
import {
	type LegacyImportArgs,
	type LegacyImportReport,
	migrations,
	resolveLegacyRef,
	runLegacyImport,
} from "../index";
import { LEGACY_VECTOR_SPACE } from "../service/vector-space";
import { canonicalRepoKey } from "../service/convert";
import { USAGE_SQL } from "../service/tables";
import { createLegacyDb, insert, ISO, seedLegacy } from "./legacy-fixture";

const NOW = new Date("2026-10-30T00:00:00.000Z");
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});

function setup(seed: (db: Database) => void = seedLegacy) {
	const t = tempStore([
		...migrations,
		...sourcesMigrations,
		...experienceMigrations,
		...knowledgeMigrations,
		...vectorsMigrations,
		...usageMigrations,
	]);
	disposers.push(t.dispose);
	const snapshotPath = join(t.dir, "legacy.sqlite3");
	const legacy = createLegacyDb(snapshotPath);
	seed(legacy);
	legacy.close();
	const logs: string[] = [];
	const deps = {
		store: t.store,
		dbPath: join(t.dir, "db.sqlite3"),
		now: () => NOW,
		log: (line: string) => logs.push(line),
	};
	const run = (over: Partial<LegacyImportArgs> = {}) =>
		runLegacyImport(deps, {
			snapshotPath,
			dryRun: false,
			batchSize: 500,
			...over,
		});
	const count = (table: string) =>
		(
			t.store.read((db) =>
				db.query(`SELECT count(*) AS n FROM ${table}`).get(),
			) as { n: number }
		).n;
	const mutateLegacy = (change: (db: Database) => void) => {
		const db = new Database(snapshotPath);
		change(db);
		db.close();
	};
	return { ...t, deps, run, count, snapshotPath, logs, mutateLegacy };
}

const tableCounts = (report: LegacyImportReport) =>
	Object.fromEntries(
		Object.entries(report.tables).map(([table, r]) => [
			table,
			[r.legacyCount, r.inserted, r.updated, r.unchanged, r.skipped],
		]),
	);

test("the first run imports every rule-conforming row and skips the rest", async () => {
	const s = setup();
	const report = await s.run();
	expect(report.importerVersion).toBe("legacy-import.v2");
	expect(report.dryRun).toBe(false);
	expect(tableCounts(report)).toEqual({
		vibe_memories: [3, 3, 0, 0, 0],
		sources: [4, 3, 0, 0, 1],
		source_fragments: [2, 2, 0, 0, 0],
		episode_cards: [4, 3, 0, 0, 1],
		knowledge_items: [14, 12, 0, 0, 2],
		knowledge_usage_events: [3, 2, 0, 0, 1],
		knowledge_items_vec_fallback: [4, 2, 0, 0, 2],
	});
	for (const r of Object.values(report.tables))
		expect(r.inserted + r.skipped).toBe(r.legacyCount);
	expect(report.tables.sources.skippedReasons).toEqual({
		unknown_source_kind: 1,
	});
	expect(report.tables.knowledge_items.skippedReasons).toEqual({
		unknown_type: 1,
		unknown_status: 1,
	});
	expect(s.count("source_records")).toBe(6);
	expect(s.count("source_fragments")).toBe(2);
	expect(s.count("episodes")).toBe(3);
	expect(s.count("knowledge_items")).toBe(12);
	expect(s.count("usage_events")).toBe(2);
	expect(s.count("vectors")).toBe(2);
	expect(s.count("legacy_import_map")).toBe(3 + 3 + 2 + 3 + 12 + 2 + 2);
	const run = s.store.read((db) =>
		db.query("SELECT status, report_json FROM legacy_import_runs").get(),
	) as { status: string; report_json: string };
	expect(run.status).toBe("succeeded");
	expect(JSON.parse(run.report_json).runId).toBe(report.runId);
});

test("a second run changes nothing", async () => {
	const s = setup();
	const first = await s.run();
	const second = await s.run();
	for (const [table, r] of Object.entries(second.tables)) {
		expect(r.inserted).toBe(0);
		expect(r.updated).toBe(0);
		expect(r.legacyCount).toBe(
			first.tables[table as keyof typeof first.tables].legacyCount,
		);
		expect(r.unchanged + r.skipped).toBe(r.legacyCount);
	}
	expect(second.provenance).toEqual(first.provenance);
	expect(second.vectors).toEqual(first.vectors);
	expect(s.store.read((db) => getKnowledgeById(db, "k1"))?.revision).toBe(1);
	expect(s.count("legacy_import_runs")).toBe(2);
});

test("changing one legacy row updates exactly that row", async () => {
	const s = setup();
	await s.run();
	s.mutateLegacy((db) =>
		db
			.query("UPDATE episode_cards SET lesson = 'new lesson' WHERE id = 'e1'")
			.run(),
	);
	const report = await s.run();
	expect(report.tables.episode_cards.updated).toBe(1);
	expect(report.tables.episode_cards.inserted).toBe(0);
	for (const [table, r] of Object.entries(report.tables))
		if (table !== "episode_cards") expect(r.updated).toBe(0);
	const episode = s.store.read((db) => getEpisodeById(db, "e1"));
	expect(episode?.lesson).toBe("new lesson");
	expect(episode?.revision).toBe(2);
	// a changed knowledge row is picked up the same way
	s.mutateLegacy((db) =>
		db
			.query("UPDATE knowledge_items SET body = 'edited' WHERE id = 'k3'")
			.run(),
	);
	const again = await s.run();
	expect(again.tables.knowledge_items.updated).toBe(1);
	expect(again.tables.knowledge_items.unchanged).toBe(11);
	// a fresh row is inserted
	s.mutateLegacy((db) =>
		insert(db, "vibe_memories", {
			id: "v9",
			session_id: "x",
			content: "new",
			created_at: ISO,
		}),
	);
	const third = await s.run();
	expect(third.tables.vibe_memories.inserted).toBe(1);
	expect(third.tables.vibe_memories.legacyCount).toBe(4);
});

test("timestamps in the three legacy formats become UTC ISO", async () => {
	const s = setup();
	const report = await s.run();
	expect(report.time).toEqual({
		converted: { iso: 15, sqlite: 6, unix_ms: 3 },
		invalid: 1,
	});
	const recorded = (id: string) =>
		s.store.read((db) => getSourceRecord(db, id))?.recordedAt;
	expect(recorded("v1")).toBe("2026-06-18T14:57:56.032Z");
	expect(recorded("v2")).toBe("2026-09-11T05:04:10.000Z");
	expect(recorded("v3")).toBe("2026-06-22T12:33:38.752Z");
	// k12: created_at unreadable -> updated_at; k9: updated_at unreadable -> created_at
	const k12 = s.store.read((db) => getKnowledgeById(db, "k12"));
	expect(k12?.createdAt).toBe("2026-09-11T05:04:10.000Z");
	const k9 = s.store.read((db) => getKnowledgeById(db, "k9"));
	expect([k9?.createdAt, k9?.updatedAt]).toEqual([
		"2026-06-22T12:33:38.752Z",
		"2026-06-22T12:33:38.752Z",
	]);
});

test("every knowledge item gets one of four provenance states", async () => {
	const s = setup();
	const report = await s.run();
	expect(report.provenance).toEqual({
		resolved: 7,
		external: 2,
		source_missing: 1,
		unresolved: 2,
		activeUnresolved: 1,
		byOrigin: {
			"found_candidate:vibe_memory": 4,
			"found_candidate:wiki_file": 1,
			"found_candidate:web_ingest": 2,
			"found_candidate:knowledge_candidate": 1,
			"target_metadata:vibe_memory": 1,
			"origin_link:vibe_memory": 1,
			none: 2,
		},
	});
	const status = (id: string) =>
		s.store.read((db) => getKnowledgeById(db, id))?.provenanceStatus;
	const evidence = (id: string) =>
		s.store
			.read((db) => listKnowledgeEvidence(db, id))
			.map((e) => [
				e.targetKind,
				e.targetId ?? e.externalRef,
				e.origin,
				e.role,
			]);
	expect(status("k1")).toBe("resolved");
	expect(evidence("k1")).toEqual([
		["source", "v1", "legacy_import", "derived_from"],
	]);
	expect(status("k2")).toBe("source_missing");
	expect(evidence("k2")).toEqual([
		["external", "vibe_memory:gone", "legacy_import", "derived_from"],
	]);
	// wiki_file: the queue's source_uri names the sources row
	expect(status("k3")).toBe("resolved");
	expect(evidence("k3")).toEqual([
		["source", "s2", "legacy_import", "derived_from"],
	]);
	// web_ingest: unknown URL is external, a known one resolves
	expect(status("k4")).toBe("external");
	expect(evidence("k4")).toEqual([
		["external", "https://x.test/p", "legacy_import", "derived_from"],
	]);
	expect(status("k12")).toBe("resolved");
	// knowledge_candidate has no source record of its own
	expect(status("k5")).toBe("external");
	expect(evidence("k5")).toEqual([
		["external", "agent_candidate:cand-5", "legacy_import", "derived_from"],
	]);
	// no chain: the metadata target, then the origin links
	expect(evidence("k6")).toEqual([
		["source", "v2", "legacy_import", "derived_from"],
	]);
	expect(evidence("k7")).toEqual([
		["source", "v3", "legacy_import", "derived_from"],
	]);
	// the fixed text "the source target" is not a target; nothing else traces k8
	expect(status("k8")).toBe("unresolved");
	expect(evidence("k8")).toEqual([]);
	// fragment links are always extra evidence
	expect(evidence("k12")).toEqual([
		["source", "s3", "legacy_import", "derived_from"],
		["fragment", "f1", "legacy_import", "derived_from"],
	]);
});

test("a draft becomes active only when finalize stored it with all four gates", async () => {
	const s = setup();
	await s.run();
	const get = (id: string) => s.store.read((db) => getKnowledgeById(db, id));
	expect(get("k9")?.status).toBe("active");
	expect(get("k10")?.status).toBe("candidate");
	expect(get("k11")?.status).toBe("retracted");
	expect(get("k1")?.status).toBe("active");
	expect(
		s.logs.some((l) =>
			l.includes('"draft":{"total":2,"gatePassed":1,"gateFailed":1}'),
		),
	).toBe(true);
});

test("scope is normalised and legacy values stay in metadata", async () => {
	const s = setup();
	await s.run();
	const k1 = s.store.read((db) => getKnowledgeById(db, "k1"));
	expect([k1?.scope, k1?.repoKey]).toEqual(["repo", "r"]);
	expect(k1?.confidence).toBeCloseTo(0.85);
	expect(k1?.importance).toBeCloseTo(0.7);
	expect(k1?.layer).toBe("atom");
	expect(k1?.facets).toEqual({
		appliesTo: { domains: ["x"] },
		intentTags: ["t"],
	});
	expect(k1?.metadata).toEqual({
		legacy: {
			status: "active",
			scope: "repo",
			repoKey: "/users/me/code/r",
			repoPath: null,
			projectRef: null,
			dynamicScore: 1.5,
			compileSelectCount: 3,
			classificationStatus: "unresolved",
		},
	});
	// repo scope without a repo key is general knowledge
	const k2 = s.store.read((db) => getKnowledgeById(db, "k2"));
	expect([k2?.scope, k2?.repoKey]).toEqual(["global", null]);
	expect(k2?.metadata).toMatchObject({ legacy: { scope: "repo" } });
	const e1 = s.store.read((db) => getEpisodeById(db, "e1"));
	expect([e1?.scope, e1?.repoKey, e1?.status]).toEqual(["repo", "r", "active"]);
	expect(e1?.confidence).toBeCloseTo(0.8);
	expect(e1?.facets).toMatchObject({
		domains: ["d"],
		applicability: { when: "x" },
	});
	expect([e1?.intent, e1?.decision, e1?.eventStart, e1?.timePrecision]).toEqual(
		["", "", null, "unknown"],
	);
	expect(s.store.read((db) => getEpisodeById(db, "e2"))?.status).toBe("stale");
	expect(s.store.read((db) => getEpisodeById(db, "e3"))?.scope).toBe("global");
	expect(s.store.read((db) => getEpisodeById(db, "e4"))).toBeNull();
	expect(s.store.read((db) => listEpisodeSources(db, "e1"))).toEqual([
		{ sourceId: "v1", locator: "bytes:0-10", role: "derived_from" },
	]);
	const source = s.store.read((db) => getSourceRecord(db, "s2"));
	expect([source?.kind, source?.scope, source?.repoKey, source?.space]).toEqual(
		["document", "global", null, "coding"],
	);
	expect(s.store.read((db) => getSourceRecord(db, "s3"))?.kind).toBe("web");
	const vibe = s.store.read((db) => getSourceRecord(db, "v1"));
	expect([vibe?.kind, vibe?.uri, vibe?.title, vibe?.scope]).toEqual([
		"agent_log",
		"vibe_memory:v1",
		"first",
		"global",
	]);
	const stored = s.store.read((db) =>
		db.query("SELECT metadata_json FROM source_records WHERE id = 'v1'").get(),
	) as { metadata_json: string };
	expect(JSON.parse(stored.metadata_json)).toEqual({
		legacy: {
			sessionId: "sess-1",
			memoryType: "chat",
			metadata: { cwd: "/repo", n: 1 },
		},
	});
});

test("usage events keep ids and map to the compile channel", async () => {
	const s = setup();
	await s.run();
	const row = s.store.read((db) =>
		db.query("SELECT * FROM usage_events WHERE id = 'u1'").get(),
	);
	expect(row).toMatchObject({
		owner_kind: "knowledge",
		owner_id: "k1",
		channel: "compile",
		verdict: "used",
		actor: "agent",
		run_ref: "run-1",
		origin: "legacy_import",
		occurred_at: "2026-06-22T12:33:38.752Z",
		metadata_json: '{"selectedRank":1}',
	});
});

test("legacy vectors are unverified, stale or skipped as invalid", async () => {
	const s = setup();
	const report = await s.run();
	expect(report.vectors).toEqual({ imported: 2, stale: 1, invalid: 2 });
	expect(report.tables.knowledge_items_vec_fallback.skippedReasons).toEqual({
		invalid_embedding: 2,
	});
	const spaceKey = vectorSpaceKey({
		modelId: LARM_EMBEDDING_SPACE.model.id,
		revision: LARM_EMBEDDING_SPACE.model.revision,
		artifactDigest: LARM_EMBEDDING_SPACE.model.artifactDigest,
		dimension: LARM_EMBEDDING_SPACE.dimension,
	});
	const fresh = s.store.read((db) =>
		getVector(db, "knowledge", "k1", spaceKey),
	);
	expect(fresh?.verification).toBe("unverified");
	expect(fresh?.origin).toBe("legacy_import");
	expect(fresh?.vector.length).toBe(384);
	const stale = s.store.read((db) =>
		getVector(db, "knowledge", "k2", spaceKey),
	);
	expect(stale?.verification).toBe("stale");
	// the digest it was made from is kept, so it keeps looking stale
	expect(stale?.contentDigest).toBe("old-hash");
	expect(
		s.store.read((db) => getVector(db, "knowledge", "k3", spaceKey)),
	).toBeNull();
	const space = s.store.read((db) =>
		db.query("SELECT descriptor_json FROM vector_spaces").get(),
	) as { descriptor_json: string };
	expect(space.descriptor_json).toBe(canonicalJson(LARM_EMBEDDING_SPACE));
});

test("the copied vector space is the LARM embedding space", () => {
	expect(canonicalJson(LEGACY_VECTOR_SPACE)).toBe(
		canonicalJson(LARM_EMBEDDING_SPACE),
	);
});

test("the live legacy database and the target database are refused", async () => {
	const s = setup();
	const live = join(
		process.env.HOME ?? "",
		"Code/contextStill-legacy/data/context-still-core.sqlite",
	);
	await expect(s.run({ snapshotPath: live })).rejects.toThrow(
		"snapshot_path_forbidden",
	);
	await expect(s.run({ snapshotPath: s.deps.dbPath })).rejects.toThrow(
		"snapshot_path_forbidden",
	);
	expect(s.count("legacy_import_runs")).toBe(0);
	await expect(
		s.run({ snapshotPath: join(s.dir, "missing.sqlite3") }),
	).rejects.toThrow("snapshot_not_found");
});

test("--dry-run reports what would happen and writes nothing", async () => {
	const s = setup();
	const dry = await s.run({ dryRun: true });
	expect(dry.dryRun).toBe(true);
	expect(dry.tables.knowledge_items.inserted).toBe(12);
	expect(dry.provenance.resolved).toBe(7);
	for (const table of [
		"source_records",
		"source_fragments",
		"episodes",
		"episode_sources",
		"knowledge_items",
		"knowledge_evidence",
		"usage_events",
		"vectors",
		"vector_spaces",
		"legacy_import_runs",
		"legacy_import_map",
	])
		expect(s.count(table)).toBe(0);
	// after a real run, a dry run sees everything unchanged and still writes nothing
	await s.run();
	const after = await s.run({ dryRun: true });
	expect(after.tables.knowledge_items.unchanged).toBe(12);
	expect(after.tables.knowledge_items.inserted).toBe(0);
	expect(s.count("legacy_import_runs")).toBe(1);
});

test("the same id in two source tables stops the import", async () => {
	const s = setup((db) => {
		insert(db, "vibe_memories", {
			id: "dup",
			session_id: "x",
			content: "a",
			created_at: ISO,
		});
		insert(db, "sources", {
			id: "dup",
			source_kind: "wiki",
			uri: "/w/x.md",
			body: "b",
			created_at: ISO,
			updated_at: ISO,
		});
	});
	await expect(s.run()).rejects.toThrow("id_collision");
	const run = s.store.read((db) =>
		db.query("SELECT status, report_json FROM legacy_import_runs").get(),
	) as { status: string; report_json: string };
	expect(run.status).toBe("failed");
	expect(JSON.parse(run.report_json).error).toBe("id_collision");
});

test("batches of any size give the same result, and --only limits the tables", async () => {
	const small = setup();
	const a = await small.run({ batchSize: 2 });
	const big = setup();
	const b = await big.run({ batchSize: 1000 });
	expect(tableCounts(a)).toEqual(tableCounts(b));
	const only = setup();
	const c = await only.run({ only: ["vibe_memories", "sources"] });
	expect(c.tables.vibe_memories.inserted).toBe(3);
	expect(c.tables.knowledge_items.legacyCount).toBe(0);
	expect(only.count("knowledge_items")).toBe(0);
	expect(only.count("source_records")).toBe(6);
});

test("rows that disappeared from the snapshot are kept and counted", async () => {
	const s = setup();
	await s.run();
	s.mutateLegacy((db) =>
		db.query("DELETE FROM knowledge_usage_events WHERE id = 'u2'").run(),
	);
	await s.run();
	expect(s.count("usage_events")).toBe(2);
	const run = s.store.read((db) =>
		db
			.query(
				"SELECT report_json FROM legacy_import_runs ORDER BY started_at DESC, rowid DESC LIMIT 1",
			)
			.get(),
	) as { report_json: string };
	expect(
		JSON.parse(run.report_json).notes.vanishedFromLegacy.knowledge_usage_events,
	).toBe(1);
});

test("imported rows can be found through legacy refs", async () => {
	const s = setup();
	await s.run();
	expect(
		s.store.read((db) => resolveLegacyRef(db, "legacy:knowledge_items:k1")),
	).toEqual({
		targetTable: "knowledge_items",
		targetId: "k1",
	});
	expect(
		s.store.read((db) => resolveLegacyRef(db, "legacy:episode_cards:e1")),
	).toEqual({
		targetTable: "episodes",
		targetId: "e1",
	});
	expect(
		s.store.read((db) => resolveLegacyRef(db, "legacy:knowledge_items:k13")),
	).toBeNull();
});

// --- fix batch: scope, provenance, version, vectors, fragments, snapshot ---------------

test("canonicalRepoKey takes the name of a path, owner/name or a plain key, else the path", () => {
	expect(canonicalRepoKey("/Users/me/Code/NightWorkers", null)).toBe(
		"nightworkers",
	);
	expect(canonicalRepoKey("/Users/me/Code/Foo/", "/x/other")).toBe("foo");
	expect(canonicalRepoKey("Owner/Repo", null)).toBe("repo");
	expect(canonicalRepoKey("Plain", null)).toBe("plain");
	expect(canonicalRepoKey("", "/Users/me/Code/memoryRouter/")).toBe(
		"memoryrouter",
	);
	expect(canonicalRepoKey(null, "  /a/B  ")).toBe("b");
	expect(canonicalRepoKey(" ", "")).toBeNull();
	expect(canonicalRepoKey(null, null)).toBeNull();
});

test("repo rows keep their repo from repo_key or repo_path, only unplaced rows become global", async () => {
	const s = setup((db) => {
		const base = (id: string, over: Record<string, string | null>) => ({
			id,
			type: "rule",
			status: "active",
			title: `t ${id}`,
			body: `b ${id}`,
			created_at: ISO,
			updated_at: ISO,
			...over,
		});
		insert(
			db,
			"knowledge_items",
			base("ka", { scope: "repo", repo_key: "/U/me/Code/Alpha" }),
		);
		insert(
			db,
			"knowledge_items",
			base("kb", {
				scope: "repo",
				repo_path: "/U/me/Code/nightWorkers",
				project_ref: "p1",
			}),
		);
		insert(
			db,
			"knowledge_items",
			base("kc", {
				scope: "repo",
				repo_key: "owner/Gamma",
				repo_path: "/U/other",
			}),
		);
		insert(db, "knowledge_items", base("kd", { scope: "repo" }));
		insert(
			db,
			"knowledge_items",
			base("ke", { scope: "global", repo_key: "/U/me/Code/Alpha" }),
		);
		const episode = (id: string, over: Record<string, string | null>) => ({
			id,
			title: id,
			situation: "s",
			source_kind: "vibe_memory",
			source_key: id,
			created_at: ISO,
			updated_at: ISO,
			...over,
		});
		insert(
			db,
			"episode_cards",
			episode("ea", { scope: "repo", repo_path: "/U/me/Code/nightWorkers/" }),
		);
		insert(
			db,
			"episode_cards",
			episode("eb", {
				scope: "repo",
				repo_key: "/U/me/Code/Beta",
				project_ref: "p2",
			}),
		);
		insert(db, "episode_cards", episode("ec", { scope: "repo" }));
		const source = (id: string, over: Record<string, string | null>) => ({
			id,
			source_kind: "wiki",
			uri: `/w/${id}`,
			body: id,
			created_at: ISO,
			updated_at: ISO,
			...over,
		});
		insert(
			db,
			"sources",
			source("sa", { scope: "repo", repo_path: "/U/me/Code/Delta" }),
		);
		insert(db, "sources", source("sb", { scope: "repo" }));
	});
	await s.run();
	const k = (id: string) => s.store.read((db) => getKnowledgeById(db, id));
	expect([k("ka")?.scope, k("ka")?.repoKey]).toEqual(["repo", "alpha"]);
	expect([k("kb")?.scope, k("kb")?.repoKey]).toEqual(["repo", "nightworkers"]);
	expect(k("kb")?.metadata).toMatchObject({
		legacy: {
			scope: "repo",
			repoKey: null,
			repoPath: "/U/me/Code/nightWorkers",
			projectRef: "p1",
		},
	});
	expect([k("kc")?.scope, k("kc")?.repoKey]).toEqual(["repo", "gamma"]);
	expect([k("kd")?.scope, k("kd")?.repoKey]).toEqual(["global", null]);
	expect(k("kd")?.metadata).toMatchObject({
		legacy: { scope: "repo", repoKey: null, repoPath: null },
	});
	expect([k("ke")?.scope, k("ke")?.repoKey]).toEqual(["global", null]);
	const e = (id: string) => s.store.read((db) => getEpisodeById(db, id));
	expect([e("ea")?.scope, e("ea")?.repoKey]).toEqual(["repo", "nightworkers"]);
	const episodeMeta = JSON.parse(
		(
			s.store.read((db) =>
				db.query("SELECT metadata_json FROM episodes WHERE id = 'eb'").get(),
			) as { metadata_json: string }
		).metadata_json,
	);
	expect(episodeMeta.legacy).toMatchObject({
		scope: "repo",
		repoKey: "/U/me/Code/Beta",
		repoPath: null,
		projectRef: "p2",
	});
	expect([e("eb")?.scope, e("eb")?.repoKey]).toEqual(["repo", "beta"]);
	expect([e("ec")?.scope, e("ec")?.repoKey]).toEqual(["global", null]);
	const src = (id: string) => s.store.read((db) => getSourceRecord(db, id));
	expect([src("sa")?.scope, src("sa")?.repoKey]).toEqual(["repo", "delta"]);
	expect([src("sb")?.scope, src("sb")?.repoKey]).toEqual(["global", null]);
});

test("a wiki page is found by its full URI, never by the same name in another repo", async () => {
	const s = setup((db) => {
		const wiki = (id: string, uri: string) => ({
			id,
			source_kind: "wiki",
			uri,
			body: id,
			created_at: ISO,
			updated_at: ISO,
		});
		insert(
			db,
			"sources",
			wiki("w-cs", "/U/Code/contextStill/wiki/pages/Tech/x.md"),
		);
		insert(db, "sources", wiki("w-solo", "/U/Code/solo/wiki/pages/Only/y.md"));
		const k = (id: string, meta: Record<string, string>) => ({
			id,
			type: "rule",
			status: "active",
			scope: "global",
			title: id,
			body: id,
			metadata: JSON.stringify({
				targetKind: "wiki_file",
				targetKey: "Tech/x.md",
				...meta,
			}),
			created_at: ISO,
			updated_at: ISO,
		});
		// another repo's page: no source for that URI, so it must not hit the same-named page
		insert(
			db,
			"knowledge_items",
			k("kw1", {
				sourceDocumentUri: "/U/Code/memoryRouter/wiki/pages/Tech/x.md",
			}),
		);
		insert(
			db,
			"knowledge_items",
			k("kw2", {
				sourceDocumentUri: "/U/Code/contextStill/wiki/pages/Tech/x.md",
			}),
		);
		// no URI: a unique wiki-relative key resolves, an ambiguous one does not
		insert(db, "knowledge_items", k("kw3", {}));
		insert(db, "knowledge_items", {
			...k("kw4", { targetKey: "Only/y.md" }),
		});
		insert(db, "sources", wiki("w-dup", "/U/Code/dup/wiki/pages/Tech/x.md"));
	});
	await s.run();
	const evidence = (id: string) =>
		s.store
			.read((db) => listKnowledgeEvidence(db, id))
			.map((e) => e.targetId ?? e.externalRef);
	const status = (id: string) =>
		s.store.read((db) => getKnowledgeById(db, id))?.provenanceStatus;
	expect([status("kw1"), evidence("kw1")]).toEqual([
		"source_missing",
		["wiki:Tech/x.md"],
	]);
	expect([status("kw2"), evidence("kw2")]).toEqual(["resolved", ["w-cs"]]);
	// two pages end with Tech/x.md: ambiguous without a URI
	expect(status("kw3")).toBe("source_missing");
	expect([status("kw4"), evidence("kw4")]).toEqual(["resolved", ["w-solo"]]);
});

test("a v1-imported database is rewritten under the v2 rules on the next run, then settles", async () => {
	const s = setup();
	await s.run();
	// what v1 left behind: old digests and a wrongly global repo row
	s.store.write((db) => {
		db.query(
			"UPDATE legacy_import_map SET legacy_digest = 'v1-' || legacy_digest WHERE legacy_table <> 'knowledge_usage_events'",
		).run();
		db.query(
			"UPDATE knowledge_items SET scope = 'global', repo_key = NULL WHERE id = 'k1'",
		).run();
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	const second = await s.run();
	for (const r of Object.values(second.tables)) expect(r.inserted).toBe(0);
	const stale = s.store.read((db) =>
		db
			.query(
				"SELECT count(*) AS n FROM legacy_import_map WHERE legacy_digest LIKE 'v1-%'",
			)
			.get(),
	) as { n: number };
	expect(stale.n).toBe(0);
	const k1 = s.store.read((db) => getKnowledgeById(db, "k1"));
	expect([k1?.scope, k1?.repoKey]).toEqual(["repo", "r"]);
	expect(second.tables.knowledge_items.updated).toBe(1);
	const third = await s.run();
	for (const r of Object.values(third.tables)) {
		expect(r.inserted + r.updated).toBe(0);
		expect(r.unchanged + r.skipped).toBe(r.legacyCount);
	}
});

test("a LARM vector is never overwritten and a legacy vector keeps its verification", async () => {
	const s = setup();
	await s.run();
	// k1: the indexing job replaced the legacy vector with its own
	s.store.write((db) => {
		db.query(
			"UPDATE vectors SET origin = 'larm', verification = 'verified', content_digest = 'larm-digest' WHERE owner_id = 'k1'",
		).run();
		db.query(
			"UPDATE vectors SET verification = 'verified' WHERE owner_id = 'k2'",
		).run();
	});
	// the legacy rows change (updated_at only for k2, the hash for k1) -> new digests
	s.mutateLegacy((db) => {
		db.query(
			"UPDATE knowledge_items_vec_fallback SET updated_at = '2026-10-01T00:00:00.000Z' WHERE knowledge_id IN ('k1', 'k2')",
		).run();
		db.query(
			"UPDATE knowledge_items_vec_fallback SET content_hash = 'other' WHERE knowledge_id = 'k1'",
		).run();
	});
	const report = await s.run();
	expect(report.tables.knowledge_items_vec_fallback.inserted).toBe(0);
	const rows = s.store.read((db) =>
		db
			.query(
				"SELECT owner_id, origin, verification, content_digest FROM vectors ORDER BY owner_id",
			)
			.all(),
	);
	expect(rows).toEqual([
		{
			owner_id: "k1",
			origin: "larm",
			verification: "verified",
			content_digest: "larm-digest",
		},
		{
			owner_id: "k2",
			origin: "legacy_import",
			verification: "verified",
			content_digest: "old-hash",
		},
	]);
});

test("fragments of a source that was not imported are skipped, not fatal", async () => {
	const s = setup((db) => {
		seedLegacy(db);
		insert(db, "source_fragments", {
			id: "f-weird",
			source_id: "s4",
			locator: "chunk:0001",
			content: "x",
			created_at: ISO,
		});
		db.exec("PRAGMA foreign_keys = OFF");
		insert(db, "source_fragments", {
			id: "f-orphan",
			source_id: "no-such-source",
			locator: "chunk:0001",
			content: "x",
			created_at: ISO,
		});
	});
	const report = await s.run();
	expect(report.tables.source_fragments.inserted).toBe(2);
	expect(report.tables.source_fragments.skipped).toBe(2);
	expect(report.tables.source_fragments.skippedReasons).toEqual({
		source_skipped: 2,
	});
});

test("an episode that is no longer active in the legacy snapshot is retracted", async () => {
	const s = setup();
	await s.run();
	expect(s.store.read((db) => getEpisodeById(db, "e1"))?.status).toBe("active");
	s.mutateLegacy((db) =>
		db
			.query("UPDATE episode_cards SET status = 'deprecated' WHERE id = 'e1'")
			.run(),
	);
	const report = await s.run();
	expect(report.tables.episode_cards.updated).toBe(1);
	expect(s.store.read((db) => getEpisodeById(db, "e1"))?.status).toBe(
		"retracted",
	);
});

test("a changed legacy usage row is counted, not applied", async () => {
	const s = setup();
	await s.run();
	s.mutateLegacy((db) =>
		db
			.query(
				"UPDATE knowledge_usage_events SET reason = 'edited' WHERE id = 'u2'",
			)
			.run(),
	);
	const report = await s.run();
	const usage = report.tables.knowledge_usage_events;
	expect(usage.skippedReasons.usage_immutable_changed).toBe(1);
	expect(usage.updated).toBe(0);
	const row = s.store.read((db) =>
		db.query("SELECT reason FROM usage_events WHERE id = 'u2'").get(),
	) as { reason: string };
	expect(row.reason).toBe("later");
});

test("usage rows imported under v1 are accepted silently", async () => {
	const s = setup();
	await s.run();
	const legacy = new Database(s.snapshotPath, { readonly: true });
	const rows = legacy.query(USAGE_SQL).all() as { id: string }[];
	legacy.close();
	s.store.write((db) => {
		for (const row of rows)
			db.query(
				"UPDATE legacy_import_map SET legacy_digest = ? WHERE legacy_table = 'knowledge_usage_events' AND legacy_id = ?",
			).run(sha256Hex(`legacy-import.v1|${canonicalJson(row)}`), row.id);
	});
	const report = await s.run();
	const usage = report.tables.knowledge_usage_events;
	expect(usage.skippedReasons.usage_immutable_changed).toBeUndefined();
	expect(usage.unchanged + usage.skipped).toBe(usage.legacyCount);
	const again = await s.run();
	expect(
		again.tables.knowledge_usage_events.unchanged +
			again.tables.knowledge_usage_events.skipped,
	).toBe(usage.legacyCount);
});

test("a row that disappeared from the new tables is restored although its digest matches", async () => {
	const s = setup();
	await s.run();
	s.store.write((db) => {
		db.query("DELETE FROM usage_events WHERE id = 'u1'").run();
		db.query("DELETE FROM source_fragments WHERE id = 'f2'").run();
	});
	const report = await s.run();
	expect(report.tables.knowledge_usage_events.inserted).toBe(1);
	expect(report.tables.source_fragments.inserted).toBe(1);
	expect(s.count("usage_events")).toBe(2);
	expect(s.count("source_fragments")).toBe(2);
});

test("a snapshot with a non-empty WAL file is refused", async () => {
	const s = setup();
	await Bun.write(`${s.snapshotPath}-wal`, "pending frames");
	await expect(s.run()).rejects.toThrow("snapshot_has_wal");
	expect(s.count("legacy_import_map")).toBe(0);
});

// --- N2-L: a re-import keeps what the re-distillation decided ----------------------------

const LATER = "2026-10-31T00:00:00.000Z";
const setLegacy = (s: ReturnType<typeof setup>, id: string, set: string) =>
	s.mutateLegacy((db) =>
		db.query(`UPDATE knowledge_items SET ${set} WHERE id = '${id}'`).run(),
	);
/** What the distill domain leaves on an atom it superseded. */
const redistilled = (s: ReturnType<typeof setup>, id: string) =>
	s.store.write((db) => {
		setKnowledgeDisposition(db, id, {
			status: "superseded",
			retrieval: "evidence_only",
			updatedAt: LATER,
		});
		db.query(
			`UPDATE knowledge_items SET metadata_json = json_set(metadata_json, '$.distill', json('{"supersededBy":"kc_1"}')) WHERE id = ?`,
		).run(id);
	});

test("a superseded atom keeps its status and retrieval when the legacy row changes", async () => {
	const s = setup();
	await s.run();
	await redistilled(s, "k3");
	setLegacy(s, "k3", "importance = 77, dynamic_score = 9");
	const report = await s.run();
	expect(report.tables.knowledge_items.updated).toBe(1);
	const row = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	expect(row.status).toBe("superseded");
	expect(row.retrieval).toBe("evidence_only");
	expect(row.importance).toBeCloseTo(0.77);
	expect((row.metadata.legacy as any).dynamicScore).toBe(9);
	// The title and body did not change: only what the legacy row says moved.
	expect(row.metadata.distill).toEqual({ supersededBy: "kc_1" });
});

test("a changed body updates the superseded atom and marks it for reassessment", async () => {
	const s = setup();
	await s.run();
	await redistilled(s, "k3");
	setLegacy(s, "k3", "body = 'edited body'");
	await s.run();
	const row = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	expect(row.body).toBe("edited body");
	expect(row.status).toBe("superseded");
	expect(row.retrieval).toBe("evidence_only");
	expect(row.metadata.distill).toEqual({
		supersededBy: "kc_1",
		needsReassess: true,
	});
	// The mark stays through a later import that changes something else.
	setLegacy(s, "k3", "importance = 11");
	await s.run();
	expect(
		s.store.read((db) => getKnowledgeById(db, "k3"))?.metadata.distill,
	).toEqual({ supersededBy: "kc_1", needsReassess: true });
});

test("an evidence-only atom keeps its retrieval and gets the mark when its body changes", async () => {
	const s = setup();
	await s.run();
	s.store.write((db) =>
		setKnowledgeDisposition(db, "k4", {
			retrieval: "evidence_only",
			updatedAt: LATER,
		}),
	);
	setLegacy(s, "k4", "title = 'renamed'");
	await s.run();
	const row = s.store.read((db) => getKnowledgeById(db, "k4"))!;
	expect(row.title).toBe("renamed");
	expect(row.status).toBe("active");
	expect(row.retrieval).toBe("evidence_only");
	expect(row.metadata.distill).toEqual({ needsReassess: true });
});

test("a deprecated legacy row still retracts a superseded atom", async () => {
	const s = setup();
	await s.run();
	await redistilled(s, "k3");
	setLegacy(s, "k3", "status = 'deprecated'");
	await s.run();
	const row = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	expect(row.status).toBe("retracted");
	expect(row.retrieval).toBe("evidence_only");
	expect(row.metadata.distill).toEqual({ supersededBy: "kc_1" });
});

test("an atom that was never re-distilled follows the legacy row as before", async () => {
	const s = setup();
	await s.run();
	setLegacy(s, "k3", "body = 'edited body'");
	await s.run();
	const row = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	expect(row.body).toBe("edited body");
	expect(row.retrieval).toBe("searchable");
	expect(row.metadata.distill).toBeUndefined();
	setLegacy(s, "k3", "status = 'deprecated'");
	await s.run();
	expect(s.store.read((db) => getKnowledgeById(db, "k3"))?.status).toBe(
		"retracted",
	);
});

test("after a protected update the next import changes nothing", async () => {
	const s = setup();
	await s.run();
	await redistilled(s, "k3");
	setLegacy(s, "k3", "body = 'edited body'");
	await s.run();
	const before = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	const report = await s.run();
	for (const r of Object.values(report.tables)) {
		expect(r.inserted).toBe(0);
		expect(r.updated).toBe(0);
	}
	expect(s.store.read((db) => getKnowledgeById(db, "k3"))).toEqual(before);
});

test("re-importing an untouched snapshot never writes a superseded atom", async () => {
	const s = setup();
	await s.run();
	await redistilled(s, "k3");
	const before = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	const report = await s.run();
	expect(report.tables.knowledge_items.updated).toBe(0);
	expect(s.store.read((db) => getKnowledgeById(db, "k3"))).toEqual(before);
});

test("an atom the conflict resolution retracted stays retracted on re-import, with no metadata.distill needed", async () => {
	const s = setup();
	await s.run();
	s.store.write((db) =>
		setKnowledgeDisposition(db, "k3", {
			status: "retracted",
			retrieval: "evidence_only",
			updatedAt: LATER,
		}),
	);
	expect(
		s.store.read((db) => getKnowledgeById(db, "k3"))?.metadata.distill,
	).toBeUndefined();
	setLegacy(s, "k3", "importance = 77");
	await s.run();
	let row = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	expect(row.status).toBe("retracted");
	expect(row.retrieval).toBe("evidence_only");
	expect(row.importance).toBeCloseTo(0.77);
	// a legacy deprecated gives the same state
	setLegacy(s, "k3", "status = 'deprecated'");
	await s.run();
	row = s.store.read((db) => getKnowledgeById(db, "k3"))!;
	expect(row.status).toBe("retracted");
});

test("a row retracted only by a legacy deprecated follows the legacy row back to active", async () => {
	const s = setup();
	await s.run();
	setLegacy(s, "k3", "status = 'deprecated'");
	await s.run();
	expect(s.store.read((db) => getKnowledgeById(db, "k3"))?.status).toBe(
		"retracted",
	);
	setLegacy(s, "k3", "status = 'active'");
	await s.run();
	expect(s.store.read((db) => getKnowledgeById(db, "k3"))?.status).toBe(
		"active",
	);
});
