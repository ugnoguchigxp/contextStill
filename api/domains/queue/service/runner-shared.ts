import { type CandidateCursor, candidatesAfter, cursorOf } from "../repository";
import type { HandlerDefinition, JobClaim, JobRecord, Tx } from "../types";

const SCAN_PAGE = 256;
const SCAN_MAX = 4096;

export interface Active {
	claim: JobClaim;
	input: unknown;
	handler: HandlerDefinition<unknown, unknown, unknown>;
	controller: AbortController;
	heartbeat: AbortController;
	resourceKey: string | null;
	concurrencyKey: string | null;
	promise: Promise<void>;
	lost: boolean;
	revoked: boolean;
	deadlineHit: boolean;
}

/** Only machine-readable codes are persisted; free text may carry Provider output. */
export function toErrorCode(e: unknown): string {
	if (!(e instanceof Error) || !e.message) return "execution_failed";
	return /^[a-z][a-z0-9_:]{0,100}$/.test(e.message)
		? e.message
		: "handler_failed";
}

/** Pages through ready jobs so a wall of blocked ones cannot hide runnable ones behind it. */
export function* scanCandidates(db: Tx, now: number): Generator<JobRecord> {
	let after: CandidateCursor | null = null;
	let scanned = 0;
	while (scanned < SCAN_MAX) {
		const page = candidatesAfter(db, now, SCAN_PAGE, after);
		for (const job of page) yield job;
		scanned += page.length;
		const last = page[page.length - 1];
		if (page.length < SCAN_PAGE || !last) return;
		after = cursorOf(last);
	}
}

export function claimOf(job: JobRecord): JobClaim {
	return {
		jobId: job.id,
		scope: job.scope,
		kind: job.kind,
		payloadVersion: job.payloadVersion,
		payload: JSON.parse(job.payloadJson),
		subjectRef: job.subjectRef,
		owner: job.owner ?? "",
		attempt: job.attempt,
		generation: job.generation,
		maxAttempts: job.maxAttempts,
		deadlineAtMs: job.deadlineAtMs,
	};
}
