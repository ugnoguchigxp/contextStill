import type { Database } from "bun:sqlite";
import type { UpsertResult } from "../../../infrastructure/scope";
import type { LegacyImportDeps, LegacyTable, TableReport } from "../contracts";
import { getImportMap, putImportMap } from "../repository";

/** One legacy row, already converted: where it goes and how to write it. */
export interface Plan {
	legacyId: string;
	/** `sha256Hex(IMPORTER_VERSION + "|" + canonicalJson(legacy row))`. */
	digest: string;
	/** Never rewritten once imported: a changed legacy row is only counted. */
	immutable?: boolean;
	/** Digests of earlier rule versions that mean "same row" (only for `immutable` plans). */
	previousDigests?: string[];
	targetTable: string;
	targetId: string;
	apply(db: Database): UpsertResult;
}
export interface Skip {
	skip: string;
}
export type Planned = Plan | Skip;

export interface RunnerContext {
	deps: LegacyImportDeps;
	runId: string;
	dryRun: boolean;
	batchSize: number;
	importedAt: string;
	/** `<target table>|<target id>` to the legacy table that claimed it in this run. */
	claimed: Map<string, string>;
	/** Rows of the map the snapshot no longer has, per table (counted, never deleted). */
	vanished: Partial<Record<LegacyTable, number>>;
}

export function emptyTableReport(): TableReport {
	return {
		legacyCount: 0,
		inserted: 0,
		updated: 0,
		unchanged: 0,
		skipped: 0,
		skippedReasons: {},
	};
}

const isSkip = (planned: Planned): planned is Skip => "skip" in planned;

function collides(
	ctx: RunnerContext,
	db: Database | null,
	table: LegacyTable,
	plan: Plan,
): boolean {
	const key = `${plan.targetTable}|${plan.targetId}`;
	const claimedBy = ctx.claimed.get(key);
	if (claimedBy !== undefined && claimedBy !== table) return true;
	ctx.claimed.set(key, table);
	if (!db) return false;
	const other = db
		.query(
			`SELECT legacy_table FROM legacy_import_map
			 WHERE target_table = ? AND target_id = ? AND legacy_table <> ? LIMIT 1`,
		)
		.get(plan.targetTable, plan.targetId, table);
	return other !== null;
}

type Outcome = UpsertResult | "immutable_changed";

/** Primary key lookup per target table (the names are internal constants, never input). */
const TARGET_PRESENCE: Record<string, string> = {
	source_records: "SELECT 1 FROM source_records WHERE id = ?",
	source_fragments: "SELECT 1 FROM source_fragments WHERE id = ?",
	episodes: "SELECT 1 FROM episodes WHERE id = ?",
	knowledge_items: "SELECT 1 FROM knowledge_items WHERE id = ?",
	usage_events: "SELECT 1 FROM usage_events WHERE id = ?",
	vectors:
		"SELECT 1 FROM vectors WHERE owner_kind = 'knowledge' AND owner_id = ?",
};

/** Whether the row the map points at is still there (it may have been deleted since). */
function targetPresent(db: Database, plan: Plan): boolean {
	const sql = TARGET_PRESENCE[plan.targetTable];
	return sql === undefined || db.query(sql).get(plan.targetId) !== null;
}

function flush(
	ctx: RunnerContext,
	table: LegacyTable,
	report: TableReport,
	batch: Plan[],
	matched: { count: number; created: number },
): Promise<void> | void {
	const classify = (db: Database, plan: Plan): Outcome => {
		const existing = getImportMap(db, table, plan.legacyId);
		if (existing) matched.count++;
		const present = existing ? targetPresent(db, plan) : false;
		const sameDigest = existing?.legacyDigest === plan.digest;
		if (sameDigest && present) return "unchanged";
		if (existing && present && plan.immutable) {
			if (!plan.previousDigests?.includes(existing.legacyDigest))
				return "immutable_changed";
			// Same row under an older rule version: only the map's digest moves on.
			if (!ctx.dryRun)
				putImportMap(db, {
					legacyTable: table,
					legacyId: plan.legacyId,
					targetTable: plan.targetTable,
					targetId: plan.targetId,
					legacyDigest: plan.digest,
					importRunId: ctx.runId,
					importedAt: ctx.importedAt,
				});
			return "unchanged";
		}
		if (!existing && !ctx.dryRun) matched.created++;
		if (collides(ctx, db, table, plan)) throw new Error("id_collision");
		if (ctx.dryRun) return existing && present ? "updated" : "inserted";
		const result = plan.apply(db);
		putImportMap(db, {
			legacyTable: table,
			legacyId: plan.legacyId,
			targetTable: plan.targetTable,
			targetId: plan.targetId,
			legacyDigest: plan.digest,
			importRunId: ctx.runId,
			importedAt: ctx.importedAt,
		});
		return result;
	};
	const count = (results: Outcome[]) => {
		for (const result of results) {
			if (result === "immutable_changed") {
				report.skipped++;
				report.skippedReasons.usage_immutable_changed =
					(report.skippedReasons.usage_immutable_changed ?? 0) + 1;
			} else report[result]++;
		}
	};
	if (ctx.dryRun) {
		count(ctx.deps.store.read((db) => batch.map((plan) => classify(db, plan))));
		return;
	}
	return ctx.deps.store
		.write((db) => batch.map((plan) => classify(db, plan)))
		.then(count);
}

/**
 * Walks the snapshot rows, plans each one, and writes the plans in batches of `batchSize`
 * (one `store.write` per batch, the previous batch awaited before the next is read).
 */
export async function runTable<Row>(
	ctx: RunnerContext,
	table: LegacyTable,
	rows: Iterable<Row>,
	plan: (row: Row) => Planned,
): Promise<TableReport> {
	const report = emptyTableReport();
	const matched = { count: 0, created: 0 };
	let batch: Plan[] = [];
	for (const row of rows) {
		report.legacyCount++;
		const planned = plan(row);
		if (isSkip(planned)) {
			report.skipped++;
			report.skippedReasons[planned.skip] =
				(report.skippedReasons[planned.skip] ?? 0) + 1;
			continue;
		}
		batch.push(planned);
		if (batch.length >= ctx.batchSize) {
			await flush(ctx, table, report, batch, matched);
			batch = [];
		}
	}
	if (batch.length > 0) await flush(ctx, table, report, batch, matched);
	const mapped = ctx.deps.store.read(
		(db) =>
			(
				db
					.query(
						"SELECT count(*) AS n FROM legacy_import_map WHERE legacy_table = ?",
					)
					.get(table) as { n: number }
			).n,
	);
	// Map rows this very run created are in `mapped` but were not matched.
	ctx.vanished[table] = Math.max(0, mapped - matched.count - matched.created);
	ctx.deps.log(
		`legacy-import ${table}: count=${report.legacyCount} inserted=${report.inserted} updated=${report.updated} unchanged=${report.unchanged} skipped=${report.skipped}`,
	);
	return report;
}
