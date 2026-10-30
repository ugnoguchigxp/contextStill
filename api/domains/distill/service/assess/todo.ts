import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../../infrastructure/digest";
import type { OwnerKind } from "../../contracts";
import { listAssessments } from "../../repository";

export interface TodoItem {
	owner: OwnerKind;
	id: string;
	/** The digest of the text as it is now. */
	digest: string;
}

export interface TodoOptions {
	/** Only ids greater than this (the chain moves forward and never revisits an id in a run). */
	after: string | null;
	/** -1: all. */
	limit: number;
	/** true: an assessment made by another prompt version is out of date (stage assess). */
	promptVersion: string | null;
}

export interface EpisodeText {
	title: string;
	situation: string;
	action: string;
	outcome: string;
	lesson: string;
}

/** Episodes have no digest column; this is the one the assessment stores. */
export function episodeContentDigest(e: EpisodeText): string {
	return sha256Hex(
		canonicalJson({
			title: e.title,
			situation: e.situation,
			action: e.action,
			outcome: e.outcome,
			lesson: e.lesson,
		}),
	);
}

/**
 * The rows that need an assessment, in id order: active atoms, and active `global` episodes
 * (the repo ones are never assessed). Rows of the `personal` space are never assessed: no rule or
 * procedure is made from a personal original record (until N6). Out of date means: no
 * assessment, a different text digest, or (with `promptVersion`) another prompt version unless a
 * human made it for this very text. A `superseded` atom that has an assessment is judged again
 * when its text is no longer the one assessed (the canonical it was absorbed into is old then).
 */
export function listTodo(
	db: Database,
	owner: OwnerKind,
	o: TodoOptions,
): TodoItem[] {
	const after = o.after ?? "";
	if (owner === "knowledge") {
		return (
			db
				.query(
					`SELECT k.id AS id, k.content_digest AS digest FROM knowledge_items k
					 LEFT JOIN distill_assessments a ON a.owner_kind = 'knowledge' AND a.owner_id = k.id
					 WHERE k.layer = 'atom' AND k.space <> 'personal' AND k.id > ?
					   AND ((k.status = 'active'
					         AND (a.owner_id IS NULL OR a.content_digest != k.content_digest
					              OR (? IS NOT NULL AND a.prompt_version != ? AND a.origin != 'human')))
					        OR (k.status = 'superseded' AND a.owner_id IS NOT NULL
					            AND a.content_digest != k.content_digest))
					 ORDER BY k.id LIMIT ?`,
				)
				.all(after, o.promptVersion, o.promptVersion, o.limit) as {
				id: string;
				digest: string;
			}[]
		).map((r) => ({ owner, id: r.id, digest: r.digest }));
	}
	const assessed = new Map(
		listAssessments(db, { ownerKind: "episode" }).map((a) => [a.ownerId, a]),
	);
	const rows = db
		.query(
			`SELECT id, title, situation, action, outcome, lesson FROM episodes
			 WHERE status = 'active' AND scope = 'global' AND space <> 'personal' AND id > ?
			 ORDER BY id`,
		)
		.all(after) as (EpisodeText & { id: string })[];
	const out: TodoItem[] = [];
	for (const row of rows) {
		const digest = episodeContentDigest(row);
		const a = assessed.get(row.id);
		const stale =
			!a ||
			a.contentDigest !== digest ||
			(o.promptVersion !== null &&
				a.promptVersion !== o.promptVersion &&
				a.origin !== "human");
		if (!stale) continue;
		out.push({ owner, id: row.id, digest });
		if (o.limit >= 0 && out.length >= o.limit) break;
	}
	return out;
}

/** True when an atom of the incremental stage is assessed and waits to be placed (6.10). */
export function hasPendingPlacement(db: Database): boolean {
	return (
		db
			.query(
				`SELECT 1 FROM distill_assessments
				 WHERE owner_kind = 'knowledge' AND json_extract(signals_json, '$.placement') = 'pending'
				 LIMIT 1`,
			)
			.get() !== null
	);
}
