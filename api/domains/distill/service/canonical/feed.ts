import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../../infrastructure/digest";
import { getKnowledgeById } from "../../../knowledge";
import { listClusters } from "../../../map";
import type { DistillDeps } from "../../contracts";
import { CANONICAL_PROMPT_VERSION } from "../../prompts/canonical-plan";
import {
	addRunCounts,
	finishRun,
	getParam,
	getRun,
	setParam,
} from "../../repository";
import {
	hasSingleReview,
	isUnverifiedAlgorithm,
	listSingleCandidates,
} from "./reads";
import type { CanonicalPayload } from "./types";

/** Jobs of one run open at once. The queue admits 128 open jobs per scope, shared with other stages. */
export const FEED_WINDOW = 16;
export const SINGLES_BATCH = 8;
const CURSOR_KEY = "canonical.cursor";
const PAGE = 200;

interface Cursor {
	runId: string;
	/** Last cluster id handed out. */
	cluster: string;
	/** Last atom id examined for the singles. */
	single: string;
}

export interface WorkItem {
	payload: CanonicalPayload;
	dedupeKey: string;
	subjectRef: string;
	/** Clusters and atoms this job covers (what `limit` counts). */
	units: number;
	cursorAfter: Cursor;
}

/**
 * The jobs of a canonical run in order: pending claim clusters by id, then the atoms that
 * belong to no cluster in batches of 8 by id. `budget` is how many units may still be handed
 * out (the run's `limit`); `max` how many jobs to return. A cursor makes every unit appear at
 * most once per run, so an atom sent to review is not planned again in the same run.
 */
export function collectWork(
	db: Database,
	runId: string,
	from: Cursor,
	max: number,
	budget: number,
): WorkItem[] {
	const items: WorkItem[] = [];
	let cursor = { ...from };
	let left = budget;

	const clusters = listClusters(db, { kind: "claim", state: "pending" })
		// A cluster made under allowUnverified is never distilled (6.0).
		.filter((c) => c.id > cursor.cluster && !isUnverifiedAlgorithm(c.algorithm))
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const c of clusters) {
		if (items.length >= max || left < 1) return items;
		cursor = { ...cursor, cluster: c.id };
		left -= 1;
		items.push({
			payload: { runId, clusterId: c.id, memberDigest: c.memberDigest },
			dedupeKey: `canonical:${c.id}:${c.memberDigest}:${CANONICAL_PROMPT_VERSION}:${runId}`,
			subjectRef: `cluster:${c.id}`,
			units: 1,
			cursorAfter: cursor,
		});
	}

	let batch: string[] = [];
	const emit = (last: string) => {
		const digests = batch.map(
			(id) => getKnowledgeById(db, id)?.contentDigest ?? "",
		);
		cursor = { ...cursor, single: last };
		left -= batch.length;
		items.push({
			payload: { runId, singles: batch },
			dedupeKey: `canonical:${sha256Hex(batch.join(","))}:${sha256Hex(digests.join(","))}:${CANONICAL_PROMPT_VERSION}:${runId}`,
			subjectRef: `singles:${batch[0]}`,
			units: batch.length,
			cursorAfter: cursor,
		});
		batch = [];
	};
	let after = cursor.single;
	for (;;) {
		if (items.length >= max || left < 1) return items;
		const page = listSingleCandidates(db, after, PAGE);
		for (const id of page) {
			after = id;
			const row = getKnowledgeById(db, id);
			if (!row || hasSingleReview(db, { id, contentDigest: row.contentDigest }))
				continue;
			batch.push(id);
			if (batch.length >= Math.min(SINGLES_BATCH, left)) {
				emit(id);
				if (items.length >= max || left < 1) return items;
			}
		}
		if (page.length < PAGE) break;
	}
	if (batch.length > 0 && items.length < max && left >= 1) emit(after);
	return items;
}

export function readCursor(db: Database, runId: string): Cursor {
	const stored = getParam<Cursor>(db, CURSOR_KEY);
	return stored && stored.runId === runId
		? stored
		: { runId, cluster: "", single: "" };
}

export function writeCursor(db: Database, cursor: Cursor, at: string): void {
	setParam(db, CURSOR_KEY, cursor, at);
}

const isQueueFull = (error: unknown) =>
	error instanceof Error && error.message === "queue_full";

/**
 * Enqueues the items (one transaction with the caller) and moves the run's counters and cursor
 * to the last one enqueued; returns how many were. With `tolerateFull` a full queue ends the
 * feed early instead of throwing (the caller is a settle, which must not roll back for it).
 */
export function enqueueWork(
	db: Database,
	deps: DistillDeps,
	runId: string,
	items: readonly WorkItem[],
	opts: { tolerateFull?: boolean } = {},
): number {
	let done = 0;
	try {
		for (const item of items) {
			deps.queue.enqueueInTransaction(db, {
				scope: "distill",
				kind: "distill.canonical",
				dedupeKey: item.dedupeKey,
				payload: item.payload,
				subjectRef: item.subjectRef,
				lane: "background",
				maxAttempts: 3,
			});
			done++;
		}
	} catch (error) {
		if (!opts.tolerateFull || !isQueueFull(error)) throw error;
	}
	if (done === 0) return 0;
	addRunCounts(db, runId, {
		enqueued: done,
		units: items.slice(0, done).reduce((n, i) => n + i.units, 0),
	});
	writeCursor(db, items[done - 1]!.cursorAfter, deps.now().toISOString());
	return done;
}

/**
 * A canonical job ended (settled, went stale before running, or was cancelled): count it, hand
 * out more jobs while the window has room, and when nothing is open and nothing is left queue
 * the embedding of the new canonicals. A cancelled job closes the run. A queue too full to feed
 * the window never rolls the settle back; with nothing open the run fails instead of hanging.
 * Runs in the job's transaction.
 */
export function jobEnded(
	db: Database,
	deps: DistillDeps,
	runId: string,
	delta: Record<string, number>,
): void {
	if (!getRun(db, runId)) return;
	addRunCounts(db, runId, { settled: 1, ...delta });
	let run = getRun(db, runId)!;
	if (run.state !== "running") return;
	// A cancelled job stops the run: no more jobs are handed out and no embedding is queued.
	if ((delta.cancelled ?? 0) > 0 || (run.counts.cancelled ?? 0) > 0) {
		finishRun(db, runId, "cancelled", deps.now().toISOString());
		return;
	}
	const at = () => deps.now().toISOString();
	const open = (run.counts.enqueued ?? 0) - (run.counts.settled ?? 0);
	let blocked = false;
	if (open <= FEED_WINDOW / 2) {
		const limit =
			typeof run.params.limit === "number" ? run.params.limit : null;
		const budget =
			limit === null
				? Number.POSITIVE_INFINITY
				: limit - (run.counts.units ?? 0);
		const items = collectWork(
			db,
			runId,
			readCursor(db, runId),
			FEED_WINDOW - open,
			budget,
		);
		// A full queue must not undo this settle; the next job that ends feeds again.
		blocked =
			enqueueWork(db, deps, runId, items, { tolerateFull: true }) <
			items.length;
		if (blocked) addRunCounts(db, runId, { feedBlocked: 1 });
		run = getRun(db, runId)!;
	}
	const stillOpen = (run.counts.enqueued ?? 0) - (run.counts.settled ?? 0);
	if (run.stage !== "canonical") return;
	// Nothing is left to wake the feed again: do not leave the run running.
	if (stillOpen === 0 && blocked) {
		finishRun(db, runId, "failed", at());
		return;
	}
	if (stillOpen > 0) return;
	if (!run.counts.embedQueued) {
		try {
			deps.queue.enqueueInTransaction(db, {
				scope: "distill",
				kind: "distill.embed",
				dedupeKey: `embed:${runId}`,
				payload: { runId },
				subjectRef: `run:${runId}`,
				lane: "background",
				maxAttempts: 3,
			});
			addRunCounts(db, runId, { embedQueued: 1 });
		} catch (error) {
			if (!isQueueFull(error)) throw error;
			addRunCounts(db, runId, { embedFailed: 1 });
			finishRun(db, runId, "failed", at());
		}
	}
}
