import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { vectorSpaceKey } from "../../../infrastructure/vector";
import type {
	LegacyImportArgs,
	LegacyImportDeps,
	LegacyImportReport,
	LegacyTable,
} from "../contracts";
import { finishImportRun, startImportRun } from "../repository";
import { loadProvenanceIndex } from "./provenance";
import { emptyTableReport, runTable, type RunnerContext } from "./runner";
import {
	assertSnapshotAllowed,
	openSnapshot,
	snapshotFingerprint,
} from "./snapshot";
import {
	EPISODE_REFS_SQL,
	EPISODES_SQL,
	type EpisodeRefRow,
	type EpisodeRow,
	emptyState,
	FRAGMENTS_SQL,
	type FragmentRow,
	IMPORTER_VERSION,
	KNOWLEDGE_SQL,
	type KnowledgeRow,
	planEpisode,
	planFragment,
	planKnowledge,
	planSource,
	planUsage,
	planVector,
	planVibe,
	SOURCES_SQL,
	sourceIsImportable,
	type SourceRow,
	USAGE_SQL,
	type UsageRow,
	VECTORS_SQL,
	type VectorRow,
	VIBE_SQL,
	type VibeRow,
} from "./tables";
import { LEGACY_VECTOR_SPACE } from "./vector-space";

export const IMPORT_ORDER: readonly LegacyTable[] = [
	"vibe_memories",
	"sources",
	"source_fragments",
	"episode_cards",
	"knowledge_items",
	"knowledge_usage_events",
	"knowledge_items_vec_fallback",
];

function rowsOf<Row>(db: Database, sql: string): Iterable<Row> {
	return db.query(sql).iterate() as Iterable<Row>;
}

/** Ids of the snapshot sources `planSource` takes (fragments of the others are skipped). */
function importableSourceIds(db: Database): Set<string> {
	const ids = new Set<string>();
	for (const row of db
		.query("SELECT id, source_kind, scope FROM sources")
		.iterate() as Iterable<{ id: string; source_kind: string; scope: string }>)
		if (sourceIsImportable(row.source_kind, row.scope)) ids.add(row.id);
	return ids;
}

function groupRefs(db: Database): Map<string, EpisodeRefRow[]> {
	const grouped = new Map<string, EpisodeRefRow[]>();
	for (const ref of rowsOf<EpisodeRefRow>(db, EPISODE_REFS_SQL)) {
		const list = grouped.get(ref.episode_card_id);
		if (list) list.push(ref);
		else grouped.set(ref.episode_card_id, [ref]);
	}
	return grouped;
}

function safeErrorSummary(error: unknown): string {
	if (error instanceof Error && /^[a-z0-9_:]{1,80}$/.test(error.message))
		return error.message;
	return error instanceof Error ? error.name : "error";
}

/**
 * Imports the legacy snapshot (read only) into the new tables. Idempotent: a row whose
 * `legacy_digest` is already in `legacy_import_map` is not touched.
 */
export async function runLegacyImport(
	deps: LegacyImportDeps,
	args: LegacyImportArgs,
): Promise<LegacyImportReport> {
	assertSnapshotAllowed(args.snapshotPath, deps.dbPath);
	const snapshot = openSnapshot(args.snapshotPath);
	try {
		return await importFrom(snapshot, deps, args);
	} finally {
		snapshot.close();
	}
}

async function importFrom(
	snapshot: Database,
	deps: LegacyImportDeps,
	args: LegacyImportArgs,
): Promise<LegacyImportReport> {
	const nowIso = deps.now().toISOString();
	const runId = randomUUID();
	const fingerprint = snapshotFingerprint(snapshot, args.snapshotPath);
	const spaceKey = vectorSpaceKey({
		modelId: LEGACY_VECTOR_SPACE.model.id,
		revision: LEGACY_VECTOR_SPACE.model.revision,
		artifactDigest: LEGACY_VECTOR_SPACE.model.artifactDigest,
		dimension: LEGACY_VECTOR_SPACE.dimension,
	});
	const state = emptyState(nowIso, spaceKey);
	const ctx: RunnerContext = {
		deps,
		runId,
		dryRun: args.dryRun,
		batchSize: Math.max(1, Math.floor(args.batchSize)),
		importedAt: nowIso,
		claimed: new Map(),
		vanished: {},
	};
	const wanted = (table: LegacyTable) =>
		!args.only || args.only.includes(table);
	const tables = Object.fromEntries(
		IMPORT_ORDER.map((table) => [table, emptyTableReport()]),
	) as LegacyImportReport["tables"];

	if (!args.dryRun)
		await deps.store.write((db) =>
			startImportRun(db, {
				id: runId,
				importerVersion: IMPORTER_VERSION,
				snapshotFingerprint: fingerprint,
				startedAt: nowIso,
			}),
		);
	const buildReport = (): LegacyImportReport => ({
		runId,
		importerVersion: IMPORTER_VERSION,
		snapshotFingerprint: fingerprint,
		dryRun: args.dryRun,
		tables,
		provenance: state.provenance,
		time: state.time,
		vectors: state.vectors,
	});
	const notes = () => ({
		vanishedFromLegacy: ctx.vanished,
		draft: state.draft,
	});
	try {
		const provenance = loadProvenanceIndex(snapshot);
		for (const table of IMPORT_ORDER) {
			if (!wanted(table)) continue;
			switch (table) {
				case "vibe_memories":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<VibeRow>(snapshot, VIBE_SQL),
						planVibe(state),
					);
					break;
				case "sources":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<SourceRow>(snapshot, SOURCES_SQL),
						planSource(state),
					);
					break;
				case "source_fragments":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<FragmentRow>(snapshot, FRAGMENTS_SQL),
						planFragment(state, importableSourceIds(snapshot)),
					);
					break;
				case "episode_cards":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<EpisodeRow>(snapshot, EPISODES_SQL),
						planEpisode(state, groupRefs(snapshot), provenance.vibeIds),
					);
					break;
				case "knowledge_items":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<KnowledgeRow>(snapshot, KNOWLEDGE_SQL),
						planKnowledge({ state, provenance }),
					);
					break;
				case "knowledge_usage_events":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<UsageRow>(snapshot, USAGE_SQL),
						planUsage(state),
					);
					break;
				case "knowledge_items_vec_fallback":
					tables[table] = await runTable(
						ctx,
						table,
						rowsOf<VectorRow>(snapshot, VECTORS_SQL),
						planVector(state),
					);
					break;
			}
		}
	} catch (error) {
		if (!args.dryRun)
			await deps.store
				.write((db) =>
					finishImportRun(
						db,
						runId,
						"failed",
						{ error: safeErrorSummary(error), tables },
						deps.now().toISOString(),
					),
				)
				.catch(() => undefined);
		throw error;
	}
	const report = buildReport();
	deps.log(
		`legacy-import notes: ${JSON.stringify({ ...notes(), provenance: report.provenance, vectors: report.vectors })}`,
	);
	if (!args.dryRun)
		await deps.store.write((db) =>
			finishImportRun(
				db,
				runId,
				"succeeded",
				{ ...report, notes: notes() },
				deps.now().toISOString(),
			),
		);
	return report;
}
