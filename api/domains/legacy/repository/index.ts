import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import type { LegacyTable } from "../contracts";

export { migrations } from "./migrations";

export function getImportMap(
	db: Database,
	table: LegacyTable,
	legacyId: string,
): { targetTable: string; targetId: string; legacyDigest: string } | null {
	const row = db
		.query(
			`SELECT target_table, target_id, legacy_digest FROM legacy_import_map
			 WHERE legacy_table = ? AND legacy_id = ?`,
		)
		.get(table, legacyId) as {
		target_table: string;
		target_id: string;
		legacy_digest: string;
	} | null;
	return row
		? {
				targetTable: row.target_table,
				targetId: row.target_id,
				legacyDigest: row.legacy_digest,
			}
		: null;
}

export function putImportMap(
	db: Database,
	row: {
		legacyTable: LegacyTable;
		legacyId: string;
		targetTable: string;
		targetId: string;
		legacyDigest: string;
		importRunId: string;
		importedAt: string;
	},
): void {
	db.query(
		`INSERT INTO legacy_import_map
		   (legacy_table, legacy_id, target_table, target_id, legacy_digest, import_run_id, imported_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(legacy_table, legacy_id) DO UPDATE SET
		   target_table = excluded.target_table,
		   target_id = excluded.target_id,
		   legacy_digest = excluded.legacy_digest,
		   import_run_id = excluded.import_run_id,
		   imported_at = excluded.imported_at`,
	).run(
		row.legacyTable,
		row.legacyId,
		row.targetTable,
		row.targetId,
		row.legacyDigest,
		row.importRunId,
		row.importedAt,
	);
}

export function startImportRun(
	db: Database,
	run: {
		id: string;
		importerVersion: string;
		snapshotFingerprint: string;
		startedAt: string;
	},
): void {
	db.query(
		`INSERT INTO legacy_import_runs
		   (id, importer_version, snapshot_fingerprint, status, started_at)
		 VALUES (?, ?, ?, 'running', ?)`,
	).run(run.id, run.importerVersion, run.snapshotFingerprint, run.startedAt);
}

export function finishImportRun(
	db: Database,
	id: string,
	status: "succeeded" | "failed",
	report: unknown,
	finishedAt: string,
): void {
	db.query(
		`UPDATE legacy_import_runs SET status = ?, report_json = ?, finished_at = ? WHERE id = ?`,
	).run(status, canonicalJson(report), finishedAt, id);
}

const LEGACY_TABLES: ReadonlySet<string> = new Set<LegacyTable>([
	"vibe_memories",
	"sources",
	"source_fragments",
	"episode_cards",
	"knowledge_items",
	"knowledge_usage_events",
	"knowledge_items_vec_fallback",
]);

/** `legacy:<table>:<legacy id>` to the id it was imported as; null when never imported. */
export function resolveLegacyRef(
	db: Database,
	ref: string,
): { targetTable: string; targetId: string } | null {
	const match = /^legacy:([a-z_]+):(.+)$/.exec(ref);
	if (!match || !LEGACY_TABLES.has(match[1]!)) return null;
	const mapped = getImportMap(db, match[1] as LegacyTable, match[2]!);
	return mapped
		? { targetTable: mapped.targetTable, targetId: mapped.targetId }
		: null;
}
