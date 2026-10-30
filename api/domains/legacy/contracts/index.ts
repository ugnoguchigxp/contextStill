import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ProvenanceStatus } from "../../knowledge";

export type LegacyTable =
	| "vibe_memories"
	| "sources"
	| "source_fragments"
	| "episode_cards"
	| "knowledge_items"
	| "knowledge_usage_events"
	| "knowledge_items_vec_fallback";

export interface LegacyImportArgs {
	snapshotPath: string;
	dryRun: boolean;
	only?: LegacyTable[];
	batchSize: number;
}

export interface LegacyImportDeps {
	store: SqliteStore;
	dbPath: string;
	now: () => Date;
	log: (line: string) => void;
}

export interface TableReport {
	legacyCount: number;
	inserted: number;
	updated: number;
	unchanged: number;
	skipped: number;
	skippedReasons: Record<string, number>;
}

export interface LegacyImportReport {
	runId: string;
	importerVersion: "legacy-import.v2";
	snapshotFingerprint: string;
	dryRun: boolean;
	tables: Record<LegacyTable, TableReport>;
	provenance: Record<ProvenanceStatus, number> & {
		byOrigin: Record<string, number>;
		activeUnresolved: number;
	};
	time: {
		converted: Record<"iso" | "sqlite" | "unix_ms", number>;
		invalid: number;
	};
	vectors: { imported: number; stale: number; invalid: number };
}

/** Codes thrown by the importer and their HTTP statuses (commands report them as is). */
export const legacyErrorStatus = {
	snapshot_path_forbidden: 400,
	snapshot_not_found: 404,
	// A non-empty -wal would be ignored under immutable=1: refuse instead of importing stale data.
	snapshot_has_wal: 409,
	id_collision: 409,
} as const;
