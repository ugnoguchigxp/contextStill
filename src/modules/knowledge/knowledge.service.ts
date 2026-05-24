import { groupedConfig } from "../../config.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import {
  type KnowledgeItem,
  type KnowledgeStatus,
  knowledgeSearchInputSchema,
} from "../../shared/schemas/knowledge.schema.js";
import {
  buildRetrievalQueryText,
  normalizeRepoKey,
  normalizeRepoPath,
} from "../context-compiler/query-context.js";
import { embedOne } from "../embedding/embedding.service.js";
import { resolveKnowledgeSearchStatuses } from "../lifecycle/lifecycle.service.js";
import {
  type KnowledgeSearchResult,
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "./knowledge.repository.js";

export type KnowledgeCandidateEvidence = {
  textMatched: boolean;
  vectorMatched: boolean;
  vectorScore?: number;
  facetMatched: boolean;
};

type KnowledgeSearchResultWithEvidence = KnowledgeSearchResult & {
  candidateEvidence?: KnowledgeCandidateEvidence;
};

export type KnowledgeRetrievalTraceEntry = {
  id: string;
  rank: number;
  score: number;
};

export type KnowledgeRetrievalTrace = {
  text: KnowledgeRetrievalTraceEntry[];
  vector: KnowledgeRetrievalTraceEntry[];
  merged: KnowledgeRetrievalTraceEntry[];
};

export type KnowledgeRetrievalResult = {
  items: KnowledgeSearchResultWithEvidence[];
  degradedReasons: string[];
  trace: KnowledgeRetrievalTrace;
  stats: {
    textHitCount: number;
    vectorHitCount: number;
    mergedCount: number;
    textFailed: boolean;
    vectorFailed: boolean;
    embeddingStatus: "provided" | "generated" | "unavailable" | "disabled";
    embeddingProvider?: string;
    scopedSearch: boolean;
    repoScopeFallbackUsed: boolean;
    queryText: string;
  };
};

function getKnowledgeRetrievalProfile(retrievalMode: RetrievalMode): {
  limit: number;
  types?: KnowledgeItem["type"][];
} {
  switch (retrievalMode) {
    case "review_context":
      return { limit: 12, types: ["rule", "procedure"] };
    case "debug_context":
      return { limit: 14, types: ["procedure", "rule"] };
    case "architecture_context":
      return { limit: 12, types: ["rule"] };
    case "procedure_context":
      return { limit: 10, types: ["procedure"] };
    case "learning_context":
      return { limit: 15 };
    default:
      return { limit: 12 };
  }
}

type KnowledgeSearchScope = {
  repoPath?: string;
  repoKey?: string;
  allowGlobalScope?: boolean;
  scopeMatchMode?: "primary" | "legacy";
};

type InternalKnowledgeSearchParams = {
  primaryQuery: string;
  queryText: string;
  limit: number;
  statuses: KnowledgeStatus[];
  status: KnowledgeStatus;
  includeDraft: boolean;
  types?: KnowledgeItem["type"][];
  repoPath?: string;
  repoKey?: string;
  scopedSearch: boolean;
  queryEmbedding?: number[];
  generateEmbeddingIfMissing: boolean;
  noMatchReason: string;
  repoScopeFallbackReason: string;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  includeGeneral?: boolean;
};

function mergeKnowledgeHits(hits: KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] {
  const mergedById = new Map<string, KnowledgeSearchResult>();
  for (const item of hits) {
    const existing = mergedById.get(item.id);
    if (!existing || item.score > existing.score) {
      mergedById.set(item.id, item);
    }
  }
  return [...mergedById.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function hasFacetMatch(item: KnowledgeSearchResult): boolean {
  const matches = item.applicabilityMatches;
  if (!matches) return false;
  return (
    matches.technologies.length > 0 ||
    matches.changeTypes.length > 0 ||
    matches.domains.length > 0 ||
    matches.general
  );
}

function mergeCandidateEvidence(
  target: KnowledgeCandidateEvidence | undefined,
  incoming: Partial<KnowledgeCandidateEvidence>,
): KnowledgeCandidateEvidence {
  const merged: KnowledgeCandidateEvidence = {
    textMatched: target?.textMatched ?? false,
    vectorMatched: target?.vectorMatched ?? false,
    facetMatched: target?.facetMatched ?? false,
    ...(typeof target?.vectorScore === "number" ? { vectorScore: target.vectorScore } : {}),
  };

  if (incoming.textMatched) merged.textMatched = true;
  if (incoming.vectorMatched) merged.vectorMatched = true;
  if (incoming.facetMatched) merged.facetMatched = true;
  if (typeof incoming.vectorScore === "number") {
    merged.vectorScore =
      typeof merged.vectorScore === "number"
        ? Math.max(merged.vectorScore, incoming.vectorScore)
        : incoming.vectorScore;
  }

  return merged;
}

function buildCandidateEvidenceMap(params: {
  textHits: KnowledgeSearchResult[];
  vectorHits: KnowledgeSearchResult[];
  merged: KnowledgeSearchResult[];
}): Map<string, KnowledgeCandidateEvidence> {
  const evidenceById = new Map<string, KnowledgeCandidateEvidence>();

  for (const hit of params.textHits) {
    evidenceById.set(
      hit.id,
      mergeCandidateEvidence(evidenceById.get(hit.id), {
        textMatched: true,
        facetMatched: hasFacetMatch(hit),
      }),
    );
  }

  for (const hit of params.vectorHits) {
    evidenceById.set(
      hit.id,
      mergeCandidateEvidence(evidenceById.get(hit.id), {
        vectorMatched: true,
        vectorScore: hit.score,
        facetMatched: hasFacetMatch(hit),
      }),
    );
  }

  for (const item of params.merged) {
    evidenceById.set(
      item.id,
      mergeCandidateEvidence(evidenceById.get(item.id), {
        facetMatched: hasFacetMatch(item),
      }),
    );
  }

  return evidenceById;
}

function appendDegradedReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function buildRankedTraceEntries(items: KnowledgeSearchResult[]): KnowledgeRetrievalTraceEntry[] {
  const deduped = [...new Map(items.map((item) => [item.id, item])).values()].sort(
    (a, b) => b.score - a.score,
  );
  return deduped.map((item, index) => ({
    id: item.id,
    rank: index + 1,
    score: item.score,
  }));
}

async function executeKnowledgeSearch(
  params: InternalKnowledgeSearchParams,
): Promise<KnowledgeRetrievalResult> {
  const degradedReasons: string[] = [];
  let workingEmbedding = params.queryEmbedding;
  let embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"] =
    workingEmbedding && workingEmbedding.length > 0 ? "provided" : "disabled";
  let embeddingProvider: string | undefined;

  const buildSearchInput = (query: string, limit: number, repoPath?: string) =>
    knowledgeSearchInputSchema.parse({
      query,
      limit,
      types: params.types,
      statuses: params.statuses,
      status: params.status,
      includeDraft: params.includeDraft,
      technologies: params.technologies,
      changeTypes: params.changeTypes,
      domains: params.domains,
      includeGeneral: params.includeGeneral ?? true,
      ...(repoPath ? { repoPath } : {}),
    });

  const runScopedSearch = async (
    scope: KnowledgeSearchScope,
  ): Promise<{
    textHits: KnowledgeSearchResult[];
    vectorHits: KnowledgeSearchResult[];
    textFailed: boolean;
    vectorFailed: boolean;
  }> => {
    let textHits: KnowledgeSearchResult[] = [];
    let vectorHits: KnowledgeSearchResult[] = [];
    let textFailed = false;
    let vectorFailed = false;

    try {
      textHits = await searchKnowledge(
        buildSearchInput(params.primaryQuery, params.limit, scope.repoPath),
        {
          repoPath: scope.repoPath,
          repoKey: scope.repoKey,
          allowGlobalScope: scope.allowGlobalScope,
          types: params.types,
          scopeMatchMode: scope.scopeMatchMode,
          technologies: params.technologies,
          changeTypes: params.changeTypes,
          domains: params.domains,
          includeGeneral: params.includeGeneral ?? true,
        },
      );
      if (params.queryText !== params.primaryQuery) {
        const hintHits = await searchKnowledge(
          buildSearchInput(
            params.queryText,
            Math.max(3, Math.floor(params.limit / 2)),
            scope.repoPath,
          ),
          {
            repoPath: scope.repoPath,
            repoKey: scope.repoKey,
            allowGlobalScope: scope.allowGlobalScope,
            types: params.types,
            scopeMatchMode: scope.scopeMatchMode,
            technologies: params.technologies,
            changeTypes: params.changeTypes,
            domains: params.domains,
            includeGeneral: params.includeGeneral ?? true,
          },
        );
        textHits = [...new Map([...textHits, ...hintHits].map((item) => [item.id, item])).values()];
      }
    } catch {
      textFailed = true;
      appendDegradedReason(degradedReasons, "KNOWLEDGE_TEXT_SEARCH_FAILED");
    }

    if (groupedConfig.compile.enableVectorSearch) {
      if (
        (!workingEmbedding || workingEmbedding.length === 0) &&
        params.generateEmbeddingIfMissing
      ) {
        try {
          workingEmbedding = await embedOne(params.primaryQuery, "query");
          embeddingStatus = "generated";
          embeddingProvider = groupedConfig.embedding.provider;
        } catch {
          embeddingStatus = "unavailable";
          appendDegradedReason(degradedReasons, "QUERY_EMBEDDING_UNAVAILABLE");
        }
      }
      if (workingEmbedding && workingEmbedding.length > 0) {
        try {
          vectorHits = await vectorSearchKnowledge(
            workingEmbedding,
            params.limit,
            params.statuses,
            {
              repoPath: scope.repoPath,
              repoKey: scope.repoKey,
              allowGlobalScope: scope.allowGlobalScope,
              types: params.types,
              scopeMatchMode: scope.scopeMatchMode,
              technologies: params.technologies,
              changeTypes: params.changeTypes,
              domains: params.domains,
              includeGeneral: params.includeGeneral ?? true,
            },
          );
        } catch {
          vectorFailed = true;
          appendDegradedReason(degradedReasons, "KNOWLEDGE_VECTOR_SEARCH_FAILED");
        }
      }
    }

    return {
      textHits,
      vectorHits,
      textFailed,
      vectorFailed,
    };
  };

  let searchResult = await runScopedSearch({
    repoPath: params.repoPath,
    repoKey: params.repoKey,
    allowGlobalScope: true,
    scopeMatchMode: "primary",
  });
  let merged = mergeKnowledgeHits(
    [...searchResult.textHits, ...searchResult.vectorHits],
    params.limit,
  );
  let repoScopeFallbackUsed = false;

  if (
    params.scopedSearch &&
    merged.length === 0 &&
    !searchResult.textFailed &&
    !searchResult.vectorFailed
  ) {
    const legacyScopedResult = await runScopedSearch({
      repoPath: params.repoPath,
      repoKey: params.repoKey,
      allowGlobalScope: false,
      scopeMatchMode: "legacy",
    });
    const legacyMerged = mergeKnowledgeHits(
      [...legacyScopedResult.textHits, ...legacyScopedResult.vectorHits],
      params.limit,
    );
    if (legacyMerged.length > 0) {
      searchResult = legacyScopedResult;
      merged = legacyMerged;
      appendDegradedReason(degradedReasons, "KNOWLEDGE_APPLIES_TO_FALLBACK");
    }
  }

  if (
    params.scopedSearch &&
    merged.length === 0 &&
    !searchResult.textFailed &&
    !searchResult.vectorFailed
  ) {
    repoScopeFallbackUsed = true;
    appendDegradedReason(degradedReasons, params.repoScopeFallbackReason);
    searchResult = await runScopedSearch({});
    merged = mergeKnowledgeHits(
      [...searchResult.textHits, ...searchResult.vectorHits],
      params.limit,
    );
  }

  if (merged.length === 0 && !searchResult.textFailed && !searchResult.vectorFailed) {
    appendDegradedReason(degradedReasons, params.noMatchReason);
  }

  const evidenceById = buildCandidateEvidenceMap({
    textHits: searchResult.textHits,
    vectorHits: searchResult.vectorHits,
    merged,
  });

  const textTrace = buildRankedTraceEntries(searchResult.textHits);
  const vectorTrace = buildRankedTraceEntries(searchResult.vectorHits);
  const mergedTrace = buildRankedTraceEntries(merged);

  return {
    items: merged.map((item) => ({
      ...item,
      candidateEvidence: evidenceById.get(item.id),
    })),
    degradedReasons,
    trace: {
      text: textTrace,
      vector: vectorTrace,
      merged: mergedTrace,
    },
    stats: {
      textHitCount: textTrace.length,
      vectorHitCount: vectorTrace.length,
      mergedCount: mergedTrace.length,
      textFailed: searchResult.textFailed,
      vectorFailed: searchResult.vectorFailed,
      embeddingStatus,
      embeddingProvider,
      scopedSearch: params.scopedSearch,
      repoScopeFallbackUsed,
      queryText: params.queryText,
    },
  };
}

export async function retrieveKnowledge(
  input: CompileInput,
  options: {
    retrievalMode: RetrievalMode;
    limit?: number;
    facetFilters?: {
      changeTypes?: string[];
      technologies?: string[];
      domains?: string[];
    };
  },
): Promise<KnowledgeRetrievalResult> {
  const profile = getKnowledgeRetrievalProfile(options.retrievalMode);
  const limit =
    typeof options.limit === "number" && Number.isInteger(options.limit) && options.limit > 0
      ? options.limit
      : profile.limit;
  const statuses = resolveKnowledgeSearchStatuses({
    retrievalMode: options.retrievalMode,
    includeDraft: false,
  });
  return executeKnowledgeSearch({
    primaryQuery: input.goal.trim(),
    queryText: buildRetrievalQueryText(input),
    limit,
    statuses,
    status: "active",
    includeDraft: false,
    types: profile.types,
    scopedSearch: false,
    generateEmbeddingIfMissing: true,
    noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH",
    repoScopeFallbackReason: "KNOWLEDGE_REPO_SCOPE_FALLBACK",
    technologies: options.facetFilters?.technologies ?? input.technologies,
    changeTypes: options.facetFilters?.changeTypes ?? input.changeTypes,
    domains: options.facetFilters?.domains ?? input.domains,
    includeGeneral: true,
  });
}

export async function searchKnowledgeCandidates(
  rawInput: unknown,
): Promise<KnowledgeRetrievalResult> {
  const parsed = knowledgeSearchInputSchema.parse(rawInput);
  const statuses =
    parsed.statuses && parsed.statuses.length > 0
      ? parsed.statuses
      : parsed.includeDraft
        ? (["active", "draft"] as KnowledgeStatus[])
        : ([parsed.status] as KnowledgeStatus[]);
  const repoPath = normalizeRepoPath(parsed.repoPath);
  const repoKey = normalizeRepoKey(parsed.repoPath);
  const primaryQuery = parsed.query.trim();
  return executeKnowledgeSearch({
    primaryQuery,
    queryText: buildRetrievalQueryText({
      goal: primaryQuery,
      changeTypes: parsed.changeTypes,
      technologies: parsed.technologies,
      domains: parsed.domains,
    }),
    limit: parsed.limit,
    statuses,
    status: parsed.status,
    includeDraft: parsed.includeDraft,
    types: parsed.types,
    repoPath,
    repoKey,
    scopedSearch: Boolean(repoPath || repoKey),
    generateEmbeddingIfMissing: true,
    noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH",
    repoScopeFallbackReason: "KNOWLEDGE_REPO_SCOPE_FALLBACK",
    technologies: parsed.technologies,
    changeTypes: parsed.changeTypes,
    domains: parsed.domains,
    includeGeneral: parsed.includeGeneral,
  });
}

export async function registerKnowledgeFromMarkdown(params: {
  sourceUri: string;
  title: string;
  body: string;
  type?: "rule" | "procedure";
  status?: KnowledgeStatus;
  scope?: "repo" | "global";
  confidence?: number;
  importance?: number;
  appliesTo?: Record<string, unknown>;
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
}): Promise<string> {
  let embedding = params.embedding;
  if (!embedding) {
    try {
      embedding = await embedOne(`${params.title}\n${params.body}`, "passage");
    } catch {
      embedding = undefined;
    }
  }
  return upsertKnowledgeFromSource({
    sourceUri: params.sourceUri,
    type: params.type ?? "rule",
    status: params.status ?? "draft",
    scope: params.scope ?? "repo",
    title: params.title,
    body: params.body,
    confidence: params.confidence,
    importance: params.importance,
    appliesTo: {
      ...(params.appliesTo ?? {}),
      ...(params.general !== undefined ? { general: params.general } : {}),
      ...(params.technologies ? { technologies: params.technologies } : {}),
      ...(params.changeTypes ? { changeTypes: params.changeTypes } : {}),
      ...(params.domains ? { domains: params.domains } : {}),
      ...(params.repoPath ? { repoPath: params.repoPath } : {}),
      ...(params.repoKey ? { repoKey: params.repoKey } : {}),
    },
    metadata: params.metadata,
    embedding,
  });
}
