import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { makeHandle } from "../../../infrastructure/handle";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import type {
	EvidenceInput,
	EvidenceOrigin,
	EvidenceRow,
	KnowledgeInput,
	KnowledgeRow,
} from "../contracts";

export { migrations } from "./migrations";

/** The digest of what is searched and embedded: title and body. */
export function knowledgeContentDigest(title: string, body: string): string {
	return sha256Hex(`${title}\n${body}`);
}

export function upsertKnowledgeItem(
	db: Database,
	input: KnowledgeInput,
): UpsertResult {
	return upsertRow(db, {
		table: "knowledge_items",
		key: { id: input.id },
		values: {
			handle: makeHandle("knowledge", input.id),
			layer: input.layer,
			type: input.type,
			polarity: input.polarity,
			title: input.title,
			body: input.body,
			applies_when_json: JSON.stringify(input.appliesWhen),
			not_applies_when_json: JSON.stringify(input.notAppliesWhen),
			steps_json: JSON.stringify(input.steps),
			facets_json: canonicalJson(input.facets),
			confidence: input.confidence,
			importance: input.importance,
			status: input.status,
			space: input.space,
			scope: input.scope,
			repo_key: input.repoKey,
			valid_from: input.validFrom,
			valid_until: input.validUntil,
			content_digest: knowledgeContentDigest(input.title, input.body),
			provenance_status: input.provenanceStatus,
			metadata_json: canonicalJson(input.metadata),
			created_at: input.createdAt,
			updated_at: input.updatedAt,
		},
		revision: true,
	});
}

/** Removes every evidence row of `origin` for the item, then inserts the given ones (idempotent). */
export function replaceKnowledgeEvidence(
	db: Database,
	knowledgeId: string,
	origin: EvidenceOrigin,
	evidence: EvidenceInput[],
	createdAt: string,
): void {
	db.query(
		"DELETE FROM knowledge_evidence WHERE knowledge_id = ? AND origin = ?",
	).run(knowledgeId, origin);
	// ON CONFLICT(id) only absorbs a repeated identical row; CHECK violations still throw.
	const insert = db.query(
		`INSERT INTO knowledge_evidence
		   (id, knowledge_id, target_kind, target_id, external_ref, role, quote, confidence, origin, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
	);
	for (const item of evidence) {
		const id = `ev_${sha256Hex(
			`${knowledgeId}|${item.targetKind}|${item.targetId ?? item.externalRef}|${item.role}|${origin}`,
		).slice(0, 32)}`;
		insert.run(
			id,
			knowledgeId,
			item.targetKind,
			item.targetId,
			item.externalRef,
			item.role,
			item.quote,
			item.confidence,
			origin,
			createdAt,
		);
	}
}

interface KnowledgeDbRow {
	id: string;
	handle: string;
	layer: KnowledgeRow["layer"];
	type: KnowledgeRow["type"];
	polarity: KnowledgeRow["polarity"];
	title: string;
	body: string;
	applies_when_json: string;
	not_applies_when_json: string;
	steps_json: string;
	facets_json: string;
	confidence: number;
	importance: number;
	status: KnowledgeRow["status"];
	space: KnowledgeRow["space"];
	scope: KnowledgeRow["scope"];
	repo_key: string | null;
	revision: number;
	valid_from: string | null;
	valid_until: string | null;
	content_digest: string;
	provenance_status: KnowledgeRow["provenanceStatus"];
	metadata_json: string;
	created_at: string;
	updated_at: string;
}

const COLUMNS = `id, handle, layer, type, polarity, title, body, applies_when_json,
  not_applies_when_json, steps_json, facets_json, confidence, importance, status, space, scope,
  repo_key, revision, valid_from, valid_until, content_digest, provenance_status, metadata_json,
  created_at, updated_at`;

function toRow(row: KnowledgeDbRow): KnowledgeRow {
	return {
		id: row.id,
		handle: row.handle,
		layer: row.layer,
		type: row.type,
		polarity: row.polarity,
		title: row.title,
		body: row.body,
		appliesWhen: JSON.parse(row.applies_when_json) as string[],
		notAppliesWhen: JSON.parse(row.not_applies_when_json) as string[],
		steps: JSON.parse(row.steps_json) as string[],
		facets: JSON.parse(row.facets_json) as Record<string, unknown>,
		confidence: row.confidence,
		importance: row.importance,
		status: row.status,
		space: row.space,
		scope: row.scope,
		repoKey: row.repo_key,
		revision: row.revision,
		validFrom: row.valid_from,
		validUntil: row.valid_until,
		contentDigest: row.content_digest,
		provenanceStatus: row.provenance_status,
		metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function getKnowledgeById(
	db: Database,
	id: string,
): KnowledgeRow | null {
	const row = db
		.query(`SELECT ${COLUMNS} FROM knowledge_items WHERE id = ?`)
		.get(id) as KnowledgeDbRow | null;
	return row ? toRow(row) : null;
}

export function getKnowledgeByHandle(
	db: Database,
	handle: string,
): KnowledgeRow | null {
	const row = db
		.query(`SELECT ${COLUMNS} FROM knowledge_items WHERE handle = ?`)
		.get(handle) as KnowledgeDbRow | null;
	return row ? toRow(row) : null;
}

/** Evidence in the order it was stored (the primary derivation first). */
export function listKnowledgeEvidence(
	db: Database,
	knowledgeId: string,
): EvidenceRow[] {
	return (
		db
			.query(
				`SELECT id, target_kind, target_id, external_ref, role, quote, confidence, origin
				 FROM knowledge_evidence WHERE knowledge_id = ? ORDER BY rowid`,
			)
			.all(knowledgeId) as {
			id: string;
			target_kind: EvidenceRow["targetKind"];
			target_id: string | null;
			external_ref: string | null;
			role: EvidenceRow["role"];
			quote: string | null;
			confidence: number | null;
			origin: EvidenceOrigin;
		}[]
	).map((r) => ({
		id: r.id,
		targetKind: r.target_kind,
		targetId: r.target_id,
		externalRef: r.external_ref,
		role: r.role,
		quote: r.quote,
		confidence: r.confidence,
		origin: r.origin,
	}));
}
