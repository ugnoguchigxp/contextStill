import type { Database } from "bun:sqlite";
import type { z } from "zod";
import type { JobState, Lane } from "../contracts";

export type Tx = Database;

export interface JobRecord {
	id: string;
	scope: string;
	kind: string;
	payloadVersion: number;
	dedupeKey: string;
	payloadJson: string;
	inputDigest: string;
	generation: number;
	subjectRef: string | null;
	parentJobId: string | null;
	lane: Lane;
	resourceKey: string | null;
	concurrencyKey: string | null;
	state: JobState;
	availableAtMs: number;
	deadlineAtMs: number | null;
	maxAttempts: number;
	owner: string | null;
	attempt: number;
	leaseUntilMs: number | null;
	cancelRequestedAtMs: number | null;
	waitReason: string | null;
	errorCode: string | null;
	resultRef: string | null;
	recoveryPolicy: "replay_safe" | "interrupt";
	createdSeq: number;
	createdAtMs: number;
	updatedAtMs: number;
	finishedAtMs: number | null;
	revision: number;
}

export interface AttemptRecord {
	jobId: string;
	attempt: number;
	owner: string;
	startedAtMs: number;
	endedAtMs: number | null;
	outcome: string | null;
	errorCode: string | null;
}

export interface JobClaim<P = unknown> {
	jobId: string;
	scope: string;
	kind: string;
	payloadVersion: number;
	payload: P;
	subjectRef: string | null;
	owner: string;
	attempt: number;
	generation: number;
	maxAttempts: number;
	deadlineAtMs: number | null;
}

type PrepareResult<I> =
	| { status: "ready"; input: I }
	| { status: "stale"; reason: string };

export type SettleOutcome<O> =
	| { type: "success"; result: O; resultRef?: string }
	| { type: "retry"; errorCode: string; availableAtMs: number }
	| { type: "failed"; errorCode: string }
	| { type: "expired" }
	| { type: "interrupted"; errorCode: string };

export type SettleResult =
	| "applied"
	| "stale"
	| { status: "failed"; errorCode: string };

/**
 * Typed handler. The three transactional callbacks are synchronous: they run
 * inside the single Writer transaction and must only touch the owning
 * domain's tables through its repository.
 */
export interface HandlerDefinition<P, I, O> {
	kind: string;
	payloadVersions: readonly number[];
	schema: z.ZodType<P>;
	recovery: "replay_safe" | "interrupt";
	resourceKey?: string;
	prepareInTransaction(tx: Tx, claim: JobClaim<P>): PrepareResult<I>;
	execute(
		input: I,
		context: {
			signal: AbortSignal;
			jobId: string;
			attempt: number;
			generation: number;
		},
	): Promise<O>;
	classify?(error: unknown): "retry" | "fail";
	settleInTransaction(
		tx: Tx,
		claim: JobClaim<P>,
		input: I | null,
		outcome: SettleOutcome<O>,
	): SettleResult;
	/** Called only after a successful commit that applied this settlement. */
	afterCommit?(): void;
	cancelInTransaction(
		tx: Tx,
		job: { jobId: string; subjectRef: string | null; payload: P },
		reason: string,
	): void;
}

export interface EnqueueInput {
	scope: string;
	kind: string;
	payloadVersion?: number;
	dedupeKey: string;
	payload: unknown;
	subjectRef?: string | null;
	parentJobId?: string | null;
	lane: Lane;
	resourceKey?: string | null;
	concurrencyKey?: string | null;
	availableAtMs?: number;
	deadlineAtMs?: number | null;
	maxAttempts?: number;
}

export interface QueueOptions {
	resourceAliases?: Record<string, string>;
	now?: () => number;
	id?: () => string;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	random?: () => number;
	limits?: { total: number; background: number; scope: number };
	resources?: Record<string, number>;
	leaseMs?: number;
	heartbeatMs?: number;
	pollMs?: number;
	backoff?: { baseMs: number; maxMs: number };
	tickClaims?: number;
}
