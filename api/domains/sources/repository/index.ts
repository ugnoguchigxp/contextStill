import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import type {
	SourceFragmentInput,
	SourceFragmentRow,
	SourceKind,
	SourceRecordInput,
	SourceRecordRow,
} from "../contracts";

export { migrations } from "./migrations";

export function upsertSourceRecord(
	db: Database,
	input: SourceRecordInput,
): UpsertResult {
	return upsertRow(db, {
		table: "source_records",
		key: { id: input.id },
		values: {
			kind: input.kind,
			uri: input.uri,
			title: input.title,
			content: input.content,
			content_digest: sha256Hex(input.content),
			space: input.space,
			scope: input.scope,
			repo_key: input.repoKey,
			recorded_at: input.recordedAt,
			metadata_json: canonicalJson(input.metadata),
			created_at: input.createdAt,
			updated_at: input.updatedAt,
		},
		revision: true,
	});
}

export function upsertSourceFragment(
	db: Database,
	input: SourceFragmentInput,
): UpsertResult {
	return upsertRow(db, {
		table: "source_fragments",
		key: { id: input.id },
		values: {
			source_id: input.sourceId,
			locator: input.locator,
			byte_start: input.byteStart,
			byte_end: input.byteEnd,
			heading: input.heading,
			content: input.content,
			content_digest: sha256Hex(input.content),
			created_at: input.createdAt,
		},
	});
}

export function getSourceRecord(
	db: Database,
	id: string,
): SourceRecordRow | null {
	const row = db
		.query(
			`SELECT id, kind, uri, title, content, space, scope, repo_key, recorded_at
			 FROM source_records WHERE id = ?`,
		)
		.get(id) as {
		id: string;
		kind: SourceKind;
		uri: string;
		title: string | null;
		content: string;
		space: SourceRecordRow["space"];
		scope: SourceRecordRow["scope"];
		repo_key: string | null;
		recorded_at: string;
	} | null;
	return row
		? {
				id: row.id,
				kind: row.kind,
				uri: row.uri,
				title: row.title,
				content: row.content,
				space: row.space,
				scope: row.scope,
				repoKey: row.repo_key,
				recordedAt: row.recorded_at,
			}
		: null;
}

/** A source row without its body: for callers that only need the kind, scope and public fields. */
export type SourceMetaRow = Omit<SourceRecordRow, "content">;

/** Like getSourceRecord, but never reads `content`. */
export function getSourceMeta(db: Database, id: string): SourceMetaRow | null {
	const row = db
		.query(
			`SELECT id, kind, uri, title, space, scope, repo_key, recorded_at
			 FROM source_records WHERE id = ?`,
		)
		.get(id) as {
		id: string;
		kind: SourceKind;
		uri: string;
		title: string | null;
		space: SourceRecordRow["space"];
		scope: SourceRecordRow["scope"];
		repo_key: string | null;
		recorded_at: string;
	} | null;
	return row
		? {
				id: row.id,
				kind: row.kind,
				uri: row.uri,
				title: row.title,
				space: row.space,
				scope: row.scope,
				repoKey: row.repo_key,
				recordedAt: row.recorded_at,
			}
		: null;
}

/** The text of a source, read separately from its metadata. */
export function getSourceContent(db: Database, id: string): string | null {
	const row = db
		.query("SELECT content FROM source_records WHERE id = ?")
		.get(id) as { content: string } | null;
	return row ? row.content : null;
}

/** The source a fragment belongs to, without reading the fragment text. */
export function getFragmentSourceId(db: Database, id: string): string | null {
	const row = db
		.query("SELECT source_id FROM source_fragments WHERE id = ?")
		.get(id) as { source_id: string } | null;
	return row ? row.source_id : null;
}

export function findSourceByUri(
	db: Database,
	kind: SourceKind,
	uri: string,
): { id: string } | null {
	return db
		.query("SELECT id FROM source_records WHERE kind = ? AND uri = ?")
		.get(kind, uri) as { id: string } | null;
}

export function getSourceFragment(
	db: Database,
	id: string,
): SourceFragmentRow | null {
	const row = db
		.query(
			"SELECT id, source_id, locator, heading, content FROM source_fragments WHERE id = ?",
		)
		.get(id) as {
		id: string;
		source_id: string;
		locator: string;
		heading: string | null;
		content: string;
	} | null;
	return row
		? {
				id: row.id,
				sourceId: row.source_id,
				locator: row.locator,
				heading: row.heading,
				content: row.content,
			}
		: null;
}
