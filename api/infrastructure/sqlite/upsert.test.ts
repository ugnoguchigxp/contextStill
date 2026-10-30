import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { upsertRow } from "./upsert";

function fresh() {
	const db = new Database(":memory:");
	db.exec(
		`CREATE TABLE t (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, v TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
		 CREATE VIRTUAL TABLE t_fts USING fts5(v, content='t', content_rowid='seq', tokenize='trigram');`,
	);
	return db;
}
const write = (db: Database, v: string, at: string) =>
	upsertRow(db, {
		table: "t",
		key: { id: "a" },
		values: { v },
		insertOnly: { created_at: at },
		touch: { updated_at: at },
		revision: true,
	});

test("insert, update and unchanged are told apart; seq and created_at stay", () => {
	const db = fresh();
	expect(write(db, "one", "t1")).toBe("inserted");
	const first = db.query("SELECT * FROM t").get() as Record<string, unknown>;
	expect(write(db, "one", "t2")).toBe("unchanged");
	expect(db.query("SELECT * FROM t").get()).toEqual(first);
	expect(write(db, "two", "t3")).toBe("updated");
	expect(db.query("SELECT * FROM t").get()).toEqual({
		...first,
		v: "two",
		revision: 2,
		updated_at: "t3",
	});
});

test("a constraint other than the key still fails loudly", () => {
	const db = fresh();
	expect(() =>
		upsertRow(db, {
			table: "t",
			key: { id: "a" },
			values: { v: "x" },
			insertOnly: { created_at: null as unknown as string },
			touch: { updated_at: "t" },
		}),
	).toThrow();
});
