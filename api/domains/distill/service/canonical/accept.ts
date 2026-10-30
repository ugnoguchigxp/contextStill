import type { Database } from "bun:sqlite";
import { getKnowledgeById, type KnowledgeRow } from "../../../knowledge";
import {
	getCluster,
	listClusterMembers,
	memberDigest,
	memberKey,
	setClusterState,
} from "../../../map";
import { canonicalDraft, DistillError, type ReviewRow } from "../../contracts";
import { getAssessment, listReviews } from "../../repository";
import { MERGE_ALGORITHM } from "../conflict/apply";
import { buildRepoTerms } from "../checks";
import {
	allRepoKeys,
	atomUsable,
	isUnverifiedAlgorithm,
	reviewId,
	usageTotals,
} from "./reads";
import { writeCanonical } from "./settle";
import type { AtomView, GroupResult, UnitInput } from "./types";

const strings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The owner adopts the draft of a `host_rejected` or `verifier_unknown` review of the canonical
 * stage (`proposal.draft`, claims given by atom ids). It is written by the rules of the normal
 * settle (one canonical, its evidence and supersedes edges, the atoms retired, the cluster
 * distilled once no review of it is open), inside the caller's transaction. The owner stands in
 * for the host checks and the verifier. `invalid_distill_request` when there is no draft or the
 * atoms or the cluster changed since the review was opened.
 */
export function acceptReviewedDraft(
	db: Database,
	review: ReviewRow,
	at: string,
): { canonicalId: string } {
	const invalid = () => new DistillError("invalid_distill_request");
	if (review.kind !== "host_rejected" && review.kind !== "verifier_unknown")
		throw invalid();
	const parsed = canonicalDraftOf(review.proposal.draft);
	if (!parsed) throw invalid();

	const clusterId =
		typeof review.subject.clusterId === "string"
			? review.subject.clusterId
			: null;
	const cluster = clusterId ? getCluster(db, clusterId) : null;
	if (
		clusterId &&
		(!cluster ||
			cluster.kind !== "claim" ||
			isUnverifiedAlgorithm(cluster.algorithm))
	)
		throw invalid();
	const merge = cluster?.algorithm === MERGE_ALGORITHM;

	const rows = strings(review.subject.atomIds)
		.sort()
		.map((id) => getKnowledgeById(db, id));
	if (rows.length === 0 || !rows.every((r): r is KnowledgeRow => r !== null))
		throw invalid();
	const atoms = rows as KnowledgeRow[];
	const scope = { merge, clusterId };
	const live = (r: KnowledgeRow) => atomUsable(db, r, scope);
	// The review id comes from the kind and the atoms' content digests: it differs if one changed.
	if (
		!atoms.every(live) ||
		reviewId(review.kind, atoms) !== review.id ||
		(cluster && !clusterIsCurrent(db, cluster.id, cluster.memberDigest))
	)
		throw invalid();

	const usage = usageTotals(
		db,
		atoms.map((a) => a.id),
	);
	const views: AtomView[] = atoms.map((row, i) => ({
		alias: `a${i + 1}`,
		row,
		generality: getAssessment(db, "knowledge", row.id)?.generality ?? null,
		used: usage.get(row.id)?.used ?? 0,
		notUsed: usage.get(row.id)?.notUsed ?? 0,
	}));
	const aliasOf = new Map(views.map((v) => [v.row.id, v.alias]));
	const draft = canonicalDraft.safeParse({
		...parsed,
		claims: parsed.claims.map((c) => ({
			text: c.text,
			support: c.supportIds
				.map((id) => aliasOf.get(id))
				.filter((a): a is string => a !== undefined),
		})),
	});
	if (!draft.success) throw invalid();

	const input: UnitInput = {
		runId: `review:${review.id}`,
		kind: clusterId ? "cluster" : "singles",
		clusterId,
		memberDigest: cluster?.memberDigest ?? "",
		merge,
		atoms: views,
		// The facets are copied from the atoms, so the repo names still have to be known.
		repoTerms: buildRepoTerms(allRepoKeys(db)),
	};
	const callId = (v: unknown) =>
		typeof v === "string" && v !== "" ? v : `review:${review.id}`;
	const group: Extract<GroupResult, { kind: "canonical" }> = {
		kind: "canonical",
		members: views.map((v) => v.alias),
		draft: draft.data,
		plannerCallId: callId(review.proposal.plannerCallId),
		verifierCallId: callId(review.proposal.verifierCallId),
		polarityTie: false,
		index: 0,
	};
	const made = writeCanonical(db, input, group, views, new Set(), at);

	if (clusterId) {
		const stillOpen = listReviews(db, "open").some(
			(r) => r.id !== review.id && r.subject.clusterId === clusterId,
		);
		if (!stillOpen) setClusterState(db, clusterId, "distilled", at);
	}
	return { canonicalId: made.id };
}

/** The draft of a proposal: the stored shape with `supportIds`, or null when it is not one. */
function canonicalDraftOf(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (!Array.isArray(v.claims)) return null;
	const claims: { text: string; supportIds: string[] }[] = [];
	for (const c of v.claims) {
		if (!c || typeof c !== "object") return null;
		const claim = c as Record<string, unknown>;
		if (typeof claim.text !== "string") return null;
		claims.push({ text: claim.text, supportIds: strings(claim.supportIds) });
	}
	return { ...v, claims } as Record<string, unknown> & {
		claims: { text: string; supportIds: string[] }[];
	};
}

/** True when the cluster's members still hash to the digest it was made with. */
function clusterIsCurrent(db: Database, id: string, digest: string): boolean {
	const members = listClusterMembers(db, id);
	if (members.some((m) => m.kind !== "knowledge")) return true;
	const digests = new Map<string, string>();
	for (const m of members) {
		const row = getKnowledgeById(db, m.id);
		if (!row) return false;
		digests.set(memberKey("knowledge", m.id), row.contentDigest);
	}
	return memberDigest(members, digests) === digest;
}
