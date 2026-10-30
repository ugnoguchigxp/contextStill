import type { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { getLogger } from "../logger";

const log = getLogger("sqlite");

/** The existing database fails SQLite's own consistency check; migrating it would only hide damage. */
export class DatabaseIntegrityError extends Error {
	constructor() {
		super("database_integrity_check_failed");
	}
}

/**
 * Before pending migrations change the schema of an existing database: check it, then
 * `VACUUM INTO <db>.pre-migration-<UTC time>.sqlite3` (owner-only). Returns the path.
 */
export function backupBeforeMigration(
	db: Database,
	canonical: string,
	now: () => Date = () => new Date(),
): string {
	const rows = db.query("PRAGMA integrity_check").all() as Record<
		string,
		unknown
	>[];
	if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok")
		throw new DatabaseIntegrityError();
	const stamp = now().toISOString().replace(/[-:.]/g, "");
	let target = `${canonical}.pre-migration-${stamp}.sqlite3`;
	for (let n = 1; existsSync(target); n++)
		target = `${canonical}.pre-migration-${stamp}-${n}.sqlite3`;
	// Create the copy private from the start; chmod alone would leave a window.
	const mask = process.umask(0o077);
	try {
		db.query("VACUUM INTO ?").run(target);
	} finally {
		process.umask(mask);
	}
	chmodSync(target, 0o600);
	log.info("sqlite.pre_migration_backup", { reason: "pending_migrations" });
	return target;
}
