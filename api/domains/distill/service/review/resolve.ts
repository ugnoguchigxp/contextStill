import type { Database } from "bun:sqlite";
import { getEpisodeById, setEpisodeRetrieval } from "../../../experience";
import {
	getKnowledgeById,
	listSupersededBy,
	setKnowledgeDisposition,
	type KnowledgeRow,
} from "../../../knowledge";
import {
	edgesFrom,
	getCluster,
	setClusterState,
	setEdgeStatus,
} from "../../../map";
import {
	DistillError,
	type Generality,
	type PairJudgmentRow,
	type ReviewDecision,
	type ReviewRow,
} from "../../contracts";
import {
	getAssessment,
	getPairJudgment,
	listPairJudgments,
	listReviews,
	settleReview,
	upsertAssessment,
	upsertPairJudgment,
	setPairResolution,
} from "../../repository";
import {
	addNotAppliesWhen,
	applySplit,
	applyWinner,
	isActiveCanonical,
	retractCanonical,
} from "../conflict/apply";
import { canonicalsOfCluster } from "../conflict/reads";
import { canonicalAtomIds } from "../conflict/strength";

/** Decisions each kind of review takes; `dismiss` is always allowed. */
const ALLOWED: Record<ReviewRow["kind"], readonly ReviewDecision["kind"][]> = {
	conflict: ["a_wins", "b_wins", "split", "keep_both"],
	verifier_unknown: ["accept", "reject"],
	host_rejected: ["accept", "reject"],
	low_confidence: ["accept", "reject"],
	generality: ["set_generality"],
};

/**
 * Functions other stages provide to the owner's queue. `acceptDraft` writes the draft of a
 * canonical-stage review (service/canonical `acceptReviewedDraft`) inside the caller's
 * transaction and returns the canonical's id.
 */
export interface ReviewHooks {
	acceptDraft?: (
		db: Database,
		review: ReviewRow,
		at: string,
	) => { canonicalId: string };
}

export function checkDecision(
	review: ReviewRow,
	decision: ReviewDecision,
): void {
	if (decision.kind === "dismiss") return;
	if (!ALLOWED[review.kind].includes(decision.kind))
		throw new DistillError("invalid_distill_request");
}

const str = (v: unknown): string | null =>
	typeof v === "string" && v !== "" ? v : null;
const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The two canonicals of a pair review, in the stored order (a < b). */
function pairOf(review: ReviewRow): { a: string; b: string } | null {
	const a = str(review.subject.a);
	const b = str(review.subject.b);
	return review.subject.type === "pair" && a && b ? { a, b } : null;
}

const POSITIVE: ReadonlySet<Generality> = new Set(["general", "generalizable"]);

/** What an owner decision does to the rows, inside the caller's transaction. */
export function applyDecision(
	db: Database,
	review: ReviewRow,
	decision: ReviewDecision,
	/** Conditions for `split` when the judgment has none (proposed beforehand). */
	proposed: { aNotAppliesWhen: string[]; bNotAppliesWhen: string[] } | null,
	at: string,
	hooks: ReviewHooks = {},
): Record<string, unknown> {
	const pair = pairOf(review);
	const judgment: PairJudgmentRow | null = pair
		? getPairJudgment(db, pair.a, pair.b)
		: null;

	if (decision.kind === "dismiss") {
		// A conflict (or an unknown) between two canonicals that are both still active stays
		// open for the audit: dismissing the review does not make the contradiction go away.
		if (
			pair &&
			judgment &&
			judgment.resolution === "owner_pending" &&
			!(
				(judgment.verdict === "conflict" || judgment.verdict === "unknown") &&
				pairIsLive(db, pair, judgment)
			)
		)
			setPairResolution(db, pair.a, pair.b, "owner_resolved", at);
		return { decision: "dismiss" };
	}

	if (review.kind === "conflict") {
		if (!pair || !judgment) throw new DistillError("invalid_distill_request");
		// The owner decides about the texts the judgment is about, and both must still be active.
		if (!pairIsLive(db, pair, judgment))
			throw new DistillError("invalid_distill_request");
		if (decision.kind === "a_wins" || decision.kind === "b_wins") {
			applyWinner(db, {
				a: pair.a,
				b: pair.b,
				winner: decision.kind === "a_wins" ? "a" : "b",
				origin: "human",
				evidence: { rule: "owner", reviewId: review.id },
				at,
			});
		} else if (decision.kind === "keep_both") {
			upsertPairJudgment(db, {
				...judgment,
				verdict: "compatible",
				resolution: "owner_resolved",
				detail: { ...judgment.detail, origin: "human", reviewId: review.id },
				at,
			});
		} else {
			const aAdd =
				judgment.verdict === "condition_split"
					? strings(judgment.detail.aNotAppliesWhen)
					: (proposed?.aNotAppliesWhen ?? []);
			const bAdd =
				judgment.verdict === "condition_split"
					? strings(judgment.detail.bNotAppliesWhen)
					: (proposed?.bNotAppliesWhen ?? []);
			if (aAdd.length === 0 && bAdd.length === 0)
				throw new DistillError("host_rejected");
			// The owner is the verifier here, so the conditions are added as they are.
			applySplit(db, pair.a, pair.b, aAdd, bAdd, at);
			upsertPairJudgment(db, {
				...judgment,
				verdict: "condition_split",
				resolution: "split",
				detail: {
					...judgment.detail,
					aNotAppliesWhen: aAdd,
					bNotAppliesWhen: bAdd,
					origin: "human",
					reviewId: review.id,
				},
				at,
			});
		}
		return { decision: decision.kind };
	}

	if (review.kind === "verifier_unknown" && pair) {
		if (!judgment) throw new DistillError("invalid_distill_request");
		if (decision.kind === "accept") {
			if (!pairIsLive(db, pair, judgment))
				throw new DistillError("invalid_distill_request");
			applySplit(
				db,
				pair.a,
				pair.b,
				strings(review.proposal.aNotAppliesWhen),
				strings(review.proposal.bNotAppliesWhen),
				at,
			);
		} else setPairResolution(db, pair.a, pair.b, "owner_resolved", at);
		return { decision: decision.kind };
	}

	if (review.kind === "verifier_unknown" || review.kind === "host_rejected") {
		if (decision.kind === "accept") {
			// Adopt the draft the canonical stage held back.
			if (!hooks.acceptDraft) throw new DistillError("invalid_distill_request");
			const { canonicalId } = hooks.acceptDraft(db, review, at);
			return { decision: "accept", canonicalId };
		}
		if (decision.kind !== "reject")
			throw new DistillError("invalid_distill_request");
		// The atoms of the group stay as they are. A review is about one group of a cluster: the
		// cluster is closed only when no other review of it is open, as `rejected` when the
		// canonical stage made nothing from it and as `distilled` when other groups were made.
		const clusterId = str(review.subject.clusterId);
		if (clusterId) closeClusterAfterReject(db, clusterId, review.id, at);
		return { decision: "reject" };
	}

	if (review.kind === "low_confidence") {
		const canonicalId = str(review.subject.canonicalId);
		if (decision.kind === "reject" && canonicalId)
			rejectCanonical(db, canonicalId, at);
		return { decision: decision.kind };
	}

	if (review.kind === "generality" && decision.kind === "set_generality") {
		setGenerality(db, review, decision.generality, at);
		return { decision: "set_generality", generality: decision.generality };
	}
	throw new DistillError("invalid_distill_request");
}

/** Both canonicals of the pair are active and the judgment is about their current texts. */
export function pairIsLive(
	db: Database,
	pair: { a: string; b: string },
	judgment: PairJudgmentRow,
): boolean {
	const a = getKnowledgeById(db, pair.a);
	const b = getKnowledgeById(db, pair.b);
	return (
		isActiveCanonical(a) &&
		isActiveCanonical(b) &&
		a.contentDigest === judgment.aDigest &&
		b.contentDigest === judgment.bDigest
	);
}

function closeClusterAfterReject(
	db: Database,
	clusterId: string,
	reviewId: string,
	at: string,
): void {
	const cluster = getCluster(db, clusterId);
	if (!cluster) return;
	const stillOpen = listReviews(db, "open").some(
		(r) => r.id !== reviewId && r.subject.clusterId === clusterId,
	);
	if (stillOpen) return;
	const made = canonicalsOfCluster(db, clusterId).some(
		(c) => c.status === "active",
	);
	setClusterState(db, clusterId, made ? "distilled" : "rejected", at);
}

/**
 * low_confidence rejected: the canonical leaves search, and everything that stood only for it
 * comes back. That is every atom it was derived from that no other active or superseded
 * canonical carries (they are `superseded`, or `retracted` by the retract that follows), and
 * every canonical a merge had superseded in its favour. The cluster it was made from is
 * `rejected`, so that the canonical stage does not plan it again. A canonical whose id was
 * reused for a later cluster is handled the same way: all its atoms are looked at, not only
 * those of the review.
 */
function rejectCanonical(db: Database, canonicalId: string, at: string): void {
	const row = getKnowledgeById(db, canonicalId);
	if (!row || row.layer !== "canonical") return;
	const atomIds = canonicalAtomIds(db, canonicalId);
	retractCanonical(db, canonicalId, at);
	for (const id of atomIds) {
		const atom = getKnowledgeById(db, id);
		if (
			(atom?.status === "retracted" || atom?.status === "superseded") &&
			listSupersededBy(db, id).length === 0
		)
			setKnowledgeDisposition(db, id, {
				status: "active",
				retrieval: "searchable",
				updatedAt: at,
			});
	}
	// Canonicals that a duplicate merge superseded in favour of this one.
	for (const edge of edgesFrom(db, "knowledge", canonicalId, "supersedes")) {
		if (edge.status !== "active" || edge.dst.kind !== "knowledge") continue;
		const old = getKnowledgeById(db, edge.dst.id);
		if (old?.layer !== "canonical" || old.status !== "superseded") continue;
		setKnowledgeDisposition(db, old.id, {
			status: "active",
			retrieval: "searchable",
			updatedAt: at,
		});
		setEdgeStatus(db, edge.id, "retracted", at);
		for (const j of listPairJudgments(db, { resolution: "merged" }))
			if (j.aId === old.id || j.bId === old.id)
				setPairResolution(db, j.aId, j.bId, "owner_pending", at);
	}
	const clusterId =
		str(
			(row.metadata.distill as { clusterId?: unknown } | undefined)?.clusterId,
		) ?? null;
	if (clusterId) setClusterState(db, clusterId, "rejected", at);
}

function setGenerality(
	db: Database,
	review: ReviewRow,
	generality: Generality,
	at: string,
): void {
	const ownerKind =
		review.subject.ownerKind === "episode" ? "episode" : "knowledge";
	const ownerId = str(review.subject.ownerId);
	if (!ownerId) throw new DistillError("invalid_distill_request");
	const row: KnowledgeRow | null =
		ownerKind === "knowledge" ? getKnowledgeById(db, ownerId) : null;
	if (ownerKind === "knowledge" ? !row : !getEpisodeById(db, ownerId))
		throw new DistillError("distill_not_found");
	const before = getAssessment(db, ownerKind, ownerId);
	upsertAssessment(db, {
		ownerKind,
		ownerId,
		generality,
		signals: before?.signals ?? {},
		reason: `owner (review ${review.id})`,
		origin: "human",
		contentDigest: row?.contentDigest ?? before?.contentDigest ?? "",
		promptVersion: before?.promptVersion ?? "human",
		callId: null,
		at,
	});
	const retrieval = POSITIVE.has(generality) ? "searchable" : "evidence_only";
	if (row) {
		// An absorbed or retracted atom stays out of search whatever the owner says.
		if (row.status === "active")
			setKnowledgeDisposition(db, ownerId, { retrieval, updatedAt: at });
	} else setEpisodeRetrieval(db, ownerId, retrieval, at);
}

/** Settles the review row; a second settlement of the same review is refused. */
export function settle(
	db: Database,
	review: ReviewRow,
	decision: ReviewDecision,
	effect: Record<string, unknown>,
	at: string,
): void {
	const state = decision.kind === "dismiss" ? "dismissed" : "resolved";
	if (!settleReview(db, review.id, state, { ...effect, at }, at))
		throw new DistillError("invalid_distill_request");
}

export { addNotAppliesWhen };
