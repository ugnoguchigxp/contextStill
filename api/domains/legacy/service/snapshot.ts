import { Database } from "bun:sqlite";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";

/** The live database of the previous version. It is never opened. */
export function legacyLiveDbPath(): string {
	return join(
		homedir(),
		"Code/contextStill-legacy/data/context-still-core.sqlite",
	);
}

function canonicalPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		try {
			return join(realpathSync(dirname(absolute)), basename(absolute));
		} catch {
			return absolute;
		}
	}
}

function sameFile(a: string, b: string): boolean {
	if (canonicalPath(a) === canonicalPath(b)) return true;
	if (!existsSync(a) || !existsSync(b)) return false;
	const sa = statSync(a);
	const sb = statSync(b);
	return sa.dev === sb.dev && sa.ino === sb.ino;
}

/** Refuses the live legacy database and the database being imported into. */
export function assertSnapshotAllowed(
	snapshotPath: string,
	dbPath: string,
): void {
	if (
		sameFile(snapshotPath, legacyLiveDbPath()) ||
		sameFile(snapshotPath, dbPath)
	)
		throw new Error("snapshot_path_forbidden");
}

export function openSnapshot(snapshotPath: string): Database {
	if (!existsSync(snapshotPath)) throw new Error("snapshot_not_found");
	// immutable=1 ignores the WAL, so a snapshot with unmerged WAL data would be read stale.
	const real = realpathSync(snapshotPath);
	const wal = `${real}-wal`;
	if (existsSync(wal) && statSync(wal).size > 0)
		throw new Error("snapshot_has_wal");
	const path = real
		.replaceAll("%", "%25")
		.replaceAll("?", "%3f")
		.replaceAll("#", "%23");
	return new Database(`file:${path}?mode=ro&immutable=1`, { readonly: true });
}

/** Cheap identity of a snapshot: the multi-GB file itself is never hashed. */
export function snapshotFingerprint(
	db: Database,
	snapshotPath: string,
): string {
	const stat = statSync(realpathSync(snapshotPath));
	const pageCount = (
		db.query("PRAGMA page_count").get() as { page_count: number }
	).page_count;
	const schema = db
		.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
		.all();
	return sha256Hex(
		canonicalJson({
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			pageCount,
			schemaSha: sha256Hex(canonicalJson(schema)),
		}),
	);
}
