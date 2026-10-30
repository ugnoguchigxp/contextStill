import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../../infrastructure/digest";
import {
	DistillError,
	type DistillDeps,
	type DistillStage,
} from "../../contracts";
import {
	addRunCounts,
	deleteParam,
	deleteParamsWithPrefix,
	finishRun,
	getParam,
	getRun,
	setParam,
} from "../../repository";

/**
 * The queue allows 128 open jobs per scope, and a stage has hundreds. A run therefore enqueues a
 * window of jobs at the start and each job that settles enqueues the one `FEED_WINDOW` places
 * after it. The jobs beyond the window are kept as rows of distill_params until they are fed.
 */
export const FEED_WINDOW = 48;

export interface WorkItem {
	kind: "distill.theme" | "distill.examples";
	dedupeKey: string;
	subjectRef: string;
	/** Includes `runId` and `seq`. */
	payload: Record<string, unknown>;
}

const itemKey = (stage: DistillStage, runId: string, seq: number) =>
	`${stage}.work.${runId}.${seq}`;

/** Stores the items after the window; the caller owns the transaction. */
export function saveWorkTail(
	db: Database,
	stage: DistillStage,
	runId: string,
	items: readonly WorkItem[],
	at: string,
): void {
	for (let seq = FEED_WINDOW; seq < items.length; seq++)
		setParam(db, itemKey(stage, runId, seq), items[seq], at);
}

/**
 * Deletes the stored items of a run that has ended: the jobs that were never fed would otherwise
 * leave their payloads there for good.
 */
export function clearWorkTail(
	db: Database,
	stage: DistillStage,
	runId: string,
	at: string,
): void {
	void at;
	deleteParamsWithPrefix(db, `${stage}.work.${runId}.`);
}

function enqueueItem(deps: DistillDeps, tx: Database, item: WorkItem) {
	deps.queue.enqueueInTransaction(tx, {
		scope: "distill",
		kind: item.kind,
		dedupeKey: item.dedupeKey,
		payload: item.payload,
		subjectRef: item.subjectRef,
		lane: "background",
		resourceKey: "llm",
		maxAttempts: 3,
	});
}

/** Enqueues the first window of a run (outside any transaction, so the runner wakes). */
export async function enqueueWindow(
	deps: DistillDeps,
	items: readonly WorkItem[],
): Promise<void> {
	for (const item of items.slice(0, FEED_WINDOW))
		await deps.queue.enqueue({
			scope: "distill",
			kind: item.kind,
			dedupeKey: item.dedupeKey,
			payload: item.payload,
			subjectRef: item.subjectRef,
			lane: "background",
			resourceKey: "llm",
			maxAttempts: 3,
		});
}

export function runIsOpen(db: Database, runId: string): boolean {
	return getRun(db, runId)?.state === "running";
}

/**
 * Called from `settleInTransaction` once a job of the run has ended for good (not for a retry).
 * Counts it, enqueues the job `FEED_WINDOW` places on, and closes the run when every planned job
 * has ended. A fatal end (the model is not reachable or not configured) fails the run: the jobs
 * still queued find it closed and are dropped, and the next `startStage` plans them again.
 */
export function settleRunJob(
	tx: Database,
	deps: DistillDeps,
	job: {
		stage: DistillStage;
		runId: string;
		seq: number;
		fatal: boolean;
		counts?: Record<string, number>;
	},
): void {
	const run = getRun(tx, job.runId);
	if (!run || run.state !== "running") return;
	const at = deps.now().toISOString();
	addRunCounts(tx, job.runId, { settled: 1, ...job.counts });
	if (job.fatal) {
		addRunCounts(tx, job.runId, { failed: 1 });
		clearWorkTail(tx, job.stage, job.runId, at);
		finishRun(tx, job.runId, "failed", at);
		return;
	}
	const next = job.seq + FEED_WINDOW;
	const key = itemKey(job.stage, job.runId, next);
	const item = getParam<WorkItem | null>(tx, key);
	if (item) {
		try {
			enqueueItem(deps, tx, item);
			deleteParam(tx, key);
		} catch {
			// The queue is full: the rest of the run cannot be fed.
			addRunCounts(tx, job.runId, { feedFailed: 1 });
			clearWorkTail(tx, job.stage, job.runId, at);
			finishRun(tx, job.runId, "failed", at);
			return;
		}
	}
	const after = getRun(tx, job.runId);
	if (after && (after.counts.settled ?? 0) >= (after.counts.planned ?? 0)) {
		clearWorkTail(tx, job.stage, job.runId, at);
		finishRun(tx, job.runId, "completed", at);
	}
}

/** The queue's `classify`: a model that is busy or away is retried; everything else is final. */
export function classifyError(error: unknown): "retry" | "fail" {
	if (error instanceof DistillError) return "fail";
	const code = (error as { code?: unknown } | null)?.code;
	return code === "larm_busy" ||
		code === "larm_unreachable" ||
		code === "larm_deploying"
		? "retry"
		: "fail";
}

/** A review row id that is the same for the same subject, so a rerun does not pile up reviews. */
export function reviewId(...parts: string[]): string {
	return `rv_${sha256Hex(parts.join("\u0000")).slice(0, 32)}`;
}
