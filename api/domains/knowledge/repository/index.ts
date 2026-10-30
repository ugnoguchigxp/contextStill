import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { makeHandle } from "../../../infrastructure/handle";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import type {
	CanonicalExample,
	EvidenceInput,
	EvidenceOrigin,
	EvidenceRow,
	KnowledgeInput,
	KnowledgeRow,
	KnowledgeStatus,
	Retrieval,
} from "../contracts";

export { migrations } from "./migrations";

/**
 * The digest of what is searched and embedded. Without a situation it is the N1 value
 * (sha256 of `title\nbody`, which the legacy vectors were made from); with one the situation
 * comes first, like the embedded text.
 */
export function knowledgeContentDigest(
	title: string,
	body: string,
	situation = "",
): string {
	return sha256Hex(
		situation === "" ? `${title}\n${body}` : `${situation}\n${title}\n${body}`,
	);
}

interface CanonicalValues {
	situation: string;
	rationale: string;
	exceptions: string[];
	examples: unknown[];
}

/**
 * The canonical fields to store: the given ones, and for an omitted one the row's current value
 * (an update that leaves a field out never clears it), else the empty default.
 */
function canonicalValues(db: Database, input: KnowledgeInput): CanonicalValues {
	const omitted =
		input.situation === undefined ||
		input.rationale === undefined ||
		input.exceptions === undefined ||
		input.examples === undefined;
	const row = omitted
		? (db
				.query(
					"SELECT situation, rationale, exceptions_json, examples_json FROM knowledge_items WHERE id = ?",
				)
				.get(input.id) as {
				situation: string;
				rationale: string;
				exceptions_json: string;
				examples_json: string;
			} | null)
		: null;
	return {
		situation: input.situation ?? row?.situation ?? "",
		rationale: input.rationale ?? row?.rationale ?? "",
		exceptions:
			input.exceptions ??
			(row ? (JSON.parse(row.exceptions_json) as string[]) : []),
		examples:
			input.examples ??
			(row ? (JSON.parse(row.examples_json) as unknown[]) : []),
	};
}

function assertCanonicalFields(
	input: KnowledgeInput,
	values: CanonicalValues,
): void {
	const ok =
		// A canonical always states the situation it applies to (5.3).
		(input.layer !== "canonical" || values.situation.trim() !== "") &&
		values.situation.length <= 600 &&
		values.rationale.length <= 800 &&
		values.exceptions.length <= 8 &&
		values.exceptions.every((e) => e.length <= 200) &&
		values.examples.length <= 2;
	if (!ok) throw new Error("invalid_knowledge_input");
}

export function upsertKnowledgeItem(
	db: Database,
	input: KnowledgeInput,
): UpsertResult {
	const canonical = canonicalValues(db, input);
	assertCanonicalFields(input, canonical);
	const { situation } = canonical;
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
			situation,
			rationale: canonical.rationale,
			exceptions_json: JSON.stringify(canonical.exceptions),
			examples_json: JSON.stringify(canonical.examples),
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
			content_digest: knowledgeContentDigest(
				input.title,
				input.body,
				situation,
			),
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
	situation: string;
	rationale: string;
	exceptions_json: string;
	examples_json: string;
	retrieval: KnowledgeRow["retrieval"];
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

const COLUMNS = `id, handle, layer, type, polarity, title, body, situation, rationale,
  exceptions_json, examples_json, retrieval, applies_when_json,
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
		situation: row.situation,
		rationale: row.rationale,
		exceptions: JSON.parse(row.exceptions_json) as string[],
		examples: JSON.parse(row.examples_json) as CanonicalExample[],
		retrieval: row.retrieval,
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

/**
 * Changes the status and/or the retrieval of an item (never its text). True when something
 * changed; the revision then moves by one. The caller owns the transaction.
 */
export function setKnowledgeDisposition(
	db: Database,
	id: string,
	d: { status?: KnowledgeStatus; retrieval?: Retrieval; updatedAt: string },
): boolean {
	const sets: string[] = [];
	const differs: string[] = [];
	const args: string[] = [];
	if (d.status !== undefined) {
		sets.push("status = ?");
		differs.push("status != ?");
		args.push(d.status);
	}
	if (d.retrieval !== undefined) {
		sets.push("retrieval = ?");
		differs.push("retrieval != ?");
		args.push(d.retrieval);
	}
	if (sets.length === 0) return false;
	const values = args;
	return (
		db
			.query(
				`UPDATE knowledge_items SET ${sets.join(", ")}, revision = revision + 1, updated_at = ?
				 WHERE id = ? AND (${differs.join(" OR ")})`,
			)
			.run(...values, d.updatedAt, id, ...values).changes > 0
	);
}

/**
 * The canonical items an atom was folded into: canonicals (active first, then superseded) whose
 * evidence names the atom as `derived_from`. Read from the evidence, not from map_edges.
 */
export function listSupersededBy(db: Database, atomId: string): string[] {
	return (
		db
			.query(
				`SELECT k.id FROM knowledge_evidence e JOIN knowledge_items k ON k.id = e.knowledge_id
				 WHERE e.target_kind = 'atom' AND e.target_id = ? AND e.role = 'derived_from'
				   AND k.layer = 'canonical' AND k.status IN ('active', 'superseded')
				 ORDER BY (k.status = 'active') DESC, k.seq`,
			)
			.all(atomId) as { id: string }[]
	).map((r) => r.id);
}
