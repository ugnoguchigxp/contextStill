import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	MigrationChecksumError,
	MigrationUnknownAppliedError,
	openStore,
	ReservedDatabasePathError,
	orderMigrations,
	WriterOwnedError,
} from "./index";

const dirs: string[] = [];
const tempDb = () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-sqlite-"));
	dirs.push(dir);
	return { dir, file: join(dir, "db.sqlite3") };
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const init = {
	id: "t/0001-init",
	after: [],
	sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)",
};

test("a second openStore on the same path is refused while the first is open", async () => {
	const { file } = tempDb();
	const first = openStore(file, [init]);
	expect(() => openStore(file, [init])).toThrow(WriterOwnedError);
	await first.close();
	const again = openStore(file, [init]);
	await again.close();
});

test("writes are serialized in call order and each is atomic", async () => {
	const { file } = tempDb();
	const store = openStore(file, [init]);
	try {
		const order: number[] = [];
		const results = await Promise.all(
			[1, 2, 3, 4, 5].map((n) =>
				store.write((db) => {
					order.push(n);
					db.query("INSERT INTO t (v) VALUES (?)").run(String(n));
					return n;
				}),
			),
		);
		expect(results).toEqual([1, 2, 3, 4, 5]);
		expect(order).toEqual([1, 2, 3, 4, 5]);
		await expect(
			store.write((db) => {
				db.query("INSERT INTO t (v) VALUES ('boom')").run();
				throw new Error("rollback_me");
			}),
		).rejects.toThrow("rollback_me");
		expect(
			store.read((db) => db.query("SELECT count(*) AS n FROM t").get()),
		).toEqual({ n: 5 });
	} finally {
		await store.close();
	}
});

test("editing an applied migration is refused with migration_checksum_mismatch", async () => {
	const { file } = tempDb();
	const store = openStore(file, [init]);
	await store.close();
	expect(() =>
		openStore(file, [{ ...init, sql: `${init.sql}; -- edited` }]),
	).toThrow("migration_checksum_mismatch");
	expect(() =>
		openStore(file, [{ ...init, sql: `${init.sql}; -- edited` }]),
	).toThrow(MigrationChecksumError);
	// The failed attempts released the lock.
	const ok = openStore(file, [init]);
	await ok.close();
});

test("a database newer than the code is refused", async () => {
	const { file } = tempDb();
	const store = openStore(file, [
		init,
		{ id: "t/0002-more", after: ["t/0001-init"], sql: "CREATE TABLE u (id)" },
	]);
	await store.close();
	expect(() => openStore(file, [init])).toThrow(MigrationUnknownAppliedError);
});

test("adding a migration to an existing database snapshots it first", async () => {
	const { dir, file } = tempDb();
	const first = openStore(file, [init]);
	await first.write((db) => db.query("INSERT INTO t (v) VALUES ('x')").run());
	await first.close();
	const second = openStore(file, [
		init,
		{ id: "t/0002-more", after: ["t/0001-init"], sql: "CREATE TABLE u (id)" },
	]);
	await second.close();
	const backups = readdirSync(dir).filter((n) => n.includes(".pre-migration-"));
	expect(backups).toHaveLength(1);
	expect(backups[0]).toMatch(/\.pre-migration-.*\.sqlite3$/);
});

test("a fresh database is not snapshotted", async () => {
	const { dir, file } = tempDb();
	const store = openStore(file, [init]);
	await store.close();
	expect(readdirSync(dir).some((n) => n.includes(".pre-migration-"))).toBe(
		false,
	);
});

test("migrations are ordered topologically and stably", () => {
	const m = (id: string, after: string[]) => ({ id, sql: "SELECT 1", after });
	expect(
		orderMigrations([m("a/1", []), m("b/1", ["c/1"]), m("c/1", [])]).map(
			(x) => x.id,
		),
	).toEqual(["a/1", "c/1", "b/1"]);
	expect(() => orderMigrations([m("a/1", ["a/2"]), m("a/2", ["a/1"])])).toThrow(
		"migration_cycle",
	);
	expect(() => orderMigrations([m("a/1", ["zzz"])])).toThrow(
		"migration_after_unknown",
	);
});

test("an in-memory database is refused", () => {
	expect(() => openStore(":memory:", [init])).toThrow(
		"persistent_database_path_required",
	);
});

test("a database directory this call creates is owner-only; an existing one keeps its mode", async () => {
	const { dir } = tempDb();
	chmodSync(dir, 0o755);
	const fresh = join(dir, "a", "b", "db.sqlite3");
	const store = openStore(fresh, [init]);
	await store.close();
	expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
	expect(statSync(join(dir, "a", "b")).mode & 0o777).toBe(0o700);
	expect(statSync(dir).mode & 0o777).toBe(0o755);
});

test("a database reached through a symlink into the v1 locations is refused before anything is created", () => {
	const legacy = join(homedir(), "Code", "contextStill-legacy");
	if (!existsSync(legacy)) return;
	const { dir } = tempDb();
	const link = join(dir, "link");
	symlinkSync(legacy, link);
	const file = join(link, "new-subdir", "db.sqlite3");
	expect(() => openStore(file, [init])).toThrow(ReservedDatabasePathError);
	expect(existsSync(join(legacy, "new-subdir"))).toBe(false);
});

test("the writer lock is shared between spellings of one file", async () => {
	const { dir, file } = tempDb();
	const link = join(dir, "alias");
	mkdirSync(join(dir, "real"));
	symlinkSync(join(dir, "real"), link);
	const first = openStore(join(link, "db.sqlite3"), [init]);
	try {
		expect(() => openStore(join(dir, "real", "db.sqlite3"), [init])).toThrow(
			WriterOwnedError,
		);
		// A case-insensitive file system names one file by two spellings.
		if (existsSync(join(dir, "real", "DB.SQLITE3")))
			expect(() => openStore(join(dir, "real", "DB.SQLITE3"), [init])).toThrow(
				WriterOwnedError,
			);
	} finally {
		await first.close();
	}
	expect(file).toBeTruthy();
});
