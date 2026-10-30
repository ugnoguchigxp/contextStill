import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { makeHandle } from "../../../infrastructure/handle";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import type {
	ClusterInput,
	ClusterKind,
	ClusterMember,
	ClusterRow,
	ClusterState,
	EdgeInput,
	EdgeRow,
	EdgeStatus,
	FacetConceptInput,
	FacetConceptRow,
	FacetKey,
	MemberKind,
	NodeKind,
	Relation,
} from "../contracts";

export { migrations } from "./migrations";

export const themeHandle = (id: string): string => makeHandle("theme", id);

/** The key of a member in the `contentDigests` map given to `memberDigest`. */
export const memberKey = (kind: MemberKind, id: string): string =>
	`${kind}:${id}`;

/**
 * sha256(canonicalJson(members sorted by kind, id as [kind, id, contentDigest])). `contentDigests`
 * is keyed by `memberKey(kind, id)`; a member without a digest is a caller error.
 */
export function memberDigest(
	members: readonly Pick<ClusterMember, "kind" | "id">[],
	contentDigests: ReadonlyMap<string, string>,
): string {
	const triples = [...members]
		.sort((a, b) =>
			a.kind !== b.kind
				? a.kind < b.kind
					? -1
					: 1
				: a.id < b.id
					? -1
					: a.id > b.id
						? 1
						: 0,
		)
		.map((m) => {
			const digest = contentDigests.get(memberKey(m.kind, m.id));
			if (digest === undefined) throw new Error("member_digest_missing");
			return [m.kind, m.id, digest];
		});
	return sha256Hex(canonicalJson(triples));
}

interface ClusterDbRow {
	id: string;
	kind: ClusterKind;
	parent_id: string | null;
	level: 0 | 1 | 2;
	handle: string | null;
	name: string;
	aliases_json: string;
	description: string;
	summary_json: string;
	state: ClusterState;
	member_digest: string;
	algorithm: string;
	revision: number;
	created_at: string;
	updated_at: string;
}

const CLUSTER_COLUMNS = `id, kind, parent_id, level, handle, name, aliases_json, description,
  summary_json, state, member_digest, algorithm, revision, created_at, updated_at`;

function toCluster(r: ClusterDbRow): ClusterRow {
	return {
		id: r.id,
		kind: r.kind,
		parentId: r.parent_id,
		level: r.level,
		handle: r.handle,
		name: r.name,
		aliases: JSON.parse(r.aliases_json) as string[],
		description: r.description,
		summary: JSON.parse(r.summary_json) as Record<string, unknown>,
		state: r.state,
		memberDigest: r.member_digest,
		algorithm: r.algorithm,
		revision: r.revision,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export function getCluster(db: Database, id: string): ClusterRow | null {
	const row = db
		.query(`SELECT ${CLUSTER_COLUMNS} FROM map_clusters WHERE id = ?`)
		.get(id) as ClusterDbRow | null;
	return row ? toCluster(row) : null;
}

export function getClusterByHandle(
	db: Database,
	handle: string,
): ClusterRow | null {
	const row = db
		.query(`SELECT ${CLUSTER_COLUMNS} FROM map_clusters WHERE handle = ?`)
		.get(handle) as ClusterDbRow | null;
	return row ? toCluster(row) : null;
}

export function listClusters(
	db: Database,
	filter: {
		kind?: ClusterKind;
		state?: ClusterState;
		parentId?: string | null;
	} = {},
): ClusterRow[] {
	const where: string[] = [];
	const args: (string | null)[] = [];
	if (filter.kind !== undefined) {
		where.push("kind = ?");
		args.push(filter.kind);
	}
	if (filter.state !== undefined) {
		where.push("state = ?");
		args.push(filter.state);
	}
	if (filter.parentId !== undefined) {
		where.push("parent_id IS ?");
		args.push(filter.parentId);
	}
	return (
		db
			.query(
				`SELECT ${CLUSTER_COLUMNS} FROM map_clusters
				 ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rowid`,
			)
			.all(...args) as ClusterDbRow[]
	).map(toCluster);
}

export function listClusterMembers(db: Database, id: string): ClusterMember[] {
	return (
		db
			.query(
				`SELECT member_kind, member_id, role, similarity FROM map_cluster_members
				 WHERE cluster_id = ? ORDER BY member_kind, member_id`,
			)
			.all(id) as {
			member_kind: MemberKind;
			member_id: string;
			role: ClusterMember["role"];
			similarity: number | null;
		}[]
	).map((m) => ({
		kind: m.member_kind,
		id: m.member_id,
		role: m.role,
		similarity: m.similarity,
	}));
}

/** Clusters of `clusterKind` that hold the member, oldest first. */
export function clustersOfMember(
	db: Database,
	kind: MemberKind,
	id: string,
	clusterKind: ClusterKind,
): string[] {
	return (
		db
			.query(
				`SELECT c.id FROM map_cluster_members m JOIN map_clusters c ON c.id = m.cluster_id
				 WHERE m.member_kind = ? AND m.member_id = ? AND c.kind = ?
				 ORDER BY c.created_at, c.id`,
			)
			.all(kind, id, clusterKind) as { id: string }[]
	).map((r) => r.id);
}

const sameMembers = (
	a: readonly ClusterMember[],
	b: readonly ClusterMember[],
) => {
	const key = (m: ClusterMember) => `${m.kind}\0${m.id}`;
	const sorted = (x: readonly ClusterMember[]) =>
		[...x].sort((p, q) => (key(p) < key(q) ? -1 : key(p) > key(q) ? 1 : 0));
	return canonicalJson(sorted(a)) === canonicalJson(sorted(b));
};

function writeMembers(
	db: Database,
	id: string,
	members: readonly ClusterMember[],
) {
	db.query("DELETE FROM map_cluster_members WHERE cluster_id = ?").run(id);
	const insert = db.query(
		`INSERT INTO map_cluster_members (cluster_id, member_kind, member_id, role, similarity)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	for (const m of members) insert.run(id, m.kind, m.id, m.role, m.similarity);
}

/**
 * Inserts the cluster with its members, or updates it. Nothing changes (`unchanged`) when the
 * member digest, the member rows and the descriptive columns (parent, level, name, aliases,
 * description, summary, algorithm) are all equal; `state` is not compared. When the member digest
 * differs, the members are rewritten, `state` takes the given value and the revision moves; when
 * only the descriptive columns differ, `state` is kept. The caller owns the transaction.
 */
export function upsertCluster(db: Database, c: ClusterInput): UpsertResult {
	const before = getCluster(db, c.id);
	if (before && before.kind !== c.kind)
		throw new Error("map_cluster_kind_changed");
	if (!before) {
		db.query(
			`INSERT INTO map_clusters
			 (id, kind, parent_id, level, handle, name, aliases_json, description, summary_json,
			  state, member_digest, algorithm, revision, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		).run(
			c.id,
			c.kind,
			c.parentId,
			c.level,
			c.kind === "theme" ? themeHandle(c.id) : null,
			c.name,
			JSON.stringify(c.aliases),
			c.description,
			canonicalJson(c.summary),
			c.state,
			c.memberDigest,
			c.algorithm,
			c.createdAt,
			c.updatedAt,
		);
		writeMembers(db, c.id, c.members);
		return "inserted";
	}
	const membersChanged = before.memberDigest !== c.memberDigest;
	const fieldsChanged =
		before.parentId !== c.parentId ||
		before.level !== c.level ||
		before.name !== c.name ||
		before.description !== c.description ||
		before.algorithm !== c.algorithm ||
		canonicalJson(before.aliases) !== canonicalJson(c.aliases) ||
		canonicalJson(before.summary) !== canonicalJson(c.summary);
	const rowsChanged =
		!membersChanged && !sameMembers(listClusterMembers(db, c.id), c.members);
	if (!membersChanged && !fieldsChanged && !rowsChanged) return "unchanged";
	db.query(
		`UPDATE map_clusters SET parent_id = ?, level = ?, name = ?, aliases_json = ?,
		   description = ?, summary_json = ?, state = ?, member_digest = ?, algorithm = ?,
		   revision = revision + 1, updated_at = ?
		 WHERE id = ?`,
	).run(
		c.parentId,
		c.level,
		c.name,
		JSON.stringify(c.aliases),
		c.description,
		canonicalJson(c.summary),
		membersChanged ? c.state : before.state,
		c.memberDigest,
		c.algorithm,
		c.updatedAt,
		c.id,
	);
	if (membersChanged || rowsChanged) writeMembers(db, c.id, c.members);
	return "updated";
}

/** True when the state changed. */
export function setClusterState(
	db: Database,
	id: string,
	state: ClusterState,
	at: string,
): boolean {
	return (
		db
			.query(
				"UPDATE map_clusters SET state = ?, updated_at = ? WHERE id = ? AND state != ?",
			)
			.run(state, at, id, state).changes > 0
	);
}

interface EdgeDbRow {
	id: string;
	src_kind: NodeKind;
	src_id: string;
	relation: Relation;
	dst_kind: NodeKind;
	dst_id: string;
	origin: EdgeRow["origin"];
	status: EdgeStatus;
	confidence: number;
	evidence_json: string;
	extractor_version: string;
	created_at: string;
	updated_at: string;
}

const EDGE_COLUMNS = `id, src_kind, src_id, relation, dst_kind, dst_id, origin, status, confidence,
  evidence_json, extractor_version, created_at, updated_at`;

function toEdge(r: EdgeDbRow): EdgeRow {
	return {
		id: r.id,
		src: { kind: r.src_kind, id: r.src_id },
		relation: r.relation,
		dst: { kind: r.dst_kind, id: r.dst_id },
		origin: r.origin,
		status: r.status,
		confidence: r.confidence,
		evidence: JSON.parse(r.evidence_json) as Record<string, unknown>,
		extractorVersion: r.extractor_version,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

/** The id of the edge for (src, relation, dst): the same triple always has the same id. */
export function edgeId(
	src: EdgeInput["src"],
	relation: Relation,
	dst: EdgeInput["dst"],
): string {
	return `me_${sha256Hex(`${src.kind}|${src.id}|${relation}|${dst.kind}|${dst.id}`).slice(0, 32)}`;
}

/** Keyed by UNIQUE(src, relation, dst): a second write updates the row; an equal one changes nothing. */
export function upsertEdge(db: Database, e: EdgeInput): UpsertResult {
	return upsertRow(db, {
		table: "map_edges",
		key: {
			src_kind: e.src.kind,
			src_id: e.src.id,
			relation: e.relation,
			dst_kind: e.dst.kind,
			dst_id: e.dst.id,
		},
		values: {
			origin: e.origin,
			status: e.status,
			confidence: e.confidence,
			evidence_json: canonicalJson(e.evidence),
			extractor_version: e.extractorVersion,
		},
		insertOnly: {
			id: edgeId(e.src, e.relation, e.dst),
			created_at: e.at,
		},
		touch: { updated_at: e.at },
	});
}

/** True when the status changed. */
export function setEdgeStatus(
	db: Database,
	id: string,
	status: EdgeStatus,
	at: string,
): boolean {
	return (
		db
			.query(
				"UPDATE map_edges SET status = ?, updated_at = ? WHERE id = ? AND status != ?",
			)
			.run(status, at, id, status).changes > 0
	);
}

export function getEdge(db: Database, id: string): EdgeRow | null {
	const row = db
		.query(`SELECT ${EDGE_COLUMNS} FROM map_edges WHERE id = ?`)
		.get(id) as EdgeDbRow | null;
	return row ? toEdge(row) : null;
}

/** Edges leaving the node, in creation order; every status (the caller filters). */
export function edgesFrom(
	db: Database,
	kind: NodeKind,
	id: string,
	relation?: Relation,
): EdgeRow[] {
	return (
		db
			.query(
				`SELECT ${EDGE_COLUMNS} FROM map_edges
				 WHERE src_kind = ? AND src_id = ? ${relation ? "AND relation = ?" : ""}
				 ORDER BY rowid`,
			)
			.all(...(relation ? [kind, id, relation] : [kind, id])) as EdgeDbRow[]
	).map(toEdge);
}

/** Edges arriving at the node, in creation order; every status. */
export function edgesTo(
	db: Database,
	kind: NodeKind,
	id: string,
	relation?: Relation,
): EdgeRow[] {
	return (
		db
			.query(
				`SELECT ${EDGE_COLUMNS} FROM map_edges
				 WHERE dst_kind = ? AND dst_id = ? ${relation ? "AND relation = ?" : ""}
				 ORDER BY rowid`,
			)
			.all(...(relation ? [kind, id, relation] : [kind, id])) as EdgeDbRow[]
	).map(toEdge);
}

interface FacetDbRow {
	facet_key: FacetKey;
	raw_value: string;
	concept: string;
	theme_id: string | null;
	origin: FacetConceptRow["origin"];
	created_at: string;
}

/**
 * Keyed by (facet_key, raw_value). A `human` mapping is never replaced by another origin.
 */
export function upsertFacetConcept(
	db: Database,
	f: FacetConceptInput,
): UpsertResult {
	const existing = getFacetConcept(db, f.facetKey, f.rawValue);
	if (existing?.origin === "human" && f.origin !== "human") return "unchanged";
	return upsertRow(db, {
		table: "map_facet_concepts",
		key: { facet_key: f.facetKey, raw_value: f.rawValue },
		values: { concept: f.concept, theme_id: f.themeId, origin: f.origin },
		insertOnly: { created_at: f.at },
	});
}

export function getFacetConcept(
	db: Database,
	facetKey: FacetKey,
	rawValue: string,
): FacetConceptRow | null {
	const r = db
		.query(
			`SELECT facet_key, raw_value, concept, theme_id, origin, created_at
			 FROM map_facet_concepts WHERE facet_key = ? AND raw_value = ?`,
		)
		.get(facetKey, rawValue) as FacetDbRow | null;
	return r ? toFacet(r) : null;
}

export function listFacetConcepts(
	db: Database,
	facetKey?: FacetKey,
): FacetConceptRow[] {
	return (
		db
			.query(
				`SELECT facet_key, raw_value, concept, theme_id, origin, created_at
				 FROM map_facet_concepts ${facetKey ? "WHERE facet_key = ?" : ""}
				 ORDER BY facet_key, raw_value`,
			)
			.all(...(facetKey ? [facetKey] : [])) as FacetDbRow[]
	).map(toFacet);
}

const toFacet = (r: FacetDbRow): FacetConceptRow => ({
	facetKey: r.facet_key,
	rawValue: r.raw_value,
	concept: r.concept,
	themeId: r.theme_id,
	origin: r.origin,
	createdAt: r.created_at,
});
