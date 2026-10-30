import { getKnowledgeById } from "../../../knowledge";
import {
	DistillError,
	pairOutput,
	type DistillDeps,
	type ReviewDecision,
	type ReviewModule,
} from "../../contracts";
import {
	SPLIT_PROPOSE_VERSION,
	splitProposeSystem,
} from "../../prompts/condition-split";
import { pairJudgeUser } from "../../prompts/pair-judge";
import { getPairJudgment, getReview, listReviews } from "../../repository";
import { judgeSide } from "../conflict/judge";
import { callJson } from "../llm";
import {
	applyDecision,
	checkDecision,
	pairIsLive,
	settle,
	type ReviewHooks,
} from "./resolve";
import { buildStatus } from "./status";

/** The longest the model may take to propose the conditions of a split. */
export const SPLIT_PROPOSE_TIMEOUT_MS = 120_000;

/**
 * The owner's queue (5.8) and the status report. `resolveReview` does what the decision means
 * and settles the review in one transaction; a decision the kind does not take is refused with
 * `invalid_distill_request`, an unknown id is `distill_not_found`.
 */
export type { ReviewHooks };
export function createReview(
	deps: DistillDeps,
	hooks: ReviewHooks = {},
): ReviewModule {
	return {
		listReviews: (state) => deps.store.read((db) => listReviews(db, state)),

		async resolveReview(
			id: string,
			decision: ReviewDecision,
			signal?: AbortSignal,
		) {
			const review = deps.store.read((db) => getReview(db, id));
			if (!review) throw new DistillError("distill_not_found");
			if (review.state !== "open")
				throw new DistillError("invalid_distill_request");
			checkDecision(review, decision);

			// "split" for a pair the judge did not split needs conditions: ask the model first, so
			// the model call is outside the write transaction.
			let proposed: {
				aNotAppliesWhen: string[];
				bNotAppliesWhen: string[];
			} | null = null;
			if (decision.kind === "split" && review.subject.type === "pair") {
				const a = String(review.subject.a);
				const b = String(review.subject.b);
				const read = deps.store.read((db) => {
					const j = getPairJudgment(db, a, b);
					return {
						j,
						live: j !== null && pairIsLive(db, { a, b }, j),
						x: getKnowledgeById(db, a),
						y: getKnowledgeById(db, b),
					};
				});
				// Nothing is asked of the model about a pair that can no longer be decided.
				if (read.j && !read.live)
					throw new DistillError("invalid_distill_request");
				if (
					read.j &&
					read.j.verdict !== "condition_split" &&
					read.x &&
					read.y
				) {
					const { value } = await callJson(deps, {
						runId: null,
						stage: "conflict",
						subjectRef: `review:${id}`,
						promptVersion: SPLIT_PROPOSE_VERSION,
						system: splitProposeSystem(),
						user: pairJudgeUser([
							{ a: judgeSide(read.x), b: judgeSide(read.y) },
						]),
						schema: pairOutput,
						maxOutputTokens: 1000,
						// The request's signal, and an upper bound of its own: the call is made inside an HTTP
						// request and must neither outlive the client nor run for ten minutes.
						signal: AbortSignal.any([
							...(signal ? [signal] : []),
							AbortSignal.timeout(SPLIT_PROPOSE_TIMEOUT_MS),
						]),
					});
					const p = value.pairs.find((x) => x.index === 0);
					if (p?.verdict === "condition_split")
						proposed = {
							aNotAppliesWhen: p.aNotAppliesWhen,
							bNotAppliesWhen: p.bNotAppliesWhen,
						};
				}
			}

			await deps.store.write((db) => {
				const at = deps.now().toISOString();
				// Read again inside the transaction: another request may have settled it.
				const current = getReview(db, id);
				if (!current || current.state !== "open")
					throw new DistillError("invalid_distill_request");
				const effect = applyDecision(
					db,
					current,
					decision,
					proposed,
					at,
					hooks,
				);
				settle(db, current, decision, effect, at);
			});
		},

		status: () =>
			deps.store.read((db) =>
				buildStatus(db, deps.spaceKey, deps.queue.stats()),
			),
	};
}
