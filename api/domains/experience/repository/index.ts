import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import { makeHandle } from "../../../infrastructure/handle";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import type {
	EpisodeInput,
	EpisodeRow,
	EpisodeSourceRef,
	Retrieval,
} from "../contracts";

export { migrations } from "./migrations";

export function upsertEpisode(db: Database, input: EpisodeInput): UpsertResult {
	return upsertRow(db, {
		table: "episodes",
		key: { id: input.id },
		values: {
			handle: makeHandle("episode", input.id),
			title: input.title,
			situation: input.situation,
			intent: input.intent,
			decision: input.decision,
			observations: input.observations,
			action: input.action,
			outcome: input.outcome,
			lesson: input.lesson,
			open_questions_json: JSON.stringify(input.openQuestions),
			outcome_kind: input.outcomeKind,
			event_start: input.eventStart,
			event_end: input.eventEnd,
			time_precision: input.timePrecision,
			confidence: input.confidence,
			importance: input.importance,
			status: input.status,
			space: input.space,
			scope: input.scope,
			repo_key: input.repoKey,
			facets_json: canonicalJson(input.facets),
			metadata_json: canonicalJson(input.metadata),
			created_at: input.createdAt,
			updated_at: input.updatedAt,
		},
		revision: true,
	});
}

/** Replaces the whole set of sources of an episode. A source that does not exist is refused. */
export function replaceEpisodeSources(
	db: Database,
	episodeId: string,
	refs: EpisodeSourceRef[],
): void {
	db.query("DELETE FROM episode_sources WHERE episode_id = ?").run(episodeId);
	const insert = db.query(
		`INSERT INTO episode_sources (episode_id, source_id, locator, role)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(episode_id, source_id, locator) DO NOTHING`,
	);
	for (const ref of refs)
		insert.run(episodeId, ref.sourceId, ref.locator, ref.role);
}

interface EpisodeDbRow {
	id: string;
	handle: string;
	title: string;
	situation: string;
	intent: string;
	decision: string;
	observations: string;
	action: string;
	outcome: string;
	lesson: string;
	open_questions_json: string;
	outcome_kind: EpisodeRow["outcomeKind"];
	event_start: string | null;
	event_end: string | null;
	time_precision: EpisodeRow["timePrecision"];
	confidence: number;
	importance: number;
	status: EpisodeRow["status"];
	space: EpisodeRow["space"];
	scope: EpisodeRow["scope"];
	repo_key: string | null;
	facets_json: string;
	retrieval: Retrieval;
	revision: number;
	created_at: string;
	updated_at: string;
}

const COLUMNS = `id, handle, title, situation, intent, decision, observations, action, outcome,
  lesson, open_questions_json, outcome_kind, event_start, event_end, time_precision, confidence,
  importance, status, space, scope, repo_key, facets_json, retrieval, revision, created_at, updated_at`;

function toRow(row: EpisodeDbRow): EpisodeRow {
	return {
		id: row.id,
		handle: row.handle,
		title: row.title,
		situation: row.situation,
		intent: row.intent,
		decision: row.decision,
		observations: row.observations,
		action: row.action,
		outcome: row.outcome,
		lesson: row.lesson,
		openQuestions: JSON.parse(row.open_questions_json) as string[],
		outcomeKind: row.outcome_kind,
		eventStart: row.event_start,
		eventEnd: row.event_end,
		timePrecision: row.time_precision,
		confidence: row.confidence,
		importance: row.importance,
		status: row.status,
		space: row.space,
		scope: row.scope,
		repoKey: row.repo_key,
		facets: JSON.parse(row.facets_json) as Record<string, unknown>,
		retrieval: row.retrieval,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function getEpisodeById(db: Database, id: string): EpisodeRow | null {
	const row = db
		.query(`SELECT ${COLUMNS} FROM episodes WHERE id = ?`)
		.get(id) as EpisodeDbRow | null;
	return row ? toRow(row) : null;
}

export function getEpisodeByHandle(
	db: Database,
	handle: string,
): EpisodeRow | null {
	const row = db
		.query(`SELECT ${COLUMNS} FROM episodes WHERE handle = ?`)
		.get(handle) as EpisodeDbRow | null;
	return row ? toRow(row) : null;
}

export function listEpisodeSources(
	db: Database,
	episodeId: string,
): { sourceId: string; locator: string; role: string }[] {
	return (
		db
			.query(
				`SELECT source_id, locator, role FROM episode_sources
				 WHERE episode_id = ? ORDER BY source_id, locator`,
			)
			.all(episodeId) as { source_id: string; locator: string; role: string }[]
	).map((r) => ({ sourceId: r.source_id, locator: r.locator, role: r.role }));
}

/** True when the retrieval changed; the revision then moves by one. The caller owns the transaction. */
export function setEpisodeRetrieval(
	db: Database,
	id: string,
	retrieval: Retrieval,
	updatedAt: string,
): boolean {
	return (
		db
			.query(
				`UPDATE episodes SET retrieval = ?, revision = revision + 1, updated_at = ?
				 WHERE id = ? AND retrieval != ?`,
			)
			.run(retrieval, updatedAt, id, retrieval).changes > 0
	);
}
