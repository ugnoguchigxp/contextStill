import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	openStore,
	orderMigrations,
	type SqliteStore,
} from "../infrastructure/sqlite";
import { allMigrations } from "./migrations";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
function freshStore(): SqliteStore {
	const dir = mkdtempSync(join(tmpdir(), "context-still-migrations-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), allMigrations);
	stores.push(store);
	return store;
}
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// The order of this list is the contract: migrations are only ever appended.
const GOLDEN_IDS = [
	"settings/0001-init",
	"queue/0001-init",
	"sources/0001-init",
	"experience/0001-init",
	"knowledge/0001-init",
	"vectors/0001-init",
	"usage/0001-init",
	"legacy/0001-init",
	"map/0001-init",
	"knowledge/0002-canonical",
	"experience/0002-retrieval",
	"distill/0001-init",
];

const GOLDEN_AFTER: Record<string, string[]> = {
	"settings/0001-init": [],
	"queue/0001-init": [],
	"sources/0001-init": [],
	"experience/0001-init": ["sources/0001-init"],
	"knowledge/0001-init": ["sources/0001-init"],
	"vectors/0001-init": [],
	"usage/0001-init": [],
	"legacy/0001-init": [],
	"map/0001-init": [],
	"knowledge/0002-canonical": ["knowledge/0001-init"],
	"experience/0002-retrieval": ["experience/0001-init"],
	"distill/0001-init": [
		"knowledge/0002-canonical",
		"experience/0002-retrieval",
		"map/0001-init",
	],
};

test("GOLDEN: migration ids, their order and their dependencies are fixed", () => {
	expect(allMigrations.map((m) => m.id)).toEqual(GOLDEN_IDS);
	expect(orderMigrations(allMigrations).map((m) => m.id)).toEqual(GOLDEN_IDS);
	for (const m of allMigrations)
		expect([...(m.after ?? ["<missing>"])]).toEqual(GOLDEN_AFTER[m.id]!);
});

test("all migrations apply to a new database and create the tables of the plan", () => {
	const store = freshStore();
	const names = store
		.read((db) =>
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type IN ('table') AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all(),
		)
		.map((r) => (r as { name: string }).name);
	for (const expected of [
		"episode_sources",
		"episodes",
		"episodes_fts",
		"knowledge_evidence",
		"knowledge_fts",
		"knowledge_items",
		"distill_assessments",
		"distill_llm_calls",
		"distill_pair_judgments",
		"distill_params",
		"distill_reviews",
		"distill_runs",
		"legacy_import_map",
		"legacy_import_runs",
		"map_cluster_members",
		"map_clusters",
		"map_edges",
		"map_facet_concepts",
		"queue_jobs",
		"settings_credentials",
		"settings_document",
		"source_fragments",
		"source_records",
		"usage_events",
		"vector_spaces",
		"vector_verifications",
		"vectors",
	])
		expect(names).toContain(expected);
	// Reopening applies nothing new and is accepted.
});

test("reopening a migrated database is accepted", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-migrations-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	await openStore(file, allMigrations).close();
	const again = openStore(file, allMigrations);
	stores.push(again);
	expect(
		again.read((db) =>
			db.query("SELECT count(*) AS n FROM schema_migrations_v2").get(),
		),
	).toEqual({ n: GOLDEN_IDS.length });
});

const knowledgeRow = (id: string, title: string, body: string) => ({
	id,
	handle: `h_${id}`,
	title,
	body,
});

function insertKnowledge(
	store: SqliteStore,
	row: { id: string; handle: string; title: string; body: string },
) {
	return store.write((db) =>
		db
			.query(
				`INSERT INTO knowledge_items
				 (id, handle, layer, type, polarity, title, body, confidence, importance, status,
				  space, scope, content_digest, provenance_status, created_at, updated_at)
				 VALUES (?, ?, 'atom', 'rule', 'positive', ?, ?, 0.5, 0.5, 'active',
				  'coding', 'global', 'd', 'resolved', 't', 't')`,
			)
			.run(row.id, row.handle, row.title, row.body),
	);
}

const matchKnowledge = (store: SqliteStore, phrase: string) =>
	store
		.read((db) =>
			db
				.query(
					`SELECT k.id FROM knowledge_fts f JOIN knowledge_items k ON k.seq = f.rowid
					 WHERE knowledge_fts MATCH ?`,
				)
				.all(`"${phrase}"`),
		)
		.map((r) => (r as { id: string }).id);

test("the trigram FTS finds a three-character Japanese phrase and follows updates", async () => {
	const store = freshStore();
	await insertKnowledge(
		store,
		knowledgeRow(
			"k1",
			"ファイル操作",
			"データベースへの書き込みは一件ずつ行う",
		),
	);
	expect(matchKnowledge(store, "書き込み")).toEqual(["k1"]);
	expect(matchKnowledge(store, "読み出し")).toEqual([]);
	await store.write((db) =>
		db
			.query("UPDATE knowledge_items SET body = ? WHERE id = 'k1'")
			.run("データベースからの読み出しは一括で行う"),
	);
	// The old wording no longer matches, the new one does.
	expect(matchKnowledge(store, "書き込み")).toEqual([]);
	expect(matchKnowledge(store, "読み出し")).toEqual(["k1"]);
	await store.write((db) => db.query("DELETE FROM knowledge_items").run());
	expect(matchKnowledge(store, "読み出し")).toEqual([]);
});

test("the trigram FTS of episodes follows updates", async () => {
	const store = freshStore();
	await store.write((db) =>
		db
			.query(
				`INSERT INTO episodes (id, handle, title, situation, lesson, outcome_kind,
				   confidence, importance, status, space, scope, created_at, updated_at)
				 VALUES ('e1', 'h_e1', 'タイトル', '本番での障害対応', '切り戻しを先に行う', 'success',
				   0.5, 0.5, 'active', 'coding', 'global', 't', 't')`,
			)
			.run(),
	);
	const find = (phrase: string) =>
		store.read((db) =>
			db
				.query("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?")
				.all(`"${phrase}"`),
		).length;
	expect(find("切り戻し")).toBe(1);
	await store.write((db) =>
		db
			.query("UPDATE episodes SET lesson = '調査を先に行う' WHERE id = 'e1'")
			.run(),
	);
	expect(find("切り戻し")).toBe(0);
	expect(find("調査を先")).toBe(1);
});

test("settings credentials must be v2 ciphertext", async () => {
	const store = freshStore();
	await expect(
		store.write((db) =>
			db
				.query(
					"INSERT INTO settings_credentials (id, encrypted, updated_at) VALUES ('a', 'plain', 't')",
				)
				.run(),
		),
	).rejects.toThrow();
});

// ---- N2: an N1 database receives the N2 migrations --------------------------------------

const N1_COUNT = 8;
const n1Migrations = () => allMigrations.slice(0, N1_COUNT);

/** Builds an N1 database (the first 8 migrations) with rows, closes it, returns its path. */
async function n1Database(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "context-still-migrations-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	const store = openStore(file, n1Migrations());
	await store.write((db) => {
		const atom = db.query(
			`INSERT INTO knowledge_items
			 (id, handle, layer, type, polarity, title, body, confidence, importance, status,
			  space, scope, content_digest, provenance_status, created_at, updated_at)
			 VALUES (?, ?, 'atom', 'rule', 'positive', ?, ?, 0.5, 0.5, ?, 'coding', 'global',
			  'd', 'resolved', 't', 't')`,
		);
		atom.run(
			"k1",
			"h_k1",
			"ファイル操作",
			"データベースへの書き込みは一件ずつ行う",
			"active",
		);
		atom.run(
			"k2",
			"h_k2",
			"古い知識",
			"置き換えられた内容を持つ旧版の知識",
			"superseded",
		);
		db.query(
			`INSERT INTO episodes (id, handle, title, situation, lesson, outcome_kind,
			   confidence, importance, status, space, scope, created_at, updated_at)
			 VALUES ('e1', 'h_e1', 'タイトル', '本番での障害対応', '切り戻しを先に行う', 'success',
			   0.5, 0.5, 'active', 'coding', 'global', 't', 't')`,
		).run();
	});
	await store.close();
	return file;
}

test("an N1 database takes the N2 migrations: rows keep their text and get the defaults", async () => {
	const file = await n1Database();
	const store = openStore(file, allMigrations);
	stores.push(store);
	const rows = store.read((db) =>
		db
			.query(
				`SELECT id, title, body, status, situation, rationale, exceptions_json,
				        examples_json, retrieval, revision
				 FROM knowledge_items ORDER BY id`,
			)
			.all(),
	);
	expect(rows).toEqual([
		{
			id: "k1",
			title: "ファイル操作",
			body: "データベースへの書き込みは一件ずつ行う",
			status: "active",
			situation: "",
			rationale: "",
			exceptions_json: "[]",
			examples_json: "[]",
			retrieval: "searchable",
			revision: 1,
		},
		{
			id: "k2",
			title: "古い知識",
			body: "置き換えられた内容を持つ旧版の知識",
			status: "superseded",
			situation: "",
			rationale: "",
			exceptions_json: "[]",
			examples_json: "[]",
			retrieval: "searchable",
			revision: 1,
		},
	]);
	expect(
		store.read((db) => db.query("SELECT retrieval FROM episodes").get()),
	).toEqual({ retrieval: "searchable" });
	expect(
		store.read((db) =>
			db.query("SELECT count(*) AS n FROM schema_migrations_v2").get(),
		),
	).toEqual({ n: GOLDEN_IDS.length });
});

test("the rebuilt FTS finds the old wording and the new situation column", async () => {
	const file = await n1Database();
	const store = openStore(file, allMigrations);
	stores.push(store);
	// The wording that was indexed under the N1 table is found again after the rebuild.
	expect(matchKnowledge(store, "書き込み")).toEqual(["k1"]);
	expect(matchKnowledge(store, "旧版の知識")).toEqual(["k2"]);
	await store.write((db) =>
		db
			.query("UPDATE knowledge_items SET situation = ? WHERE id = 'k1'")
			.run("夜間バッチの失敗を調査するとき"),
	);
	expect(matchKnowledge(store, "夜間バッチ")).toEqual(["k1"]);
	// The old wording still matches, an update of the situation alone moved nothing else.
	expect(matchKnowledge(store, "書き込み")).toEqual(["k1"]);
	await store.write((db) =>
		db.query("UPDATE knowledge_items SET situation = '' WHERE id = 'k1'").run(),
	);
	expect(matchKnowledge(store, "夜間バッチ")).toEqual([]);
	// A column filter works on the new table.
	expect(
		store
			.read((db) =>
				db
					.query(
						`SELECT k.id FROM knowledge_fts f JOIN knowledge_items k ON k.seq = f.rowid
						 WHERE knowledge_fts MATCH 'title: "ファイル"'`,
					)
					.all(),
			)
			.map((r) => (r as { id: string }).id),
	).toEqual(["k1"]);
});

test("STRICT and CHECK reject bad values in the columns and tables N2 adds", async () => {
	const file = await n1Database();
	const store = openStore(file, allMigrations);
	stores.push(store);
	const bad = (sql: string) =>
		expect(store.write((db) => db.query(sql).run())).rejects.toThrow();
	await bad("UPDATE knowledge_items SET retrieval = 'hidden' WHERE id = 'k1'");
	await bad(
		"UPDATE knowledge_items SET exceptions_json = 'not json' WHERE id = 'k1'",
	);
	await bad("UPDATE knowledge_items SET examples_json = '{' WHERE id = 'k1'");
	await bad("UPDATE knowledge_items SET situation = NULL WHERE id = 'k1'");
	await bad("UPDATE episodes SET retrieval = 'hidden' WHERE id = 'e1'");
	await bad(
		"INSERT INTO map_clusters (id, kind, name, state, member_digest, algorithm, created_at, updated_at) VALUES ('c', 'theme', '', 'pending', 'd', 'a', 't', 't')",
	); // a theme needs a handle
	await bad(
		"INSERT INTO map_clusters (id, kind, handle, name, state, member_digest, algorithm, created_at, updated_at) VALUES ('c', 'claim', 'th_x', '', 'pending', 'd', 'a', 't', 't')",
	); // a claim cluster has none
	await bad(
		"INSERT INTO map_edges (id, src_kind, src_id, relation, dst_kind, dst_id, origin, status, confidence, extractor_version, created_at, updated_at) VALUES ('e', 'knowledge', 'a', 'likes', 'knowledge', 'b', 'llm', 'active', 0.5, 'v', 't', 't')",
	);
	await bad(
		"INSERT INTO map_edges (id, src_kind, src_id, relation, dst_kind, dst_id, origin, status, confidence, extractor_version, created_at, updated_at) VALUES ('e', 'knowledge', 'a', 'about', 'knowledge', 'b', 'llm', 'active', 1.5, 'v', 't', 't')",
	);
	await bad(
		"INSERT INTO distill_assessments (owner_kind, owner_id, generality, origin, content_digest, prompt_version, created_at, updated_at) VALUES ('knowledge', 'k1', 'maybe', 'llm', 'd', 'p', 't', 't')",
	);
	await bad(
		"INSERT INTO distill_pair_judgments (a_id, b_id, a_digest, b_digest, verdict, resolution, created_at, updated_at) VALUES ('a', 'b', 'x', 'y', 'duplicate', 'won', 't', 't')",
	);
	await bad(
		"INSERT INTO distill_reviews (id, kind, subject_json, state, created_at) VALUES ('r', 'conflict', 'oops', 'open', 't')",
	);
	await bad(
		"INSERT INTO distill_llm_calls (id, stage, subject_ref, provider, model, prompt_version, input_digest, latency_ms, outcome, response_json, created_at) VALUES ('c', 'assess', 's', 'p', 'm', 'v', 'd', 1, 'ok', 'not json', 't')",
	);
	await bad(
		"INSERT INTO distill_runs (id, stage, params_json, state, started_at) VALUES ('r', 'assess', '{}', 'paused', 't')",
	);
});

test("a database that holds only the N1 migrations is accepted by the N2 code and backed up first", async () => {
	const file = await n1Database();
	const store = openStore(file, allMigrations);
	stores.push(store);
	expect(
		store.read((db) =>
			db.query("SELECT id FROM schema_migrations_v2 ORDER BY rowid").all(),
		),
	).toEqual(GOLDEN_IDS.map((id) => ({ id })));
	const backups = readdirSync(dirname(file)).filter((name) =>
		name.includes(".pre-migration-"),
	);
	expect(backups.length).toBe(1);
});
