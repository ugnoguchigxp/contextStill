import type { Database } from "bun:sqlite";
import { handleKind } from "../../../infrastructure/handle";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	getEpisodeByHandle,
	getEpisodeById,
	type EpisodeRow,
} from "../../experience";
import {
	getKnowledgeByHandle,
	getKnowledgeById,
	listSupersededBy,
	type KnowledgeRow,
} from "../../knowledge";
import { edgesTo } from "../../map";
import { SearchError, type SearchHit, type SearchService } from "../../search";
import { unresolvedConflictPairs } from "./conflicts";
import {
	countSupportingAtoms,
	cutChars,
	evidenceSummary,
	publicEvidenceList,
	type PublicEvidenceList,
	resolveEpisodeEvidence,
	resolveKnowledgeEvidence,
	type ResolvedEvidence,
} from "./evidence";
import { getArgs, searchArgs } from "./schemas";
import { resolveThemeInput, themeRefs } from "./themes";

export const SEARCH_CONTRACT = "contextstill-search.v1";
export const KNOWLEDGE_CONTRACT = "contextstill-knowledge.v1";
const TRUST = {
	trustClass: "untrusted_knowledge_evidence",
	instructionAuthority: "none",
} as const;
const KNOWLEDGE_TEXT_CHARS = 8000;
const EPISODE_TEXT_CHARS = 4000;

/** The JSON of a tool's single text content; `isError` marks a failure `{"error": code}`. */
export interface ToolOutcome {
	payload: unknown;
	isError?: true;
}

/** Tells whether the whole HTTP response for this payload stays within the size limit. */
export type Fits = (payload: unknown) => boolean;

export interface ToolDeps {
	search: SearchService;
	store: SqliteStore;
}

const failure = (code: string): ToolOutcome => ({
	payload: { error: code },
	isError: true,
});

export async function callTool(
	name: string,
	args: unknown,
	deps: ToolDeps,
	fits: Fits,
	signal?: AbortSignal,
): Promise<ToolOutcome> {
	if (name === "search_knowledge")
		return searchKnowledge(args, deps, fits, signal);
	if (name === "get_knowledge") return getKnowledge(args, deps, fits);
	throw new Error("unknown_tool");
}

function searchResult(db: Database, hit: SearchHit): Record<string, unknown> {
	const evidence: ResolvedEvidence[] =
		hit.kind === "knowledge"
			? resolveKnowledgeEvidence(db, hit.id)
			: resolveEpisodeEvidence(db, hit.id);
	return {
		handle: hit.handle,
		kind: hit.kind,
		type: hit.type,
		polarity: hit.polarity,
		title: hit.title,
		summary: hit.summary,
		status: hit.status,
		space: hit.space,
		confidence: hit.confidence,
		themes: themeRefs(db, hit.themes),
		evidenceSummary: evidenceSummary(evidence),
		route: hit.lanes.map((l) => ({ via: "seed", lane: l.lane, rank: l.rank })),
		score: Math.round(hit.score * 1e6) / 1e6,
	};
}

async function searchKnowledge(
	args: unknown,
	deps: ToolDeps,
	fits: Fits,
	signal?: AbortSignal,
): Promise<ToolOutcome> {
	const parsed = searchArgs.safeParse(args ?? {});
	if (!parsed.success) return failure("invalid_arguments");
	const a = parsed.data;
	// A theme that does not resolve does not narrow the search; it is reported as degraded.
	const themeId =
		a.theme === undefined
			? null
			: deps.store.read((db) => resolveThemeInput(db, a.theme!));
	let response;
	try {
		response = await deps.search.search(
			{
				query: a.query.trim(),
				kinds: a.kinds,
				spaces: a.spaces,
				...(a.types ? { types: a.types } : {}),
				...(themeId !== null ? { theme: themeId } : {}),
				limit: a.limit,
			},
			{ signal },
		);
	} catch (error) {
		if (error instanceof SearchError) return failure(error.code);
		throw error;
	}
	const { results, conflicts } = deps.store.readSnapshot((db) => {
		const canonical = response.hits.filter(
			(h) =>
				h.kind === "knowledge" &&
				h.layer === "canonical" &&
				h.status === "active",
		);
		const handleOf = new Map(canonical.map((h) => [h.id, h.handle]));
		return {
			results: response.hits.map((hit) => searchResult(db, hit)),
			conflicts: unresolvedConflictPairs(db, [...handleOf.keys()]).map(
				([x, y]) => [handleOf.get(x)!, handleOf.get(y)!] as const,
			),
		};
	});
	const degraded: string[] = [...response.degraded];
	if (a.depth > 0) degraded.push("expansion_unavailable");
	if (a.theme !== undefined && themeId === null)
		degraded.push("theme_unavailable");
	// A warning names a pair only while both sides are in the returned results.
	const warningsFor = (count: number) => {
		const shown = new Set(results.slice(0, count).map((r) => r.handle));
		return conflicts
			.filter(([x, y]) => shown.has(x) && shown.has(y))
			.map(([x, y]) => ({ kind: "unresolved_conflict", handles: [x, y] }));
	};
	const build = (count: number) => ({
		contractVersion: SEARCH_CONTRACT,
		trust: TRUST,
		results: results.slice(0, count),
		warnings: warningsFor(count),
		degraded: [...new Set(degraded)],
		truncated: count < results.length,
	});
	let count = results.length;
	while (count > 0 && !fits(build(count))) count -= 1;
	return { payload: build(count) };
}

function getKnowledge(args: unknown, deps: ToolDeps, fits: Fits): ToolOutcome {
	const parsed = getArgs.safeParse(args ?? {});
	if (!parsed.success) return failure("invalid_arguments");
	const { handle } = parsed.data;
	const kind = handleKind(handle);
	if (!kind) return failure("invalid_arguments");
	return deps.store.readSnapshot((db): ToolOutcome => {
		let make: (scale: number, evidenceCount: number) => unknown;
		let list: PublicEvidenceList;
		if (kind === "knowledge") {
			const row = getKnowledgeByHandle(db, handle);
			if (!row || !visible(row)) return failure("not_found");
			list = publicEvidenceList(db, resolveKnowledgeEvidence(db, row.id));
			const extra: KnowledgeExtra = {
				supportCount: countSupportingAtoms(db, row.id),
				supersededBy: supersededByHandle(db, row),
				// An example is canonical text built from Episodes: one with no served Episode is
				// not served either (defence in depth; the examples stage takes only global ones).
				examples: row.examples.flatMap((ex) => {
					const episodes = ex.episodeIds.flatMap((id) => {
						const ep = getEpisodeById(db, id);
						return ep && visible(ep) && ep.status === "active"
							? [ep.handle]
							: [];
					});
					return episodes.length === 0
						? []
						: [
								{
									situation: ex.situation,
									action: ex.action,
									outcome: ex.outcome,
									episodes,
								},
							];
				}),
			};
			make = (scale, n) => knowledgeItem(row, extra, list, scale, n);
		} else {
			const row = getEpisodeByHandle(db, handle);
			if (!row || !visible(row)) return failure("not_found");
			list = publicEvidenceList(db, resolveEpisodeEvidence(db, row.id));
			make = (scale, n) => episodeItem(row, list, scale, n);
		}
		const wrap = (item: unknown) => ({
			contractVersion: KNOWLEDGE_CONTRACT,
			trust: TRUST,
			item,
		});
		// Shrink to the response limit: drop evidence from the tail, then cut the texts shorter.
		let evidenceCount = list.evidence.length;
		let scale = 1;
		while (evidenceCount > 0 && !fits(wrap(make(scale, evidenceCount))))
			evidenceCount -= 1;
		while (!fits(wrap(make(scale, evidenceCount)))) {
			scale *= 0.75;
			if (scale < 0.01) return failure("too_large");
		}
		return { payload: wrap(make(scale, evidenceCount)) };
	});
}

/**
 * The MCP passes no repoKey and never serves the personal space, retracted rows, repo scope or
 * evidence_only rows. A superseded row is served (with `supersededBy`) even though absorbing it
 * set it to evidence_only.
 */
function visible(row: KnowledgeRow | EpisodeRow): boolean {
	return (
		row.status !== "retracted" &&
		row.scope === "global" &&
		row.space !== "personal" &&
		(row.retrieval === "searchable" || row.status === "superseded")
	);
}

/**
 * The handle of the active canonical item that replaced a superseded item: the active `supersedes`
 * edge first, else a canonical item the item is derived from. Null when none is served.
 */
function supersededByHandle(db: Database, row: KnowledgeRow): string | null {
	if (row.status !== "superseded") return null;
	const ids = [
		...edgesTo(db, "knowledge", row.id, "supersedes")
			.filter((e) => e.status === "active" && e.src.kind === "knowledge")
			.map((e) => e.src.id),
		...listSupersededBy(db, row.id),
	];
	for (const id of ids) {
		const target = getKnowledgeById(db, id);
		if (
			target &&
			target.layer === "canonical" &&
			target.status === "active" &&
			visible(target)
		)
			return target.handle;
	}
	return null;
}

interface KnowledgeExtra {
	supportCount: number;
	supersededBy: string | null;
	examples: {
		situation: string;
		action: string;
		outcome: string;
		episodes: string[];
	}[];
}

function knowledgeItem(
	row: KnowledgeRow,
	extra: KnowledgeExtra,
	list: PublicEvidenceList,
	scale: number,
	evidenceCount: number,
) {
	const limit = Math.max(1, Math.floor(KNOWLEDGE_TEXT_CHARS * scale));
	return {
		handle: row.handle,
		kind: "knowledge",
		layer: row.layer,
		type: row.type,
		polarity: row.polarity,
		title: cutChars(row.title, limit),
		situation: cutChars(row.situation, limit),
		body: cutChars(row.body, limit),
		rationale: cutChars(row.rationale, limit),
		exceptions: row.exceptions.map((s) => cutChars(s, limit)),
		examples: extra.examples.map((ex) => ({
			situation: cutChars(ex.situation, limit),
			action: cutChars(ex.action, limit),
			outcome: cutChars(ex.outcome, limit),
			episodes: ex.episodes,
		})),
		appliesWhen: row.appliesWhen.map((s) => cutChars(s, limit)),
		notAppliesWhen: row.notAppliesWhen.map((s) => cutChars(s, limit)),
		steps: row.steps.map((s) => cutChars(s, limit)),
		confidence: row.confidence,
		importance: row.importance,
		status: row.status,
		space: row.space,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		supportCount: extra.supportCount,
		supersededBy: extra.supersededBy,
		evidence: list.evidence.slice(0, evidenceCount),
		evidenceTruncated: list.truncated || evidenceCount < list.evidence.length,
	};
}

function episodeItem(
	row: EpisodeRow,
	list: PublicEvidenceList,
	scale: number,
	evidenceCount: number,
) {
	const limit = Math.max(1, Math.floor(EPISODE_TEXT_CHARS * scale));
	const text = (s: string) => cutChars(s, limit);
	return {
		handle: row.handle,
		kind: "episode",
		title: text(row.title),
		situation: text(row.situation),
		intent: text(row.intent),
		decision: text(row.decision),
		observations: text(row.observations),
		action: text(row.action),
		outcome: text(row.outcome),
		lesson: text(row.lesson),
		openQuestions: row.openQuestions.map(text),
		outcomeKind: row.outcomeKind,
		eventStart: row.eventStart,
		eventEnd: row.eventEnd,
		timePrecision: row.timePrecision,
		confidence: row.confidence,
		importance: row.importance,
		status: row.status,
		space: row.space,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		evidence: list.evidence.slice(0, evidenceCount),
		evidenceTruncated: list.truncated || evidenceCount < list.evidence.length,
	};
}
