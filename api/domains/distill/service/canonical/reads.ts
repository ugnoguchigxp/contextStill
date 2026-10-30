import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../../infrastructure/digest";
import {
	getKnowledgeById,
	listSupersededBy,
	type KnowledgeRow,
} from "../../../knowledge";
import { getReview } from "../../repository";
import type { ReviewKind } from "../../contracts";

/**
 * Reads of other domains' tables (allowed for distill, plan 5.1): usage totals, the repo keys,
 * and the atoms that belong to no claim cluster. Nothing here writes.
 */

export function usageTotals(
	db: Database,
	ids: readonly string[],
): Map<string, { used: number; notUsed: number }> {
	const out = new Map<string, { used: number; notUsed: number }>();
	for (const id of ids) out.set(id, { used: 0, notUsed: 0 });
	if (ids.length === 0) return out;
	const rows = db
		.query(
			`SELECT owner_id, verdict, count(*) AS n FROM usage_events
			 WHERE owner_kind = 'knowledge' AND verdict IN ('used', 'not_used')
			   AND owner_id IN (${ids.map(() => "?").join(", ")})
			 GROUP BY owner_id, verdict`,
		)
		.all(...ids) as { owner_id: string; verdict: string; n: number }[];
	for (const r of rows) {
		const t = out.get(r.owner_id);
		if (!t) continue;
		if (r.verdict === "used") t.used = r.n;
		else t.notUsed = r.n;
	}
	return out;
}

/** Every repo_key of knowledge and episodes (the input of `buildRepoTerms`). */
export function allRepoKeys(db: Database): string[] {
	return (
		db
			.query(
				`SELECT repo_key FROM knowledge_items WHERE repo_key IS NOT NULL
				 UNION SELECT repo_key FROM episodes WHERE repo_key IS NOT NULL`,
			)
			.all() as { repo_key: string }[]
	).map((r) => r.repo_key);
}

/** Clusters made under `allowUnverified` carry this mark in `algorithm`; canonical refuses them (6.0). */
export const isUnverifiedAlgorithm = (algorithm: string): boolean =>
	algorithm.includes("|unverified");

/** The cluster an atom is read for: a merge cluster, or the cluster whose canonical may already hold it. */
export interface MemberScope {
	merge: boolean;
	clusterId: string | null;
}

/** True when an active canonical made from this cluster superseded the atom (rule A(c)). */
function supersededByClusterCanonical(
	db: Database,
	atomId: string,
	clusterId: string,
): boolean {
	return listSupersededBy(db, atomId).some((id) => {
		const canonical = getKnowledgeById(db, id);
		const distill = canonical?.metadata.distill as
			| { clusterId?: unknown }
			| undefined;
		return (
			canonical !== null &&
			canonical.layer === "canonical" &&
			canonical.status === "active" &&
			distill?.clusterId === clusterId
		);
	});
}

/**
 * Whether an atom may be (re)distilled in this job. Never a personal atom (it does not become a
 * canonical before N6). Otherwise one of: active and searchable; any active or superseded atom
 * of a merge cluster (the old canonicals absorbed them); an atom superseded by the active
 * canonical this same cluster made earlier (a re-run after a partial settle or a late member).
 */
export function atomUsable(
	db: Database,
	row: KnowledgeRow | null,
	scope: MemberScope,
): row is KnowledgeRow {
	if (row === null || row.layer !== "atom" || row.space === "personal")
		return false;
	if (row.status === "active")
		return scope.merge || row.retrieval === "searchable";
	if (row.status !== "superseded") return false;
	if (scope.merge) return true;
	return (
		scope.clusterId !== null &&
		supersededByClusterCanonical(db, row.id, scope.clusterId)
	);
}

/**
 * Active searchable atoms judged general or generalizable (on their current text) that are in no
 * claim cluster that still stands, with id above `after`, in id order.
 */
export function listSingleCandidates(
	db: Database,
	after: string,
	limit: number,
): string[] {
	return (
		db
			.query(
				`SELECT k.id FROM knowledge_items k
				 JOIN distill_assessments a
				   ON a.owner_kind = 'knowledge' AND a.owner_id = k.id AND a.content_digest = k.content_digest
				 WHERE k.layer = 'atom' AND k.status = 'active' AND k.retrieval = 'searchable'
				   AND k.space <> 'personal'
				   AND a.generality IN ('general', 'generalizable') AND k.id > ?
				   AND NOT EXISTS (
				     SELECT 1 FROM map_cluster_members m JOIN map_clusters c ON c.id = m.cluster_id
				     WHERE m.member_kind = 'knowledge' AND m.member_id = k.id
				       AND c.kind = 'claim' AND c.state != 'stale')
				 ORDER BY k.id LIMIT ?`,
			)
			.all(after, limit) as { id: string }[]
	).map((r) => r.id);
}

/**
 * The id of the review for a group: from the kind and the atoms with their content digests, so
 * the same input opens the same review once (an existing one, open or settled, is kept).
 */
export function reviewId(
	kind: ReviewKind,
	atoms: readonly { id: string; contentDigest: string }[],
): string {
	const parts = atoms
		.map((a) => `${a.id}:${a.contentDigest}`)
		.sort()
		.join("|");
	return `rv_${sha256Hex(`${kind}|${parts}`).slice(0, 32)}`;
}

/**
 * True when the atom alone is held by a review: a host_rejected or verifier_unknown one, open or
 * settled (the same input would only give the same answer again), or a generality one while it is
 * open. Once the owner has settled the generality, the atom is planned again if it is still usable.
 */
export function hasSingleReview(
	db: Database,
	atom: { id: string; contentDigest: string },
): boolean {
	if (getReview(db, reviewId("generality", [atom]))?.state === "open")
		return true;
	return (["host_rejected", "verifier_unknown"] as const).some(
		(kind) => getReview(db, reviewId(kind, [atom])) !== null,
	);
}
