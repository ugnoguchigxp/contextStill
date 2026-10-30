import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SearchLane, SearchService } from "../../search";

export const evalCaseSchema = z
	.object({
		id: z.string().regex(/^[a-z0-9-]{1,64}$/),
		query: z.string().min(1).max(512),
		spaces: z.array(z.enum(["coding", "general", "eumenes"])).min(1),
		kinds: z
			.array(z.enum(["knowledge", "episode"]))
			.min(1)
			.default(["knowledge"]),
		relevant: z
			.array(
				z.object({
					ref: z
						.string()
						.regex(/^legacy:(knowledge_items|episode_cards):[0-9a-f-]{36}$/),
					grade: z.number().int().min(1).max(3),
				}),
			)
			.min(1),
		labelSource: z.enum(["agent-draft", "owner"]),
		style: z.enum(["paraphrase", "keyword", "question"]),
		note: z.string().max(500).optional(),
	})
	.strict();
export type EvalCase = z.infer<typeof evalCaseSchema>;

/**
 * `legacy-lexical`: v1 `native_knowledge.rs` (score_text + round(dynamicScore)).
 * `legacy-query-first`: v1 `context_compile` path (only query_score > 0 rows, by query_score
 * then dynamicScore). `v2-hybrid`: the v2 search service.
 */
export type EvalSystem = "legacy-lexical" | "legacy-query-first" | "v2-hybrid";
export type EvalStyle = EvalCase["style"];

export interface EvalArgs {
	setPath: string;
	systems: EvalSystem[];
	lanes: SearchLane[];
	k: number;
	outPath: string;
}

export interface EvalDeps {
	store: SqliteStore;
	search: SearchService;
	now: () => Date;
	log: (line: string) => void;
}

export interface SystemMetrics {
	recallAtK: number;
	mrrAtK: number;
	ndcgAtK: number;
	queries: number;
	zeroHit: number;
}

export interface EvalReport {
	set: string;
	k: number;
	lanes: SearchLane[];
	generatedAt: string;
	systems: Record<EvalSystem, SystemMetrics>;
	/** Relevant refs absent from the import map. Sorted, no duplicates. */
	unresolvedRefs: string[];
	/**
	 * Relevant refs that resolve but that search can never return for the case (status not
	 * active, scope not global, layer not atom, space or kind outside the case). They are
	 * left out of the relevant set. Sorted, no duplicates.
	 */
	unreachableRefs: string[];
	/** Metrics per case style; only the systems that ran are present. */
	byStyle: Record<EvalStyle, Partial<Record<EvalSystem, SystemMetrics>>>;
	perQuery: {
		id: string;
		system: EvalSystem;
		hits: string[];
		firstRelevantRank: number | null;
	}[];
	/** v2-hybrid vs legacy-lexical per case by nDCG@k (only when both ran). */
	wins: { v2: number; legacy: number; tie: number };
	/** v2-hybrid vs legacy-query-first per case by nDCG@k (only when both ran). */
	winsVsQueryFirst: { v2: number; legacy: number; tie: number };
}
