import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Space } from "../../../infrastructure/scope";
import type { KnowledgeLayer, KnowledgeType, Polarity } from "../../knowledge";

export type SearchKind = "knowledge" | "episode";
export type SearchLane = "fts" | "short" | "vector";
export type DegradedReason =
	| "vector_unavailable"
	| "vector_unverified"
	| "no_lexical_terms"
	| "expansion_unavailable"
	| "theme_unavailable";

export interface SearchRequest {
	/** trim後 1..512文字 */
	query: string;
	/** 1件以上 */
	kinds: SearchKind[];
	/** 1件以上。"personal"を含むと SearchError("space_not_allowed") */
	spaces: Space[];
	/** 未指定ならrepo scopeの行は対象外 */
	repoKey?: string | null;
	/** knowledgeだけに効く */
	types?: KnowledgeType[];
	/** 既定 ["atom"]（N2で既定を見直すhook） */
	layers?: KnowledgeLayer[];
	/** 1..50 */
	limit: number;
	/** 既定は3つすべて */
	lanes?: SearchLane[];
	/** 指定時はLARMを呼ばない（test・評価用） */
	queryVector?: Float32Array;
}

export interface SearchHit {
	kind: SearchKind;
	id: string;
	handle: string;
	title: string;
	summary: string;
	type: KnowledgeType | null;
	polarity: Polarity | null;
	status: string;
	space: Space;
	confidence: number;
	score: number;
	lanes: { lane: SearchLane; rank: number; raw: number }[];
}

export interface SearchResponse {
	hits: SearchHit[];
	degraded: DegradedReason[];
	lanesUsed: SearchLane[];
	candidateCounts: Record<SearchLane, number>;
}

export class SearchError extends Error {
	constructor(public code: "invalid_query" | "space_not_allowed") {
		super(code);
		this.name = "SearchError";
	}
}

export interface SearchService {
	search(
		req: SearchRequest,
		opts?: { signal?: AbortSignal },
	): Promise<SearchResponse>;
}

export interface SearchDeps {
	store: SqliteStore;
	spaceKey: string;
	embedQuery?: (text: string, signal?: AbortSignal) => Promise<Float32Array>;
	queryTimeoutMs?: number;
}

export const errorStatus = {
	invalid_query: 400,
	space_not_allowed: 403,
} as const;
