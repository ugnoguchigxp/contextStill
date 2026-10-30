import type { Database } from "bun:sqlite";
import type { EvalCase } from "../contracts";
import { prepareLegacyQuery } from "./legacy-score";

export interface Candidate {
	kind: "knowledge" | "episode";
	id: string;
	handle: string;
	text: string;
	importance: number;
	updatedAt: string;
	dynamicScore: number;
}

function dynamicScoreOf(metadataJson: string): number {
	try {
		const value = (
			JSON.parse(metadataJson) as { legacy?: { dynamicScore?: unknown } }
		).legacy?.dynamicScore;
		return typeof value === "number" && Number.isFinite(value)
			? Math.round(value)
			: 0;
	} catch {
		return 0;
	}
}

/**
 * The pool the atoms before distillation offered for a case: global scope (a case has no
 * repoKey), the case's spaces, and atoms for knowledge, active or superseded (so the legacy
 * baselines see the same rows before and after the re-distillation; retrieval is ignored).
 * Text is the same fields v1 scored.
 */
export function loadCandidates(
	db: Database,
	spaces: readonly string[],
	kinds: readonly ("knowledge" | "episode")[],
): Candidate[] {
	const marks = spaces.map(() => "?").join(",");
	const out: Candidate[] = [];
	if (kinds.includes("knowledge"))
		for (const row of db
			.query<
				{
					id: string;
					handle: string;
					title: string;
					body: string;
					importance: number;
					updated_at: string;
					metadata_json: string;
				},
				string[]
			>(
				`SELECT id, handle, title, body, importance, updated_at, metadata_json FROM knowledge_items
				 WHERE status IN ('active','superseded') AND layer='atom' AND scope='global' AND space IN (${marks})`,
			)
			.all(...spaces))
			out.push({
				kind: "knowledge",
				id: row.id,
				handle: row.handle,
				text: `${row.title}\n${row.body}`,
				importance: row.importance,
				updatedAt: row.updated_at,
				dynamicScore: dynamicScoreOf(row.metadata_json),
			});
	if (kinds.includes("episode"))
		for (const row of db
			.query<
				{
					id: string;
					handle: string;
					title: string;
					situation: string;
					lesson: string;
					importance: number;
					updated_at: string;
				},
				string[]
			>(
				`SELECT id, handle, title, situation, lesson, importance, updated_at FROM episodes
				 WHERE status='active' AND scope='global' AND space IN (${marks})`,
			)
			.all(...spaces))
			out.push({
				kind: "episode",
				id: row.id,
				handle: row.handle,
				text: `${row.title}\n${row.situation}\n${row.lesson}`,
				importance: row.importance,
				updatedAt: row.updated_at,
				dynamicScore: 0,
			});
	return out;
}

export interface Ranked {
	kind: "knowledge" | "episode";
	id: string;
	handle: string;
}

export type LegacyMode = "lexical" | "query-first";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * v1 read candidates with `order by importance desc, updated_at desc`; the stable sorts
 * below keep that order among equal scores (id asc closes the tie, as SQLite's order for
 * equal keys is not defined).
 */
function inReadOrder(candidates: readonly Candidate[]): Candidate[] {
	return [...candidates].sort(
		(a, b) =>
			b.importance - a.importance ||
			cmp(b.updatedAt, a.updatedAt) ||
			cmp(a.id, b.id),
	);
}

/**
 * `lexical` (v1 `native_knowledge.rs`): score = score_text + round(dynamicScore), drop <= 0,
 * highest score first.
 * `query-first` (v1 `context_compile` foundation pool): only rows with score_text > 0,
 * score_text desc then dynamicScore desc.
 * Ties keep the v1 read order (importance desc, updated_at desc, id asc).
 */
export function rankLegacy(
	candidates: readonly Candidate[],
	query: EvalCase["query"],
	k: number,
	mode: LegacyMode = "lexical",
): Ranked[] {
	const score = prepareLegacyQuery(query);
	return inReadOrder(candidates)
		.map((candidate) => ({ candidate, queryScore: score(candidate.text) }))
		.filter((entry) =>
			mode === "query-first"
				? entry.queryScore > 0
				: entry.queryScore + entry.candidate.dynamicScore > 0,
		)
		.sort((a, b) =>
			mode === "query-first"
				? b.queryScore - a.queryScore ||
					b.candidate.dynamicScore - a.candidate.dynamicScore
				: b.queryScore +
					b.candidate.dynamicScore -
					(a.queryScore + a.candidate.dynamicScore),
		)
		.slice(0, k)
		.map(({ candidate }) => ({
			kind: candidate.kind,
			id: candidate.id,
			handle: candidate.handle,
		}));
}
