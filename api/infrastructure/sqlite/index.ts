import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	mkdirSync,
	openSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { flock, LOCK_EX_NB, LOCK_UN, tryFlock } from "../flock";
import { getLogger } from "../logger";
import { backupBeforeMigration } from "./pre-migration-backup";

const log = getLogger("sqlite");

function isThenable(value: unknown): boolean {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	);
}

export class WriterOwnedError extends Error {
	constructor() {
		super("database_writer_owned");
	}
}
/** The writer lock could not be taken for a reason other than another holder (ENOTSUP, ENOLCK, ...). */
export class WriterLockError extends Error {
	constructor(public readonly errno: number) {
		super(`database_writer_lock_failed:${errno}`);
	}
}
/** The database file resolves (symlinks, case) into the v1 system or its backup. */
export class ReservedDatabasePathError extends Error {
	constructor() {
		super("path_reserved_by_legacy");
	}
}
/** An applied migration was edited afterwards. Carries the id only, never SQL. */
export class MigrationChecksumError extends Error {
	constructor(public readonly migrationId: string) {
		super(`migration_checksum_mismatch:${migrationId}`);
	}
}
/** The database holds a migration this code does not know (the database is newer than the code). */
export class MigrationUnknownAppliedError extends Error {
	constructor(public readonly migrationId: string) {
		super(`migration_unknown_applied:${migrationId}`);
	}
}
/**
 * A named migration. `id` is "<owner>/<4-digit sequence>[-slug]" and never changes once
 * deployed. `after` lists the migrations that must be applied first; every product migration
 * declares it (an empty list means none). When omitted, the migration depends on the
 * element before it in the list that was passed (the order the list was written in).
 */
export interface Migration {
	readonly id: string;
	readonly sql: string;
	readonly after?: readonly string[];
}
/**
 * `string` entries are a convenience for throw-away databases in tests: they receive the
 * positional id `adhoc/<4 digits>` and depend on the previous entry. Production code passes
 * `Migration` objects only.
 */
export type MigrationInput = Migration | string;

const adhocId = (index: number) =>
	`adhoc/${String(index + 1).padStart(4, "0")}`;
const sha256 = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Deterministic topological order: a migration is applied after everything it lists in
 * `after`; among the ready ones the earliest in the given list goes first, so a list that is
 * already a valid order is returned unchanged.
 */
export function orderMigrations(input: readonly MigrationInput[]): Migration[] {
	const list = input.map((entry, i) =>
		typeof entry === "string" ? { id: adhocId(i), sql: entry } : entry,
	);
	const index = new Map<string, number>();
	list.forEach((m, i) => {
		if (!m.id || !m.sql) throw new Error("missing_migration");
		if (index.has(m.id)) throw new Error(`migration_duplicate_id:${m.id}`);
		index.set(m.id, i);
	});
	const deps = list.map((m, i) => {
		const after = m.after ?? (i > 0 ? [list[i - 1]!.id] : []);
		for (const dep of after)
			if (!index.has(dep)) throw new Error(`migration_after_unknown:${m.id}`);
		return after;
	});
	const done = new Set<string>();
	const ordered: Migration[] = [];
	while (ordered.length < list.length) {
		const next = list.findIndex(
			(m, i) => !done.has(m.id) && deps[i]!.every((dep) => done.has(dep)),
		);
		if (next < 0) {
			const stuck = list.find((m) => !done.has(m.id));
			throw new Error(`migration_cycle:${stuck?.id}`);
		}
		done.add(list[next]!.id);
		ordered.push(list[next]!);
	}
	return ordered;
}

export class WriterBusyError extends Error {
	constructor() {
		super("database_writer_queue_full");
	}
}

/** Queued writer operations accepted before general writes are refused. */
const WRITER_PENDING_LIMIT = 64;
/** Extra slots only `reserved` writes may take once the general limit is reached. */
const WRITER_RESERVED_SLOTS = 32;

type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface SqliteStore {
	read<T>(operation: (db: Database) => T): T;
	/**
	 * Synchronous read transaction on the readonly reader: every SELECT in the
	 * callback sees one committed snapshot. Never opens a writer; a write
	 * attempted inside fails on the readonly connection.
	 */
	readSnapshot<T>(operation: (db: Database) => SyncResult<T>): T;
	/**
	 * Serialized writer transaction. `reserved` writes (queue lease renewal, settlement,
	 * recovery) may use the slots above the general limit, so a saturated writer cannot make a
	 * finished job lose its result.
	 */
	write<T>(
		operation: (db: Database) => T,
		options?: { reserved?: boolean },
	): Promise<T>;
	/** Serialized writer operation outside a transaction (checkpoint / incremental vacuum only). */
	maintenance?<T>(operation: (db: Database) => T): Promise<T>;
	onCommit(listener: () => void): () => void;
	close(): Promise<void>;
}

/** DB, WAL and SHM are owner-only. A permissive parent directory is reported, not fatal (existing installs). */
function restrictPermissions(canonical: string) {
	for (const file of [canonical, `${canonical}-wal`, `${canonical}-shm`])
		if (existsSync(file)) chmodSync(file, 0o600);
	try {
		if (statSync(dirname(canonical)).mode & 0o077)
			log.warn("sqlite.directory_permissive", {
				reason: "directory_permissive",
			});
	} catch {
		/* directory vanished; opening would already have failed */
	}
}

/** `realpath` of the deepest existing ancestor, with the not-yet-existing rest appended. */
function resolveExisting(path: string): string {
	let current = resolve(path);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync.native(current), ...rest);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.unshift(basename(current));
			current = parent;
		}
	}
}

function reservedRoots(): string[] {
	const home = homedir();
	return [
		join(home, "Code", "contextStill-legacy"),
		join(home, "Library", "Application Support", "contextStill"),
		join(home, "Code", "contextStill-db-backup-20261029"),
	].flatMap((root) => [root, resolveExisting(root)]);
}

function isUnder(path: string, root: string): boolean {
	const a = path.toLowerCase();
	const b = root.toLowerCase();
	return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}

/**
 * The file this database really is: symlinks followed and, for an existing file, the
 * spelling (case) the file system stores. Rejects anything that lands in a reserved root.
 */
function canonicalDatabasePath(requested: string): string {
	const dir = resolveExisting(dirname(requested));
	const byName = join(dir, basename(requested));
	const real = existsSync(byName) ? realpathSync.native(byName) : byName;
	const roots = reservedRoots();
	for (const candidate of [dir, real])
		if (roots.some((root) => isUnder(candidate, root)))
			throw new ReservedDatabasePathError();
	return real;
}

export function openStore(
	filename: string,
	migrations: readonly MigrationInput[],
	options: {
		incrementalVacuum?: boolean;
	} = {},
): SqliteStore {
	if (filename === ":memory:")
		throw new Error("persistent_database_path_required");
	const requested = resolve(filename);
	// Checked before anything is created: a reserved location is never touched.
	canonicalDatabasePath(requested);
	// A directory this call creates is owner-only; an existing one keeps its mode.
	mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
	const canonical = canonicalDatabasePath(requested);
	const lockFd = openSync(
		`${canonical}.owner.lock`,
		constants.O_CREAT | constants.O_RDWR,
		0o600,
	);
	try {
		fchmodSync(lockFd, 0o600);
		const locked = tryFlock(lockFd, LOCK_EX_NB);
		if (!locked.ok) {
			if (locked.wouldBlock) throw new WriterOwnedError();
			throw new WriterLockError(locked.errno);
		}
	} catch (error) {
		closeSync(lockFd);
		throw error;
	}
	let writer: Database | undefined;
	let reader: Database | undefined;
	try {
		const newDatabase = !existsSync(canonical);
		const migrationWriter = new Database(canonical, { create: true });
		writer = migrationWriter;
		if (newDatabase && options.incrementalVacuum)
			migrationWriter.exec("PRAGMA auto_vacuum=INCREMENTAL");
		migrationWriter.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		const ordered = orderMigrations(migrations);
		const byId = new Map(ordered.map((m) => [m.id, m]));
		migrationWriter.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations_v2 (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		const applied = new Map(
			(
				migrationWriter
					.query("SELECT id, checksum FROM schema_migrations_v2")
					.all() as { id: string; checksum: string }[]
			).map((x) => [x.id, x.checksum]),
		);
		// A newer database than this code: refuse before touching anything.
		for (const id of applied.keys())
			if (!byId.has(id)) throw new MigrationUnknownAppliedError(id);
		for (const { id, sql } of ordered) {
			const stored = applied.get(id);
			if (stored !== undefined && stored !== sha256(sql))
				throw new MigrationChecksumError(id);
		}
		// An existing database gets a consistency check and a snapshot before its schema changes.
		if (applied.size > 0 && ordered.some((m) => !applied.has(m.id)))
			backupBeforeMigration(migrationWriter, canonical);
		for (const { id, sql } of ordered) {
			if (applied.has(id)) continue;
			migrationWriter.transaction(() => {
				migrationWriter.exec(sql);
				migrationWriter
					.query(
						"INSERT INTO schema_migrations_v2 (id, checksum, applied_at) VALUES (?, ?, ?)",
					)
					.run(id, sha256(sql), new Date().toISOString());
			})();
		}
		restrictPermissions(canonical);
		reader = new Database(canonical, { readonly: true });
		reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
	} catch (error) {
		reader?.close();
		writer?.close();
		flock(lockFd, LOCK_UN);
		closeSync(lockFd);
		throw error;
	}
	const w = writer;
	const r = reader;
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;
	let closing = false;
	const listeners = new Set<() => void>();
	const changes = w.query<{ count: number }, []>(
		"SELECT total_changes() AS count",
	);
	function serialized<T>(operation: () => T, reserved = false): Promise<T> {
		if (closing) return Promise.reject(new Error("database_closing"));
		if (
			pending >=
			WRITER_PENDING_LIMIT + (reserved ? WRITER_RESERVED_SLOTS : 0)
		)
			return Promise.reject(new WriterBusyError());
		pending++;
		const task = tail.then(operation);
		tail = task
			.catch(() => {})
			.finally(() => {
				pending--;
			});
		return task;
	}
	return {
		read: (operation) => {
			if (closing) throw new Error("database_closing");
			return operation(r);
		},
		readSnapshot: (operation) => {
			if (closing) throw new Error("database_closing");
			return r.transaction(() => {
				const value = operation(r);
				if (isThenable(value)) {
					void Promise.resolve(value).catch(() => {});
					throw new Error("async_snapshot_callback");
				}
				return value;
			})();
		},
		write: (operation, options) => {
			return serialized(() => {
				const before = changes.get()?.count;
				const result = w.transaction(() => {
					const value = operation(w);
					if (isThenable(value)) {
						void Promise.resolve(value).catch(() => {});
						throw new Error("async_write_callback");
					}
					return value;
				})();
				// Only committed mutations notify. Idle worker scans and rollbacks do not.
				if (changes.get()?.count !== before)
					for (const listener of listeners) {
						try {
							listener();
						} catch {
							// Notification failures cannot turn a committed write into a failure.
						}
					}
				return result;
			}, options?.reserved);
		},
		maintenance: (operation) =>
			serialized(() => {
				const value = operation(w);
				if (isThenable(value)) {
					void Promise.resolve(value).catch(() => {});
					throw new Error("async_maintenance_callback");
				}
				return value;
			}),
		onCommit(listener) {
			if (closing) throw new Error("database_closing");
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async close() {
			if (closing) return;
			closing = true;
			await tail;
			listeners.clear();
			r.close();
			w.close();
			flock(lockFd, LOCK_UN);
			closeSync(lockFd);
		},
	};
}
