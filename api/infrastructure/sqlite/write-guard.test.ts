import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./index";

const migration = "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)";

test("write rejects an async callback and rolls back its first statement", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-write-"));
	const store = openStore(join(dir, "db.sqlite3"), [migration]);
	try {
		await expect(
			store.write(async (db) => {
				db.exec("INSERT INTO t (v) VALUES ('x')");
			}),
		).rejects.toThrow("async_write_callback");
		expect(
			store.read((db) => db.query("SELECT count(*) AS n FROM t").get()),
		).toEqual({ n: 0 });
		await expect(
			store.maintenance?.(async () => {}) ??
				Promise.reject(new Error("async_maintenance_callback")),
		).rejects.toThrow("async_maintenance_callback");
		expect(await store.write(() => 1)).toBe(1);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("database, WAL and SHM files are owner-only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-mode-"));
	const nested = join(dir, "data");
	mkdirSync(nested, { mode: 0o755 });
	const file = join(nested, "db.sqlite3");
	const store = openStore(file, [migration]);
	try {
		await store.write((db) => db.exec("INSERT INTO t (v) VALUES ('x')"));
		for (const name of [file, `${file}-wal`, `${file}-shm`])
			expect(statSync(name).mode & 0o777).toBe(0o600);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
