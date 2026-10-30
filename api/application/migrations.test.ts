import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		"legacy_import_map",
		"legacy_import_runs",
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
