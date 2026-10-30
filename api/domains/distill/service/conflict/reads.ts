import type { Database } from "bun:sqlite";

/**
 * Read-only queries over tables of other domains that no public function of theirs covers
 * (a list of the active canonicals, counts for the status report, usage counts). Every query here
 * only reads; every write goes through the owning domain's functions. When knowledge or usage
 * grow these as public functions, replace the bodies and keep the signatures.
 */

export interface CanonicalListing {
	id: string;
	contentDigest: string;
	/** `metadata.distill.clusterId` written by the canonical stage, or null. */
	clusterId: string | null;
}

/** Active canonical items, oldest first. */
export function listActiveCanonicals(db: Database): CanonicalListing[] {
	return (
		db
			.query(
				`SELECT id, content_digest AS contentDigest,
				        json_extract(metadata_json, '$.distill.clusterId') AS clusterId
				 FROM knowledge_items WHERE layer = 'canonical' AND status = 'active'
				 ORDER BY seq`,
			)
			.all() as {
			id: string;
			contentDigest: string;
			clusterId: string | null;
		}[]
	).map((r) => ({
		id: r.id,
		contentDigest: r.contentDigest,
		clusterId: typeof r.clusterId === "string" ? r.clusterId : null,
	}));
}

/** The canonicals the canonical stage made from a claim cluster, newest first. */
export function canonicalsOfCluster(
	db: Database,
	clusterId: string,
): { id: string; status: string }[] {
	return db
		.query(
			`SELECT id, status FROM knowledge_items
			 WHERE layer = 'canonical' AND json_extract(metadata_json, '$.distill.clusterId') = ?
			 ORDER BY seq DESC`,
		)
		.all(clusterId) as { id: string; status: string }[];
}

export function listSupersededAtoms(db: Database): string[] {
	return (
		db
			.query(
				"SELECT id FROM knowledge_items WHERE layer = 'atom' AND status = 'superseded' ORDER BY seq",
			)
			.all() as { id: string }[]
	).map((r) => r.id);
}

export function atomCounts(db: Database): {
	superseded: number;
	evidence_only: number;
	searchable_unabsorbed: number;
	unassessed: number;
} {
	const r = db
		.query(
			`SELECT
			   coalesce(sum(k.status = 'superseded'), 0) AS superseded,
			   coalesce(sum(k.status = 'active' AND k.retrieval = 'evidence_only'), 0) AS evidenceOnly,
			   coalesce(sum(k.status = 'active' AND k.retrieval = 'searchable'), 0) AS searchable,
			   coalesce(sum(k.status = 'active' AND NOT EXISTS (
			     SELECT 1 FROM distill_assessments a
			     WHERE a.owner_kind = 'knowledge' AND a.owner_id = k.id)), 0) AS unassessed
			 FROM knowledge_items k WHERE k.layer = 'atom'`,
		)
		.get() as {
		superseded: number;
		evidenceOnly: number;
		searchable: number;
		unassessed: number;
	};
	return {
		superseded: r.superseded,
		evidence_only: r.evidenceOnly,
		searchable_unabsorbed: r.searchable,
		unassessed: r.unassessed,
	};
}

export function canonicalStatusCounts(db: Database): {
	active: number;
	retracted: number;
	superseded: number;
} {
	const out = { active: 0, retracted: 0, superseded: 0 };
	const rows = db
		.query(
			"SELECT status, count(*) AS n FROM knowledge_items WHERE layer = 'canonical' GROUP BY status",
		)
		.all() as { status: string; n: number }[];
	for (const r of rows)
		if (
			r.status === "active" ||
			r.status === "retracted" ||
			r.status === "superseded"
		)
			out[r.status] = r.n;
	return out;
}

/** How often the items were reported as used (verdict `used`). */
export function usedCount(db: Database, ids: readonly string[]): number {
	if (ids.length === 0) return 0;
	const marks = ids.map(() => "?").join(", ");
	const r = db
		.query(
			`SELECT count(*) AS n FROM usage_events
			 WHERE owner_kind = 'knowledge' AND verdict = 'used' AND owner_id IN (${marks})`,
		)
		.get(...ids) as { n: number };
	return r.n;
}

/** Every repo key the knowledge items carry: the source of the repo terms of the generalization lint. */
export function listRepoKeys(db: Database): string[] {
	return (
		db
			.query(
				"SELECT DISTINCT repo_key FROM knowledge_items WHERE repo_key IS NOT NULL ORDER BY repo_key",
			)
			.all() as { repo_key: string }[]
	).map((r) => r.repo_key);
}
