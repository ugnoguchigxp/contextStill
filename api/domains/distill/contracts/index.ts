import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { LlmClient } from "../../larm";
import type { EmbedReport } from "../../indexing";
import type { QueueService, QueueStatus } from "../../queue";

export * from "./llm-schemas";

export type Generality =
	| "general"
	| "generalizable"
	| "repo_specific"
	| "unusable";
export type DistillStage =
	| "assess"
	| "cluster"
	| "canonical"
	| "embed"
	| "conflict"
	| "theme"
	| "examples"
	| "incremental";
export const DISTILL_STAGES: readonly DistillStage[] = [
	"assess",
	"cluster",
	"canonical",
	"embed",
	"conflict",
	"theme",
	"examples",
	"incremental",
];
export type OwnerKind = "knowledge" | "episode";
export type AssessmentOrigin = "deterministic" | "llm" | "human";

/** distill_params.thresholds. Decided by the calibration. */
export interface Thresholds {
	/** Lower bound of a candidate edge (default 0.930, provisional). */
	clusterEdge: number;
	/** Lower bound of the average link (default 0.935, provisional). */
	clusterMerge: number;
	/** 12 */
	clusterCap: number;
	/** Lower bound of a candidate conflict pair (default 0.900, provisional). */
	pairCandidate: number;
	/** null: the canonical stage is refused (`distill_calibration_missing`). */
	calibratedAt: string | null;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
	clusterEdge: 0.93,
	clusterMerge: 0.935,
	clusterCap: 12,
	pairCandidate: 0.9,
	calibratedAt: null,
};

export interface DistillDeps {
	store: SqliteStore;
	llm: LlmClient;
	queue: QueueService;
	spaceKey: string;
	/** indexing.embedMissing(owner knowledge, mode missing) */
	embedKnowledge: () => Promise<EmbedReport>;
	now: () => Date;
	log: (line: string) => void;
}

// ---- rows ------------------------------------------------------------------------------

export interface AssessmentRow {
	ownerKind: OwnerKind;
	ownerId: string;
	generality: Generality;
	signals: Record<string, unknown>;
	reason: string;
	origin: AssessmentOrigin;
	contentDigest: string;
	promptVersion: string;
	callId: string | null;
	createdAt: string;
	updatedAt: string;
}
export type AssessmentInput = Omit<AssessmentRow, "createdAt" | "updatedAt"> & {
	at: string;
};

export type RunState = "running" | "completed" | "failed" | "cancelled";
export interface RunRow {
	id: string;
	stage: DistillStage;
	params: Record<string, unknown>;
	state: RunState;
	counts: Record<string, number>;
	startedAt: string;
	finishedAt: string | null;
}

export type LlmOutcome = "ok" | "invalid_output" | "provider_error";
export interface LlmCallRow {
	id: string;
	runId: string | null;
	stage: DistillStage;
	subjectRef: string;
	provider: string;
	model: string;
	promptVersion: string;
	inputDigest: string;
	inputTokens: number | null;
	outputTokens: number | null;
	latencyMs: number;
	outcome: LlmOutcome;
	/** null when absent or larger than 64 KiB */
	response: unknown | null;
	createdAt: string;
}
export type LlmCallInput = Omit<LlmCallRow, "createdAt"> & { at: string };

export type PairVerdictKind =
	| "duplicate"
	| "compatible"
	| "condition_split"
	| "conflict"
	| "unrelated"
	| "unknown";
export type PairResolution =
	| "none"
	| "merged"
	| "split"
	| "a_wins"
	| "b_wins"
	| "owner_pending"
	| "owner_resolved";
export interface PairJudgmentRow {
	/** a_id < b_id */
	aId: string;
	bId: string;
	aDigest: string;
	bDigest: string;
	verdict: PairVerdictKind;
	resolution: PairResolution;
	detail: Record<string, unknown>;
	callId: string | null;
	createdAt: string;
	updatedAt: string;
}
export type PairJudgmentInput = Omit<
	PairJudgmentRow,
	"createdAt" | "updatedAt"
> & { at: string };

export type ReviewKind =
	| "conflict"
	| "low_confidence"
	| "generality"
	| "verifier_unknown"
	| "host_rejected";
export type ReviewState = "open" | "resolved" | "dismissed";
export interface ReviewRow {
	id: string;
	kind: ReviewKind;
	subject: Record<string, unknown>;
	proposal: Record<string, unknown>;
	state: ReviewState;
	resolution: Record<string, unknown> | null;
	createdAt: string;
	resolvedAt: string | null;
}
export type ReviewInput = Pick<ReviewRow, "id" | "kind" | "subject"> & {
	proposal?: Record<string, unknown>;
	at: string;
};

// ---- service ---------------------------------------------------------------------------

export interface StartStageOptions {
	limit?: number;
	dryRun: boolean;
	allowUnverified?: boolean;
}

/** Verdict on one pair given to `judgePairs` (a, b are canonical ids; a < b is not required). */
export interface PairVerdict {
	a: string;
	b: string;
	verdict: PairVerdictKind;
	aNotAppliesWhen: string[];
	bNotAppliesWhen: string[];
	note: string;
}

export interface CalibrationPair {
	pairId: string;
	similarity: number;
	bin: string;
	a: { id: string; title: string; body: string };
	b: { id: string; title: string; body: string };
}
export interface CalibrationLabel {
	pairId: string;
	label: "same" | "different" | "unsure";
	labelSource: "agent-draft" | "owner";
}

export type ReviewDecision =
	| { kind: "a_wins" | "b_wins" | "split" | "keep_both" } // conflict
	| { kind: "accept" | "reject" } // low_confidence, verifier_unknown, host_rejected
	| { kind: "set_generality"; generality: Generality } // generality
	| { kind: "dismiss" };

export type AuditCode =
	| "unresolved_conflict"
	| "unjudged_near_pair"
	| "citation_invalid"
	| "generalization_lint"
	| "superseded_without_target"
	| "active_atom_absorbed"
	| "canonical_without_vector"
	| "repo_scope_canonical";
export interface AuditReport {
	ok: boolean;
	violations: { code: AuditCode; subject: string[] }[];
	checked: Record<AuditCode, number>;
}

export interface DistillStatus {
	atoms: Record<
		"superseded" | "evidence_only" | "searchable_unabsorbed" | "unassessed",
		number
	>;
	assessments: Record<Generality, number>;
	clusters: Record<
		"pending" | "distilled" | "review" | "rejected" | "stale",
		number
	>;
	canonicals: {
		active: number;
		retracted: number;
		superseded: number;
		withoutVector: number;
	};
	/** open reviews only */
	reviews: Record<ReviewKind, number>;
	llm: {
		calls: number;
		inputTokens: number;
		outputTokens: number;
		invalidOutput: number;
	};
	queue: QueueStatus;
}

export interface DistillService {
	/** Registers the handlers of 5.7 on the queue. */
	registerHandlers(): void;
	startStage(
		stage: DistillStage,
		opts: StartStageOptions,
	): Promise<{ runId: string; enqueued: number }>;
	status(): DistillStatus;
	/** Stratified pairs with their text (API token required); yields while it searches. */
	calibrationSample(n: number): Promise<CalibrationPair[]>;
	/** Validates synchronously (throws invalid_distill_request); resolves once stored. */
	applyCalibration(labels: CalibrationLabel[]): Promise<Thresholds>;
	listReviews(state: ReviewState): ReviewRow[];
	/** `signal` aborts an LLM call the decision needs (the split proposal); it is the request's. */
	resolveReview(
		id: string,
		decision: ReviewDecision,
		signal?: AbortSignal,
	): Promise<void>;
	/** Yields to the event loop between its steps (the backend keeps answering MCP). */
	audit(): Promise<AuditReport>;
	/**
	 * Called by the backend at start-up, after the queue recovered: when no distill job is open,
	 * a run still marked running can never finish (a crash between the run row and its jobs),
	 * so it is failed and its stage can start again. Returns the number of runs failed.
	 */
	recoverRuns(): Promise<number>;
	/** Used by evaluation. */
	judgePairs(
		pairs: { a: string; b: string }[],
		signal?: AbortSignal,
	): Promise<PairVerdict[]>;
}

/**
 * The contract between `createDistill` (service/index.ts) and the stage modules the
 * workstreams write. A module is built from `DistillDeps`; building it does no work.
 */
export interface StageModule {
	/** Registers the queue handlers (kind distill.*) the module owns. Called once. */
	registerHandlers(): void;
	/**
	 * Enqueues the jobs of `stage` for `runId` and returns how many were enqueued. With
	 * `opts.dryRun` it enqueues nothing and returns how many it would. Throws `DistillError`.
	 */
	start(
		stage: DistillStage,
		runId: string,
		opts: StartStageOptions,
	): Promise<number>;
}
/** service/assess: stage assess. */
export type AssessModule = StageModule;
/** service/cluster: stages cluster and incremental, and the calibration (6.2). */
export interface ClusterModule extends StageModule {
	calibrationSample(n: number): CalibrationPair[];
	/** The same sample, yielding to the event loop during the neighbour search. */
	calibrationSampleYielding(n: number): Promise<CalibrationPair[]>;
	/** Validates synchronously (throws invalid_distill_request); resolves once stored. */
	applyCalibration(labels: CalibrationLabel[]): Promise<Thresholds>;
}
/** service/canonical: stages canonical and embed. */
export type CanonicalModule = StageModule;
/** service/conflict: stage conflict, and the jobs distill.conflict and distill.resolve. */
export interface ConflictModule extends StageModule {
	judgePairs(
		pairs: { a: string; b: string }[],
		signal?: AbortSignal,
	): Promise<PairVerdict[]>;
}
/** service/review: the owner's queue and the status report. */
export interface ReviewModule {
	listReviews(state: ReviewState): ReviewRow[];
	/** `signal` aborts an LLM call the decision needs (the split proposal); it is the request's. */
	resolveReview(
		id: string,
		decision: ReviewDecision,
		signal?: AbortSignal,
	): Promise<void>;
	status(): DistillStatus;
}
/** service/audit */
export interface AuditModule {
	audit(): AuditReport;
	/** The same check, yielding to the event loop between its steps. */
	auditYielding(): Promise<AuditReport>;
}
/** service/theme: stage theme. */
export type ThemeModule = StageModule;
/** service/examples: stage examples. */
export type ExamplesModule = StageModule;

// ---- errors ----------------------------------------------------------------------------

export type DistillErrorCode =
	| "invalid_distill_request"
	| "distill_not_found"
	| "distill_stage_running"
	| "distill_vectors_unverified"
	| "distill_calibration_missing"
	| "llm_invalid_output"
	| "host_rejected";

/** The message is the code: no prompt, model output or row text ever enters an error. */
export class DistillError extends Error {
	constructor(public code: DistillErrorCode) {
		super(code);
		this.name = "DistillError";
	}
}

export const errorStatus = {
	invalid_distill_request: 400,
	distill_not_found: 404,
	distill_stage_running: 409,
	distill_vectors_unverified: 409,
	distill_calibration_missing: 409,
	llm_invalid_output: 502,
	host_rejected: 422,
} as const;
