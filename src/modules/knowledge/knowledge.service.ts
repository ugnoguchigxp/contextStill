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

export type KnowledgeRetrievalResult = {
  items: KnowledgeSearchResult[];
  degradedReasons: string[];
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

function appendDegradedReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
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

  return {
    items: merged,
    degradedReasons,
    stats: {
      textHitCount: searchResult.textHits.length,
      vectorHitCount: searchResult.vectorHits.length,
      mergedCount: merged.length,
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
  options: { retrievalMode: RetrievalMode },
): Promise<KnowledgeRetrievalResult> {
  const profile = getKnowledgeRetrievalProfile(options.retrievalMode);
  const statuses = resolveKnowledgeSearchStatuses({
    retrievalMode: options.retrievalMode,
    includeDraft: input.includeDraft,
  });
  const repoPath = normalizeRepoPath(input.repoPath);
  const repoKey = normalizeRepoKey(input.repoPath);
  const scopedSearch = Boolean(repoPath || repoKey);
  return executeKnowledgeSearch({
    primaryQuery: input.goal.trim(),
    queryText: buildRetrievalQueryText(input),
    limit: profile.limit,
    statuses,
    status: "active",
    includeDraft: input.includeDraft,
    types: profile.types,
    repoPath,
    repoKey,
    scopedSearch,
    queryEmbedding: input.queryEmbedding,
    generateEmbeddingIfMissing: true,
    noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH",
    repoScopeFallbackReason: "KNOWLEDGE_REPO_SCOPE_FALLBACK",
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
      repoPath: parsed.repoPath,
      files: parsed.files,
      changeTypes: parsed.changeTypes,
      technologies: parsed.technologies,
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
  });
}

export async function registerKnowledgeFromMarkdown(params: {
  sourceUri: string;
  contentHash: string;
  title: string;
  body: string;
  type?: "rule" | "procedure";
  status?: KnowledgeStatus;
  scope?: "repo" | "global";
  confidence?: number;
  importance?: number;
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
    contentHash: params.contentHash,
    type: params.type ?? "rule",
    status: params.status ?? "draft",
    scope: params.scope ?? "repo",
    title: params.title,
    body: params.body,
    confidence: params.confidence,
    importance: params.importance,
    metadata: params.metadata,
    embedding,
  });
}
