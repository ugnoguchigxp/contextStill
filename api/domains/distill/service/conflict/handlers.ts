import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getKnowledgeById, type KnowledgeRow } from "../../../knowledge";
import { LarmError } from "../../../larm";
import type { HandlerDefinition } from "../../../queue";
import type {
	DistillDeps,
	PairVerdict,
	PairVerdictKind,
} from "../../contracts";
import {
	PAIR_JUDGE_VERSION,
	PAIR_RECHECK_VERSION,
	type JudgeSide,
} from "../../prompts/pair-judge";
import {
	getPairJudgment,
	setPairResolution,
	upsertPairJudgment,
} from "../../repository";
import { noteEnqueued, noteSettled } from "./accounting";
import {
	CONFLICT_KIND,
	RESOLVE_KIND,
	enqueueResolveJob,
	isQueueFull,
} from "./jobs";
import {
	applySplit,
	applyWinner,
	openMergeCluster,
	openPairReview,
	strengthProposal,
} from "./apply";
import { judgeBatch, judgeSide, type JudgeItem } from "./judge";
import {
	buildRepoTerms,
	checkNovelty,
	hasAnySignal,
	repoSignals,
} from "../checks";
import { listRepoKeys } from "./reads";
import { canonicalAtomIds, decideConflict, gatherStrength } from "./strength";
import { verifyAddedConditions, type SplitVerdict } from "./split";

export {
	CONFLICT_KIND,
	RESOLVE_KIND,
	SCOPE,
	dedupeKeys,
	enqueueConflictJob,
	enqueueResolveJob,
} from "./jobs";
const EVIDENCE_TEXTS = 6;

export const conflictPayload = z.object({
	runId: z.string().min(1),
	pairs: z
		.array(z.tuple([z.string().min(1), z.string().min(1)]))
		.min(1)
		.max(8),
});
export const resolvePayload = z.object({
	runId: z.string().min(1),
	a: z.string().min(1),
	b: z.string().min(1),
});
type ConflictPayload = z.infer<typeof conflictPayload>;
type ResolvePayload = z.infer<typeof resolvePayload>;

/** Verdicts that need a resolve job after the judgment. */
export const NEEDS_RESOLVE: ReadonlySet<PairVerdictKind> = new Set([
	"duplicate",
	"condition_split",
	"conflict",
]);

/** larm_busy, larm_unreachable and larm_deploying are retried; everything else fails the job. */
export function classify(error: unknown): "retry" | "fail" {
	return error instanceof LarmError &&
		(error.code === "larm_busy" ||
			error.code === "larm_unreachable" ||
			error.code === "larm_deploying")
		? "retry"
		: "fail";
}

/** Both are active canonicals, in the order a < b, with the digests the judgment is about. */
export function currentPair(db: Database, x: string, y: string) {
	const [a, b] = x <= y ? [x, y] : [y, x];
	const ra = getKnowledgeById(db, a);
	const rb = getKnowledgeById(db, b);
	if (
		!ra ||
		!rb ||
		ra.layer !== "canonical" ||
		rb.layer !== "canonical" ||
		ra.status !== "active" ||
		rb.status !== "active"
	)
		return null;
	return { a, b, ra, rb, aDigest: ra.contentDigest, bDigest: rb.contentDigest };
}

function judgmentDetail(v: PairVerdict, extra: Record<string, unknown>) {
	return {
		note: v.note,
		aNotAppliesWhen: v.aNotAppliesWhen,
		bNotAppliesWhen: v.bNotAppliesWhen,
		promptVersion: PAIR_JUDGE_VERSION,
		...extra,
	};
}

// ---- distill.conflict ------------------------------------------------------------------

interface ConflictInput {
	runId: string;
	items: (JudgeItem & { aDigest: string; bDigest: string })[];
}
interface ConflictResult {
	verdicts: PairVerdict[];
	callId: string | null;
	invalid: boolean;
}

export function conflictHandler(
	deps: DistillDeps,
): HandlerDefinition<ConflictPayload, ConflictInput, ConflictResult> {
	const at = () => deps.now().toISOString();
	return {
		kind: CONFLICT_KIND,
		payloadVersions: [1],
		schema: conflictPayload,
		recovery: "replay_safe",
		resourceKey: "llm",
		prepareInTransaction(tx, claim) {
			const items: ConflictInput["items"] = [];
			for (const [x, y] of claim.payload.pairs) {
				const cur = currentPair(tx, x, y);
				if (!cur) continue;
				const j = getPairJudgment(tx, cur.a, cur.b);
				if (j && j.aDigest === cur.aDigest && j.bDigest === cur.bDigest)
					continue;
				items.push({
					a: cur.a,
					b: cur.b,
					aDigest: cur.aDigest,
					bDigest: cur.bDigest,
					aSide: judgeSide(cur.ra),
					bSide: judgeSide(cur.rb),
				});
			}
			if (items.length === 0) {
				noteSettled(tx, deps, claim.payload.runId, at());
				return { status: "stale", reason: "no_pairs_to_judge" };
			}
			return { status: "ready", input: { runId: claim.payload.runId, items } };
		},
		execute: (input, ctx) =>
			judgeBatch(deps, {
				runId: input.runId,
				items: input.items,
				signal: ctx.signal,
				subjectRef: `conflict:${ctx.jobId}`,
			}),
		classify,
		settleInTransaction(tx, claim, input, outcome) {
			const runId = claim.payload.runId;
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success" || !input) {
				noteSettled(tx, deps, runId, at(), { failed: true });
				return "applied";
			}
			const counts: Record<string, number> = {};
			const bump = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
			let spawned = 0;
			input.items.forEach((item, index) => {
				// The texts may have changed while the model was thinking; then the judgment is void.
				const cur = currentPair(tx, item.a, item.b);
				if (
					!cur ||
					cur.aDigest !== item.aDigest ||
					cur.bDigest !== item.bDigest
				)
					return;
				const v = outcome.result.verdicts[index]!;
				const owner = v.verdict === "unknown";
				upsertPairJudgment(tx, {
					aId: item.a,
					bId: item.b,
					aDigest: item.aDigest,
					bDigest: item.bDigest,
					verdict: v.verdict,
					resolution: owner ? "owner_pending" : "none",
					detail: judgmentDetail(
						v,
						outcome.result.invalid ? { invalid: true } : {},
					),
					callId: outcome.result.callId,
					at: at(),
				});
				bump("pairsJudged");
				bump(v.verdict);
				if (owner) {
					openPairReview(tx, {
						kind: "conflict",
						a: item.a,
						b: item.b,
						proposal: {
							verdict: "unknown",
							reason: outcome.result.invalid ? "llm_invalid_output" : "unknown",
							note: v.note,
						},
						at: at(),
					});
					bump("reviewsOpened");
				} else if (NEEDS_RESOLVE.has(v.verdict)) {
					try {
						if (enqueueResolveJob(deps, tx, runId, item)) spawned++;
					} catch (error) {
						// The queue is full. The judgment stays (resolution `none`) and the next
						// run resolves it; it must not roll the judgment back.
						if (!isQueueFull(error)) throw error;
						bump("resolveDeferred");
					}
				}
			});
			noteEnqueued(tx, runId, spawned);
			noteSettled(tx, deps, runId, at(), { counts });
			return "applied";
		},
		afterCommit: () => deps.queue.wake(),
		cancelInTransaction(tx, job) {
			noteSettled(tx, deps, job.payload.runId, at(), {
				counts: { cancelled: 1 },
			});
		},
	};
}

// ---- distill.resolve -------------------------------------------------------------------

interface ResolveInput {
	runId: string;
	verdict: PairVerdictKind;
	aDigest: string;
	bDigest: string;
	/**
	 * conflict with an automatic winner only: the pair is judged again with another prompt, the
	 * two sides swapped. The winner is that of the strength rule at prepare time.
	 */
	recheck?: {
		winner: "a" | "b";
		/** The pair as the second judgment sees it: b first. */
		items: JudgeItem[];
	};
	/** condition_split only */
	split?: {
		aSide: JudgeSide;
		bSide: JudgeSide;
		aAdd: string[];
		bAdd: string[];
		aEvidence: { title: string; body: string }[];
		bEvidence: { title: string; body: string }[];
		/** false: a condition names a repo, a path or a port, or says more than the texts do. */
		aGrounded: boolean;
		bGrounded: boolean;
	};
}
interface ResolveResult {
	a: SplitVerdict;
	b: SplitVerdict;
	/** The verdict of the second judgment of a conflict, when there was one. */
	recheck?: PairVerdictKind;
}

/**
 * The generalization lint and the novelty rule of 6.4 for the conditions a condition_split adds:
 * no repo name, path or port, and the words and literals must come from the two canonicals or
 * the evidence of the side (the verifier checks consistency, this checks that the model did not
 * bring in something of its own).
 */
function conditionsGrounded(
	added: readonly string[],
	repoTerms: readonly string[],
	supports: readonly string[],
): boolean {
	return added.every(
		(c) =>
			!hasAnySignal(repoSignals(c, repoTerms)) && checkNovelty(c, supports).ok,
	);
}

const textOf = (r: { title: string; body: string }) => `${r.title}\n${r.body}`;

function evidenceTexts(db: Database, canonicalId: string) {
	const out: { title: string; body: string }[] = [];
	for (const id of canonicalAtomIds(db, canonicalId)) {
		const atom: KnowledgeRow | null = getKnowledgeById(db, id);
		if (atom) out.push({ title: atom.title, body: atom.body });
		if (out.length >= EVIDENCE_TEXTS) break;
	}
	return out;
}

const stringList = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function resolveHandler(
	deps: DistillDeps,
): HandlerDefinition<ResolvePayload, ResolveInput, ResolveResult> {
	const at = () => deps.now().toISOString();
	/** The judgment this job is about, if it is still open and about the current texts. */
	const open = (db: Database, p: ResolvePayload) => {
		const cur = currentPair(db, p.a, p.b);
		if (!cur) return null;
		const j = getPairJudgment(db, cur.a, cur.b);
		if (
			!j ||
			j.resolution !== "none" ||
			!NEEDS_RESOLVE.has(j.verdict) ||
			j.aDigest !== cur.aDigest ||
			j.bDigest !== cur.bDigest
		)
			return null;
		return { cur, j };
	};
	return {
		kind: RESOLVE_KIND,
		payloadVersions: [1],
		schema: resolvePayload,
		recovery: "replay_safe",
		resourceKey: "llm",
		prepareInTransaction(tx, claim) {
			const found = open(tx, claim.payload);
			if (!found) {
				noteSettled(tx, deps, claim.payload.runId, at());
				return { status: "stale", reason: "pair_not_open" };
			}
			const { cur, j } = found;
			const input: ResolveInput = {
				runId: claim.payload.runId,
				verdict: j.verdict,
				aDigest: cur.aDigest,
				bDigest: cur.bDigest,
			};
			if (j.verdict === "condition_split") {
				const aAdd = stringList(j.detail.aNotAppliesWhen);
				const bAdd = stringList(j.detail.bNotAppliesWhen);
				const aEvidence = evidenceTexts(tx, cur.a);
				const bEvidence = evidenceTexts(tx, cur.b);
				const repoTerms = buildRepoTerms(listRepoKeys(tx));
				const both = [textOf(cur.ra), textOf(cur.rb)];
				input.split = {
					aSide: judgeSide(cur.ra),
					bSide: judgeSide(cur.rb),
					aAdd,
					bAdd,
					aEvidence,
					bEvidence,
					aGrounded: conditionsGrounded(aAdd, repoTerms, [
						...both,
						...aEvidence.map(textOf),
					]),
					bGrounded: conditionsGrounded(bAdd, repoTerms, [
						...both,
						...bEvidence.map(textOf),
					]),
				};
			} else if (j.verdict === "conflict") {
				const d = decideConflict(
					gatherStrength(tx, cur.a),
					gatherStrength(tx, cur.b),
				);
				if (d.winner)
					input.recheck = {
						winner: d.winner,
						items: [
							{
								a: cur.b,
								b: cur.a,
								aSide: judgeSide(cur.rb),
								bSide: judgeSide(cur.ra),
							},
						],
					};
			}
			return { status: "ready", input };
		},
		async execute(input, ctx) {
			if (input.recheck) {
				const judged = await judgeBatch(deps, {
					runId: input.runId,
					items: input.recheck.items,
					signal: ctx.signal,
					promptVersion: PAIR_RECHECK_VERSION,
					subjectRef: `recheck:${ctx.jobId}`,
				});
				return {
					a: "supported",
					b: "supported",
					recheck: judged.verdicts[0]?.verdict ?? "unknown",
				};
			}
			if (!input.split) return { a: "supported", b: "supported" };
			const s = input.split;
			const common = { runId: input.runId, signal: ctx.signal };
			// A condition that fails the lint or the novelty rule is not shown to the verifier.
			const a = s.aGrounded
				? await verifyAddedConditions(deps, {
						...common,
						subjectRef: `split:${ctx.jobId}:a`,
						item: s.aSide,
						added: s.aAdd,
						evidence: s.aEvidence,
					})
				: "rejected";
			const b = s.bGrounded
				? await verifyAddedConditions(deps, {
						...common,
						subjectRef: `split:${ctx.jobId}:b`,
						item: s.bSide,
						added: s.bAdd,
						evidence: s.bEvidence,
					})
				: "rejected";
			return { a, b };
		},
		classify,
		settleInTransaction(tx, claim, input, outcome) {
			const { runId } = claim.payload;
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success" || !input) {
				noteSettled(tx, deps, runId, at(), { failed: true });
				return "applied";
			}
			const counts: Record<string, number> = {};
			const found = open(tx, claim.payload);
			if (
				found &&
				found.cur.aDigest === input.aDigest &&
				found.cur.bDigest === input.bDigest
			) {
				const { cur, j } = found;
				const now = at();
				if (j.verdict === "duplicate") {
					const cluster = openMergeCluster(tx, cur.a, cur.b, now);
					if (cluster) counts.mergeClusters = 1;
					else {
						setOwner(tx, cur.a, cur.b, now);
						openPairReview(tx, {
							kind: "conflict",
							a: cur.a,
							b: cur.b,
							proposal: { verdict: "duplicate", reason: "no_evidence_atoms" },
							at: now,
						});
						counts.reviewsOpened = 1;
					}
				} else if (j.verdict === "conflict") {
					const sa = gatherStrength(tx, cur.a);
					const sb = gatherStrength(tx, cur.b);
					const d = decideConflict(sa, sb);
					const strength = strengthProposal(
						{ ...sa, ...d.a },
						{ ...sb, ...d.b },
					);
					// The loser leaves search only when a second judgment, with another prompt
					// and the sides swapped, also says conflict and the same side is the winner.
					const confirmed =
						d.winner !== null &&
						input.recheck?.winner === d.winner &&
						outcome.result.recheck === "conflict";
					if (d.winner && confirmed) {
						applyWinner(tx, {
							a: cur.a,
							b: cur.b,
							winner: d.winner,
							origin: "llm",
							evidence: {
								rule: "strength-v1",
								strength,
								recheck: PAIR_RECHECK_VERSION,
							},
							at: now,
						});
						counts.conflictAuto = 1;
					} else {
						setOwner(tx, cur.a, cur.b, now);
						openPairReview(tx, {
							kind: "conflict",
							a: cur.a,
							b: cur.b,
							proposal: {
								verdict: "conflict",
								reason: d.winner ? "recheck_disagreed" : d.reason,
								...(outcome.result.recheck !== undefined
									? { recheck: outcome.result.recheck }
									: {}),
								note: String(j.detail.note ?? ""),
								strength,
							},
							at: now,
						});
						counts.conflictOwner = 1;
						if (d.winner) counts.conflictRecheckDisagreed = 1;
					}
				} else if (input.split) {
					const ok =
						outcome.result.a === "supported" &&
						outcome.result.b === "supported";
					if (ok) {
						applySplit(
							tx,
							cur.a,
							cur.b,
							input.split.aAdd,
							input.split.bAdd,
							now,
						);
						counts.conditionSplit = 1;
					} else {
						setOwner(tx, cur.a, cur.b, now);
						openPairReview(tx, {
							kind: "verifier_unknown",
							a: cur.a,
							b: cur.b,
							proposal: {
								verdict: "condition_split",
								aNotAppliesWhen: input.split.aAdd,
								bNotAppliesWhen: input.split.bAdd,
								verifier: outcome.result,
							},
							at: now,
						});
						counts.reviewsOpened = 1;
					}
				}
			}
			noteSettled(tx, deps, runId, at(), { counts });
			return "applied";
		},
		cancelInTransaction(tx, job) {
			noteSettled(tx, deps, job.payload.runId, at(), {
				counts: { cancelled: 1 },
			});
		},
	};
}

function setOwner(db: Database, a: string, b: string, at: string): void {
	setPairResolution(db, a, b, "owner_pending", at);
}
