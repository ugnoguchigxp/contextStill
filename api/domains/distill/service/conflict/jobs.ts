import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../../infrastructure/digest";
import type { DistillDeps } from "../../contracts";
import { PAIR_JUDGE_VERSION } from "../../prompts/pair-judge";

export const SCOPE = "distill";
export const CONFLICT_KIND = "distill.conflict";
export const RESOLVE_KIND = "distill.resolve";

/** One pair as a job carries it: the digests are those of the texts the judgment is about. */
export interface PairRef {
	a: string;
	aDigest: string;
	b: string;
	bDigest: string;
}

function shaOf(text: string): string {
	return sha256Hex(text).slice(0, 32);
}

export const dedupeKeys = {
	conflict: (runId: string, items: readonly PairRef[]) =>
		`conflict:${shaOf(items.map((i) => `${i.a}:${i.aDigest}|${i.b}:${i.bDigest}`).join(","))}:${PAIR_JUDGE_VERSION}:${runId}`,
	resolve: (
		runId: string,
		a: string,
		b: string,
		aDigest: string,
		bDigest: string,
	) => `resolve:${a}:${b}:${aDigest}:${bDigest}:${runId}`,
};

/** Enqueues a conflict job; true when it is new. Must run inside the caller's transaction. */
export function enqueueConflictJob(
	deps: DistillDeps,
	tx: Database,
	runId: string,
	items: readonly PairRef[],
): boolean {
	return deps.queue.enqueueInTransaction(tx, {
		scope: SCOPE,
		kind: CONFLICT_KIND,
		dedupeKey: dedupeKeys.conflict(runId, items),
		payload: { runId, pairs: items.map((i) => [i.a, i.b]) },
		subjectRef: `conflict:${runId}`,
		lane: "background",
		resourceKey: "llm",
		maxAttempts: 3,
	}).fresh;
}

export function enqueueResolveJob(
	deps: DistillDeps,
	tx: Database,
	runId: string,
	p: PairRef,
): boolean {
	return deps.queue.enqueueInTransaction(tx, {
		scope: SCOPE,
		kind: RESOLVE_KIND,
		dedupeKey: dedupeKeys.resolve(runId, p.a, p.b, p.aDigest, p.bDigest),
		payload: { runId, a: p.a, b: p.b },
		subjectRef: `conflict:${runId}`,
		lane: "background",
		resourceKey: "llm",
		maxAttempts: 3,
	}).fresh;
}

/** True when the queue refused an enqueue because it is full (nothing was written). */
export const isQueueFull = (error: unknown): boolean =>
	error instanceof Error && error.message === "queue_full";
