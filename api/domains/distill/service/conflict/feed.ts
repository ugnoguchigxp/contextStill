import type { Database } from "bun:sqlite";
import type { DistillDeps } from "../../contracts";
import { addRunCounts, getParam, getRun, setParam } from "../../repository";
import {
	enqueueConflictJob,
	enqueueResolveJob,
	isQueueFull,
	type PairRef,
} from "./jobs";

/**
 * Jobs of one conflict run open at once. The queue admits 128 open jobs per scope, shared with
 * the other stages, and a run over many pairs has thousands; so a run enqueues a window and each
 * job that settles tops the window up from the work the run kept in `distill_params`.
 */
export const FEED_WINDOW = 16;
const CHUNK = 64;
const PREFIX = "conflict.work.";

/** One unit of work: a batch of up to 8 pairs to judge, or a judged pair to resolve. */
export type WorkItem =
	| { t: "judge"; pairs: PairRef[] }
	| { t: "resolve"; pair: PairRef };

const chunkKey = (runId: string, chunk: number) => `${PREFIX}${runId}.${chunk}`;

/** Stores the items of a run (the caller owns the transaction) and sets `planned` (and `fed`, the items handed out so far, to 0). */
export function saveWork(
	db: Database,
	runId: string,
	items: readonly WorkItem[],
	at: string,
): void {
	// Rows of an earlier run that did not get to clean up (only one conflict run runs at a time).
	db.query("DELETE FROM distill_params WHERE substr(key, 1, ?) = ?").run(
		PREFIX.length,
		PREFIX,
	);
	for (let i = 0; i < items.length; i += CHUNK)
		setParam(db, chunkKey(runId, i / CHUNK), items.slice(i, i + CHUNK), at);
	// Absolute, so that the same run planned twice has the same plan: nothing handed out yet.
	const counts = getRun(db, runId)?.counts ?? {};
	addRunCounts(db, runId, {
		planned: items.length - (counts.planned ?? 0),
		fed: -(counts.fed ?? 0),
	});
}

/** Removes the kept work of a run that has ended. */
export function clearWork(db: Database, runId: string): void {
	const prefix = `${PREFIX}${runId}.`;
	db.query("DELETE FROM distill_params WHERE substr(key, 1, ?) = ?").run(
		prefix.length,
		prefix,
	);
}

/**
 * Enqueues up to `room` of the items not yet handed out, in order, and counts them (`jobs`,
 * `fed`). A full queue stops the feeding without an error: the rest is picked up by the next
 * settle, or by the next run (the judgments are still unmade). Returns how many jobs it made.
 */
export function feedWork(
	db: Database,
	deps: DistillDeps,
	runId: string,
	room: number,
): number {
	const run = getRun(db, runId);
	if (!run) return 0;
	const planned = run.counts.planned ?? 0;
	let fed = run.counts.fed ?? 0;
	let jobs = 0;
	let loaded: { chunk: number; items: WorkItem[] } | null = null;
	while (jobs < room && fed < planned) {
		const chunk = Math.floor(fed / CHUNK);
		if (!loaded || loaded.chunk !== chunk)
			loaded = {
				chunk,
				items: getParam<WorkItem[]>(db, chunkKey(runId, chunk)) ?? [],
			};
		const item = loaded.items[fed % CHUNK];
		if (item) {
			try {
				const fresh =
					item.t === "judge"
						? enqueueConflictJob(deps, db, runId, item.pairs)
						: enqueueResolveJob(deps, db, runId, item.pair);
				if (fresh) jobs++;
			} catch (error) {
				if (isQueueFull(error)) break;
				throw error;
			}
		}
		fed++;
	}
	addRunCounts(db, runId, { fed: fed - (run.counts.fed ?? 0), jobs });
	return jobs;
}
