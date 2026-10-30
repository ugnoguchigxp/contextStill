import {
	DistillError,
	type ConflictModule,
	type DistillDeps,
	type PairVerdict,
} from "../../contracts";
import { getKnowledgeById } from "../../../knowledge";
import { getCluster } from "../../../map";
import { PAIR_JUDGE_VERSION } from "../../prompts/pair-judge";
import { getPairJudgment, getRun, listPairJudgments } from "../../repository";
import { mergeClusterId, reconcileMerges } from "./apply";
import { unjudgedCandidatesYielding } from "./candidates";
import { FEED_WINDOW, feedWork, saveWork, type WorkItem } from "./feed";
import {
	CONFLICT_KIND,
	RESOLVE_KIND,
	conflictHandler,
	currentPair,
	resolveHandler,
} from "./handlers";
import { PAIR_BATCH, judgeBatch, judgeSide, type JudgeItem } from "./judge";

export { PAIR_JUDGE_VERSION, CONFLICT_KIND, RESOLVE_KIND };
export {
	decideConflict,
	gatherStrength,
	STRENGTH,
	strengthScore,
} from "./strength";
export { scanCandidates, unjudgedCandidates } from "./candidates";

const unknown = (a: string, b: string, note: string): PairVerdict => ({
	a,
	b,
	verdict: "unknown",
	aNotAppliesWhen: [],
	bNotAppliesWhen: [],
	note,
});

/**
 * The conflict stage (6.5): the candidate pairs of the active canonicals are judged by the
 * model (`distill.conflict`, 8 pairs a job) and each duplicate, condition_split or conflict is
 * resolved (`distill.resolve`). The stage also finishes the duplicates whose merge cluster the
 * canonical stage has distilled since the last run.
 */
export function createConflict(deps: DistillDeps): ConflictModule {
	return {
		registerHandlers() {
			deps.queue.registerHandler(conflictHandler(deps));
			deps.queue.registerHandler(resolveHandler(deps));
		},

		async start(stage, runId, opts) {
			if (stage !== "conflict")
				throw new DistillError("invalid_distill_request");
			if (!opts.dryRun)
				await deps.store.write((db) =>
					reconcileMerges(db, deps.now().toISOString()),
				);

			// The scan is long: it runs outside any transaction and lets the event loop run.
			let unjudged = await unjudgedCandidatesYielding(
				deps.store,
				deps.spaceKey,
			);
			if (opts.limit !== undefined) unjudged = unjudged.slice(0, opts.limit);
			// Judged but not yet resolved (an earlier run stopped before its resolve job).
			const pending = deps.store.read((db) =>
				listPairJudgments(db, { resolution: "none" }).flatMap((j) => {
					if (
						j.verdict !== "duplicate" &&
						j.verdict !== "condition_split" &&
						j.verdict !== "conflict"
					)
						return [];
					const cur = currentPair(db, j.aId, j.bId);
					if (!cur || cur.aDigest !== j.aDigest || cur.bDigest !== j.bDigest)
						return [];
					// The merge cluster exists: the canonical stage has to run before there is more to do.
					if (
						j.verdict === "duplicate" &&
						getCluster(db, mergeClusterId(j.aId, j.bId))
					)
						return [];
					return [
						{ a: j.aId, b: j.bId, aDigest: j.aDigest, bDigest: j.bDigest },
					];
				}),
			);

			const items: WorkItem[] = [];
			for (let i = 0; i < unjudged.length; i += PAIR_BATCH)
				items.push({ t: "judge", pairs: unjudged.slice(i, i + PAIR_BATCH) });
			for (const pair of pending) items.push({ t: "resolve", pair });
			if (opts.dryRun || items.length === 0)
				return opts.dryRun ? items.length : 0;

			// One transaction: the work is kept, the first window is enqueued and the run's job
			// count is never behind the jobs in the queue. The rest is fed as jobs settle.
			const fresh = await deps.store.write((db) => {
				saveWork(db, runId, items, deps.now().toISOString());
				const jobs = feedWork(db, deps, runId, FEED_WINDOW);
				// Nothing could be handed out (the queue is full): the run does not start.
				if (getRun(db, runId)?.counts.fed === 0) throw new Error("queue_full");
				return jobs;
			});
			deps.queue.wake();
			return fresh > 0 ? items.length : 0;
		},

		async judgePairs(pairs, signal) {
			const out: (PairVerdict | null)[] = pairs.map(() => null);
			const todo: { index: number; item: JudgeItem }[] = [];
			deps.store.read((db) => {
				pairs.forEach(({ a, b }, index) => {
					const x = getKnowledgeById(db, a);
					const y = getKnowledgeById(db, b);
					if (!x || !y || a === b) {
						out[index] = unknown(a, b, "not_found");
						return;
					}
					// A judgment of the stage for these very texts is reused as it is.
					const stored = getPairJudgment(db, a, b);
					const [first, second] = a <= b ? [x, y] : [y, x];
					if (
						stored &&
						stored.aDigest === first.contentDigest &&
						stored.bDigest === second.contentDigest
					) {
						const forward = a <= b;
						const list = (v: unknown) =>
							Array.isArray(v)
								? v.filter((s): s is string => typeof s === "string")
								: [];
						const aNot = list(stored.detail.aNotAppliesWhen);
						const bNot = list(stored.detail.bNotAppliesWhen);
						out[index] = {
							a,
							b,
							verdict: stored.verdict,
							aNotAppliesWhen: forward ? aNot : bNot,
							bNotAppliesWhen: forward ? bNot : aNot,
							note: String(stored.detail.note ?? ""),
						};
						return;
					}
					todo.push({
						index,
						item: { a, b, aSide: judgeSide(x), bSide: judgeSide(y) },
					});
				});
			});
			const sig = signal ?? new AbortController().signal;
			for (let i = 0; i < todo.length; i += PAIR_BATCH) {
				const batch = todo.slice(i, i + PAIR_BATCH);
				const judged = await judgeBatch(deps, {
					runId: null,
					items: batch.map((t) => t.item),
					signal: sig,
					subjectRef: "judge",
				});
				batch.forEach((t, k) => {
					out[t.index] = judged.verdicts[k]!;
				});
			}
			return out as PairVerdict[];
		},
	};
}
