import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./index";

test("commit notifications see persisted state, exclude idle scans/rollback, and cannot fail writes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-commit-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		"CREATE TABLE items(value TEXT)",
	]);
	const observed: unknown[] = [];
	const stop = store.onCommit(() =>
		observed.push(
			store.read((db) => db.query("SELECT value FROM items").all()),
		),
	);
	store.onCommit(() => {
		throw new Error("listener_failed");
	});
	try {
		await store.write((db) => db.query("SELECT value FROM items").all());
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items VALUES('rolled back')").run();
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await store.write((db) =>
			db.query("UPDATE items SET value='none' WHERE value='missing'").run(),
		);
		expect(observed).toHaveLength(0);
		await store.write((db) =>
			db.query("INSERT INTO items VALUES('saved')").run(),
		);
		expect(observed).toEqual([[{ value: "saved" }]]);
		stop();
		await store.write((db) =>
			db.query("INSERT INTO items VALUES('later')").run(),
		);
		expect(observed).toHaveLength(1);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cache maintenance runs in writer order outside a transaction and does not notify commits", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-maintenance-"));
	const store = openStore(
		join(dir, "db.sqlite3"),
		["CREATE TABLE items(value TEXT)"],
		{ incrementalVacuum: true },
	);
	let notifications = 0;
	store.onCommit(() => notifications++);
	try {
		const write = store.write((db) =>
			db.query("INSERT INTO items VALUES('saved')").run(),
		);
		const maintain = store.maintenance!((db) => {
			expect(db.inTransaction).toBe(false);
			expect(db.query("SELECT value FROM items").all()).toEqual([
				{ value: "saved" },
			]);
			expect(
				db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()!
					.auto_vacuum,
			).toBe(2);
			db.exec(
				"PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(256)",
			);
		});
		await write;
		await maintain;
		expect(notifications).toBe(1);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
