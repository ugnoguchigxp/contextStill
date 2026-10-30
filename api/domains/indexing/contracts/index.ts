import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { LarmEmbeddingClient } from "../../larm";
import type { VectorOwnerKind } from "../../vectors";

export interface IndexingDeps {
	store: SqliteStore;
	larm: LarmEmbeddingClient;
	spaceKey: string;
	now: () => Date;
	log: (line: string) => void;
	sleep: (ms: number) => Promise<void>;
}

export interface VerifyLegacyArgs {
	sampleSize: number;
	thresholdMin: number;
	thresholdMean: number;
	dryRun: boolean;
}

export interface VerifyLegacyReport {
	runId: string;
	sampleSize: number;
	minCosine: number | null;
	meanCosine: number | null;
	passed: boolean;
	prefixDiagnostic: { minCosine: number; meanCosine: number } | null;
	updatedRows: number;
}

export interface EmbedArgs {
	owner: VectorOwnerKind;
	mode: "missing" | "all";
	batchSize: number;
	limit?: number;
	dryRun: boolean;
}

export interface EmbedReport {
	owner: VectorOwnerKind;
	candidates: number;
	embedded: number;
	skipped: number;
	failed: number;
	busyWaits: number;
}

/** Row fields that make up the embedded text; the fields used depend on the owner kind. */
export interface EmbeddingTextRow {
	title: string;
	body?: string;
	situation?: string;
	action?: string;
	outcome?: string;
	lesson?: string;
}
