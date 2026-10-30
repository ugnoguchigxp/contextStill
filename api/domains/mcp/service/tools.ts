import type { Database } from "bun:sqlite";
import { handleKind } from "../../../infrastructure/handle";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getEpisodeByHandle, type EpisodeRow } from "../../experience";
import { getKnowledgeByHandle, type KnowledgeRow } from "../../knowledge";
import { SearchError, type SearchHit, type SearchService } from "../../search";
import {
	cutChars,
	evidenceSummary,
	publicEvidenceList,
	type PublicEvidenceList,
	resolveEpisodeEvidence,
	resolveKnowledgeEvidence,
	type ResolvedEvidence,
} from "./evidence";
import { getArgs, searchArgs } from "./schemas";

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
		themes: [],
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
	let response;
	try {
		response = await deps.search.search(
			{
				query: a.query.trim(),
				kinds: a.kinds,
				spaces: a.spaces,
				...(a.types ? { types: a.types } : {}),
				limit: a.limit,
			},
			{ signal },
		);
	} catch (error) {
		if (error instanceof SearchError) return failure(error.code);
		throw error;
	}
	const results = deps.store.readSnapshot((db) =>
		response.hits.map((hit) => searchResult(db, hit)),
	);
	const degraded: string[] = [...response.degraded];
	if (a.depth > 0) degraded.push("expansion_unavailable");
	if (a.theme !== undefined) degraded.push("theme_unavailable");
	const build = (count: number) => ({
		contractVersion: SEARCH_CONTRACT,
		trust: TRUST,
		results: results.slice(0, count),
		warnings: [],
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
			make = (scale, n) => knowledgeItem(row, list, scale, n);
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

/** The MCP passes no repoKey and never serves the personal space, retracted rows or repo scope. */
function visible(row: KnowledgeRow | EpisodeRow): boolean {
	return (
		row.status !== "retracted" &&
		row.scope === "global" &&
		row.space !== "personal"
	);
}

function knowledgeItem(
	row: KnowledgeRow,
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
		body: cutChars(row.body, limit),
		appliesWhen: row.appliesWhen.map((s) => cutChars(s, limit)),
		notAppliesWhen: row.notAppliesWhen.map((s) => cutChars(s, limit)),
		steps: row.steps.map((s) => cutChars(s, limit)),
		confidence: row.confidence,
		importance: row.importance,
		status: row.status,
		space: row.space,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		// N1 stores no supersession link.
		supersededBy: null,
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
