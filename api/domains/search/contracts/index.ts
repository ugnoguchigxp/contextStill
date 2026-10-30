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
	/** 既定 ["canonical","atom"]（検索側は retrieval='searchable' かつ status='active' の行だけを返す） */
	layers?: KnowledgeLayer[];
	/** テーマのid。指定時はそのテーマと下位テーマに about で属する知識だけ */
	theme?: string;
	/**
	 * 評価の基準線専用。true なら status IN ('active','superseded') かつ retrieval を見ない。
	 * MCPは渡さない。
	 */
	includeSuperseded?: boolean;
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
	/** knowledge の層。episode は null */
	layer: KnowledgeLayer | null;
	/** 正本の状況。atom・episode は '' */
	situation: string;
	/** 属するテーマのid（about の辺。最大3件程度） */
	themes: string[];
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
