import type { Database } from "bun:sqlite";
import type { VectorOwnerKind, VectorVerification } from "../../vectors";

/**
 * Read-only scans of the owner tables and `vectors`. The owning domains publish no listing
 * function, and indexing must enumerate rows, so the SELECTs live here. Nothing in this file
 * writes: every write goes through the public functions of `vectors`.
 */

export interface LegacySampleRow {
	id: string;
	title: string;
	body: string;
	situation: string;
	vector: Uint8Array;
}

/**
 * Ids of knowledge with an unverified legacy vector in the space (the verification population).
 * A vector whose content digest differs from the knowledge row's was made from an older text, so
 * it is neither sampled nor verified.
 */
export function listUnverifiedLegacyKnowledgeIds(
	db: Database,
	spaceKey: string,
): string[] {
	return (
		db
			.query(
				`SELECT v.owner_id AS id FROM vectors v
				 JOIN knowledge_items k ON k.id = v.owner_id
				 WHERE v.owner_kind = 'knowledge' AND v.space_key = ?
				   AND v.origin = 'legacy_import' AND v.verification = 'unverified'
				   AND v.content_digest = k.content_digest`,
			)
			.all(spaceKey) as { id: string }[]
	).map((row) => row.id);
}

export function getLegacySampleRows(
	db: Database,
	spaceKey: string,
	ids: readonly string[],
): LegacySampleRow[] {
	if (ids.length === 0) return [];
	return db
		.query(
			`SELECT k.id AS id, k.title AS title, k.body AS body, k.situation AS situation,
			        v.vector AS vector
			 FROM vectors v JOIN knowledge_items k ON k.id = v.owner_id
			 WHERE v.owner_kind = 'knowledge' AND v.space_key = ?
			   AND v.origin = 'legacy_import' AND v.verification = 'unverified'
			   AND v.content_digest = k.content_digest
			   AND k.id IN (${ids.map(() => "?").join(", ")})`,
		)
		.all(spaceKey, ...ids) as LegacySampleRow[];
}

export interface EmbedSourceRow {
	id: string;
	title: string;
	body?: string;
	situation?: string;
	action?: string;
	outcome?: string;
	lesson?: string;
	storedDigest: string | null;
	storedVerification: VectorVerification | null;
}

/**
 * Active, searchable rows of the owner table with the state of their vector in the space, oldest
 * first. Evidence-only rows (repo-specific, unusable, absorbed) are never searched or clustered,
 * so they are not embedded.
 */
export function listActiveForEmbedding(
	db: Database,
	owner: VectorOwnerKind,
	spaceKey: string,
): EmbedSourceRow[] {
	const columns =
		owner === "knowledge"
			? "o.title AS title, o.body AS body, o.situation AS situation"
			: "o.title AS title, o.situation AS situation, o.action AS action, o.outcome AS outcome, o.lesson AS lesson";
	const table = owner === "knowledge" ? "knowledge_items" : "episodes";
	return db
		.query(
			`SELECT o.id AS id, ${columns},
			        v.content_digest AS storedDigest, v.verification AS storedVerification
			 FROM ${table} o
			 LEFT JOIN vectors v
			   ON v.owner_kind = ? AND v.owner_id = o.id AND v.space_key = ?
			 WHERE o.status = 'active' AND o.retrieval = 'searchable'
			 ORDER BY o.seq`,
		)
		.all(owner, spaceKey) as EmbedSourceRow[];
}
