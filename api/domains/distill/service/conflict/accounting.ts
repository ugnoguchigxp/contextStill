import type { Database } from "bun:sqlite";
import type { DistillDeps } from "../../contracts";
import { addRunCounts, finishRun, getRun } from "../../repository";
import { FEED_WINDOW, clearWork, feedWork } from "./feed";

/**
 * A run of the conflict stage is a set of jobs: the judging jobs and the resolve jobs of the
 * work it planned (`feed.ts` hands them out a window at a time), and the resolve jobs the judging
 * jobs spawn. The run keeps `jobs` (enqueued) and `jobsSettled`; the job that settles the last
 * one finishes the run, `failed` if any job failed. All of it happens in the transaction of the
 * job that settles, so the counters never disagree with the queue.
 *
 * Only a run of the stage `conflict` with `jobs > 0` is accounted: a resolve job that the
 * canonical stage enqueues carries the canonical run's id and must not close that run.
 */
export function noteEnqueued(db: Database, runId: string, jobs: number): void {
	if (jobs > 0) addRunCounts(db, runId, { jobs });
}

export function noteSettled(
	db: Database,
	deps: DistillDeps,
	runId: string,
	at: string,
	outcome: { failed?: boolean; counts?: Record<string, number> } = {},
): void {
	const before = getRun(db, runId);
	if (!before || before.stage !== "conflict" || (before.counts.jobs ?? 0) <= 0)
		return;
	addRunCounts(db, runId, {
		jobsSettled: 1,
		...(outcome.failed ? { jobsFailed: 1 } : {}),
		...outcome.counts,
	});
	let run = getRun(db, runId)!;
	if (run.state !== "running") return;
	const open = (run.counts.jobs ?? 0) - (run.counts.jobsSettled ?? 0);
	// A cancelled job stops the feeding: the run only drains what is already queued.
	if ((run.counts.cancelled ?? 0) === 0 && open <= FEED_WINDOW / 2) {
		feedWork(db, deps, runId, FEED_WINDOW - open);
		run = getRun(db, runId)!;
	}
	if ((run.counts.jobsSettled ?? 0) < (run.counts.jobs ?? 0)) return;
	finishRun(
		db,
		runId,
		(run.counts.cancelled ?? 0) > 0
			? "cancelled"
			: (run.counts.jobsFailed ?? 0) > 0
				? "failed"
				: "completed",
		at,
	);
	clearWork(db, runId);
}
