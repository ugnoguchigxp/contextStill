import { getLogger } from "../../../infrastructure/logger";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import { getJob } from "../repository";
import type { JobRecord, SettleOutcome, SettleResult, Tx } from "../types";
import type { Resolved } from "./runner-options";
import { type Active, toErrorCode } from "./runner-shared";

const log = getLogger("queue");

/** Bounded retries when the writer queue is full; the delay doubles from the first value. */
const BUSY_RETRIES = 5;
const BUSY_RETRY_BASE_MS = 50;

interface SettleDeps {
	opts: Resolved;
	/** Writer transaction on the reserved lane, with after-commit hooks run on success. */
	writeCritical: <T>(fn: (db: Tx) => T) => Promise<T>;
	finishRunning: (
		db: Tx,
		job: JobRecord,
		state: "cancelled",
		errorCode: string | null,
		now: number,
	) => void;
	applyOutcome: (
		db: Tx,
		job: JobRecord,
		handler: Active["handler"],
		input: unknown,
		outcome: SettleOutcome<unknown>,
		now: number,
		hooks: Array<() => void>,
	) => SettleResult;
	backoffMs: (attempt: number) => number;
	isClosing: () => boolean;
	pendingHooks: Array<() => void>;
}

/**
 * Commits the result of a finished execution. A full writer queue is retried with a short
 * bounded backoff: a finished answer must not be discarded just because the writer was briefly
 * saturated (the lease sweep would otherwise interrupt a job whose work is already done).
 */
export function createSettler(deps: SettleDeps) {
	const { opts } = deps;
	async function whenWriterFree<T>(write: () => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await write();
			} catch (error) {
				if (!(error instanceof WriterBusyError) || attempt >= BUSY_RETRIES)
					throw error;
				log.warn("queue.settle_writer_busy", { attempt: attempt + 1 });
				await opts.sleep(BUSY_RETRY_BASE_MS * 2 ** attempt);
			}
		}
	}
	return async function settle(
		a: Active,
		result: { ok: true; value: unknown } | { ok: false; error: unknown },
	) {
		const attemptSettle = (
			pick: (job: JobRecord, now: number) => SettleOutcome<unknown>,
		) =>
			whenWriterFree(() =>
				deps.writeCritical((db) => {
					const now = opts.now();
					const job = getJob(db, a.claim.jobId);
					if (
						!job ||
						job.owner !== a.claim.owner ||
						job.attempt !== a.claim.attempt ||
						job.generation !== a.claim.generation ||
						a.revoked
					)
						return;
					if (job.state === "cancel_requested") {
						deps.finishRunning(db, job, "cancelled", job.errorCode, now);
						return;
					}
					if (job.state !== "running") return;
					deps.applyOutcome(
						db,
						job,
						a.handler,
						a.input,
						pick(job, now),
						now,
						deps.pendingHooks,
					);
				}),
			);
		const pick = (job: JobRecord, now: number): SettleOutcome<unknown> => {
			const late = job.deadlineAtMs !== null && now >= job.deadlineAtMs;
			if (result.ok)
				return late || a.deadlineHit
					? { type: "expired" }
					: { type: "success", result: result.value };
			if (deps.isClosing())
				return { type: "interrupted", errorCode: "shutdown" };
			if (a.deadlineHit || late) return { type: "expired" };
			const errorCode = toErrorCode(result.error);
			const retryable =
				a.handler.classify?.(result.error) === "retry" &&
				job.attempt < job.maxAttempts;
			if (!retryable) return { type: "failed", errorCode };
			const availableAtMs = now + deps.backoffMs(job.attempt);
			if (job.deadlineAtMs !== null && availableAtMs >= job.deadlineAtMs)
				return { type: "failed", errorCode };
			return { type: "retry", errorCode, availableAtMs };
		};
		try {
			await attemptSettle(pick);
		} catch (error) {
			// A saturated writer is not a business failure: the caller leaves it to the lease sweep.
			if (error instanceof WriterBusyError) throw error;
			log.error(
				"queue.business_settlement_failed",
				{ reason: "settle_failed" },
				error,
			);
			// Business settlement threw and rolled back; record a plain failure through the handler.
			await attemptSettle(() => ({
				type: "failed",
				errorCode: "settle_failed",
			}));
		}
	};
}
