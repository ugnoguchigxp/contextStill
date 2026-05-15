import { config } from "../../config.js";
import {
  buildRetrievalQueryText,
  normalizeRepoKey,
  normalizeRepoPath,
} from "../context-compiler/query-context.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import {
  knowledgeSearchInputSchema,
  type KnowledgeStatus,
} from "../../shared/schemas/knowledge.schema.js";
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
  types?: Array<"rule" | "procedure">;
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

export async function retrieveKnowledge(
  input: CompileInput,
  options: { retrievalMode: RetrievalMode },
): Promise<KnowledgeRetrievalResult> {
  const profile = getKnowledgeRetrievalProfile(options.retrievalMode);
  const limit = profile.limit;
  const degradedReasons: string[] = [];
  let textFailed = false;
  let vectorFailed = false;
  const statuses = resolveKnowledgeSearchStatuses({
    retrievalMode: options.retrievalMode,
    includeDraft: input.includeDraft,
  });
  const repoPath = normalizeRepoPath(input.repoPath);
  const repoKey = normalizeRepoKey(input.repoPath);
  const scopedSearch = Boolean(repoPath || repoKey);
  const primaryQuery = input.goal.trim();
  const queryText = buildRetrievalQueryText(input);

  const textInput = knowledgeSearchInputSchema.parse({
    query: primaryQuery,
    limit,
    types: profile.types,
    statuses,
    status: "active",
    includeDraft: input.includeDraft,
  });

  const runSearch = async (scope: {
    repoPath?: string;
    repoKey?: string;
    allowGlobalScope?: boolean;
  }): Promise<{
    textHits: KnowledgeSearchResult[];
    vectorHits: KnowledgeSearchResult[];
    embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"];
    embeddingProvider?: string;
    textFailed: boolean;
    vectorFailed: boolean;
  }> => {
    let nextTextHits: KnowledgeSearchResult[] = [];
    let nextVectorHits: KnowledgeSearchResult[] = [];
    let queryEmbedding = input.queryEmbedding;
    let embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"] =
      queryEmbedding && queryEmbedding.length > 0 ? "provided" : "disabled";
    let embeddingProvider: string | undefined;
    let nextTextFailed = false;
    let nextVectorFailed = false;

    try {
      nextTextHits = await searchKnowledge(textInput, {
        repoPath: scope.repoPath,
        repoKey: scope.repoKey,
        allowGlobalScope: scope.allowGlobalScope,
        types: profile.types,
      });
      if (queryText !== primaryQuery) {
        const hintHits = await searchKnowledge(
          {
            ...textInput,
            query: queryText,
            limit: Math.max(3, Math.floor(limit / 2)),
          },
          {
            repoPath: scope.repoPath,
            repoKey: scope.repoKey,
            allowGlobalScope: scope.allowGlobalScope,
            types: profile.types,
          },
        );
        nextTextHits = [
          ...new Map([...nextTextHits, ...hintHits].map((item) => [item.id, item])).values(),
        ];
      }
    } catch {
      nextTextFailed = true;
      degradedReasons.push("KNOWLEDGE_TEXT_SEARCH_FAILED");
    }

    if (config.enableVectorSearch) {
      if (!queryEmbedding || queryEmbedding.length === 0) {
        try {
          const generated = await embedOne(primaryQuery, "query");
          queryEmbedding = generated;
          embeddingStatus = "generated";
          embeddingProvider = config.embeddingProvider;
        } catch {
          embeddingStatus = "unavailable";
          degradedReasons.push("QUERY_EMBEDDING_UNAVAILABLE");
        }
      }

      if (queryEmbedding && queryEmbedding.length > 0) {
        try {
          nextVectorHits = await vectorSearchKnowledge(queryEmbedding, limit, statuses, {
            repoPath: scope.repoPath,
            repoKey: scope.repoKey,
            allowGlobalScope: scope.allowGlobalScope,
            types: profile.types,
          });
        } catch {
          nextVectorFailed = true;
          degradedReasons.push("KNOWLEDGE_VECTOR_SEARCH_FAILED");
        }
      }
    }
    return {
      textHits: nextTextHits,
      vectorHits: nextVectorHits,
      embeddingStatus,
      embeddingProvider,
      textFailed: nextTextFailed,
      vectorFailed: nextVectorFailed,
    };
  };

  const mergeHits = (hits: KnowledgeSearchResult[]): KnowledgeSearchResult[] => {
    const mergedById = new Map<string, KnowledgeSearchResult>();
    for (const item of hits) {
      const existing = mergedById.get(item.id);
      if (!existing || item.score > existing.score) {
        mergedById.set(item.id, item);
      }
    }
    return [...mergedById.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  };

  let searchResult = await runSearch({
    repoPath,
    repoKey,
    allowGlobalScope: true,
  });
  let merged = mergeHits([...searchResult.textHits, ...searchResult.vectorHits]);
  let repoScopeFallbackUsed = false;

  if (
    scopedSearch &&
    merged.length === 0 &&
    !searchResult.textFailed &&
    !searchResult.vectorFailed
  ) {
    repoScopeFallbackUsed = true;
    degradedReasons.push("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    searchResult = await runSearch({});
    merged = mergeHits([...searchResult.textHits, ...searchResult.vectorHits]);
  }

  textFailed = searchResult.textFailed;
  vectorFailed = searchResult.vectorFailed;

  if (merged.length === 0 && !textFailed && !vectorFailed) {
    degradedReasons.push("NO_ACTIVE_KNOWLEDGE_MATCH");
  }

  return {
    items: merged,
    degradedReasons,
    stats: {
      textHitCount: searchResult.textHits.length,
      vectorHitCount: searchResult.vectorHits.length,
      mergedCount: merged.length,
      textFailed,
      vectorFailed,
      embeddingStatus: searchResult.embeddingStatus,
      embeddingProvider: searchResult.embeddingProvider,
      scopedSearch,
      repoScopeFallbackUsed,
      queryText,
    },
  };
}

export async function searchKnowledgeCandidates(
  rawInput: unknown,
): Promise<KnowledgeRetrievalResult> {
  const parsed = knowledgeSearchInputSchema.parse(rawInput);
  const degradedReasons: string[] = [];
  const statuses =
    parsed.statuses && parsed.statuses.length > 0
      ? parsed.statuses
      : parsed.includeDraft
        ? (["active", "draft"] as KnowledgeStatus[])
        : ([parsed.status] as KnowledgeStatus[]);
  const primaryQuery = parsed.query.trim();
  const queryText = buildRetrievalQueryText({
    goal: primaryQuery,
    repoPath: parsed.repoPath,
    files: parsed.files,
    changeTypes: parsed.changeTypes,
    technologies: parsed.technologies,
  });
  const scopedSearch = Boolean(parsed.repoPath);
  const repoPath = normalizeRepoPath(parsed.repoPath);
  const repoKey = normalizeRepoKey(parsed.repoPath);

  const runSearch = async (scope: {
    repoPath?: string;
    repoKey?: string;
    allowGlobalScope?: boolean;
  }): Promise<{
    textHits: KnowledgeSearchResult[];
    vectorHits: KnowledgeSearchResult[];
    embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"];
    embeddingProvider?: string;
    textFailed: boolean;
    vectorFailed: boolean;
  }> => {
    let textHits: KnowledgeSearchResult[] = [];
    let vectorHits: KnowledgeSearchResult[] = [];
    let textFailed = false;
    let vectorFailed = false;
    let queryEmbedding: number[] | undefined;
    let embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"] = "disabled";
    let embeddingProvider: string | undefined;

    try {
      textHits = await searchKnowledge(
        {
          query: primaryQuery,
          limit: parsed.limit,
          types: parsed.types,
          statuses,
          status: parsed.status,
          includeDraft: parsed.includeDraft,
        },
        {
          repoPath: scope.repoPath,
          repoKey: scope.repoKey,
          allowGlobalScope: scope.allowGlobalScope,
          types: parsed.types,
        },
      );
      if (queryText !== primaryQuery) {
        const hintHits = await searchKnowledge(
          {
            query: queryText,
            limit: Math.max(3, Math.floor(parsed.limit / 2)),
            types: parsed.types,
            statuses,
            status: parsed.status,
            includeDraft: parsed.includeDraft,
          },
          {
            repoPath: scope.repoPath,
            repoKey: scope.repoKey,
            allowGlobalScope: scope.allowGlobalScope,
            types: parsed.types,
          },
        );
        textHits = [...new Map([...textHits, ...hintHits].map((item) => [item.id, item])).values()];
      }
    } catch {
      textFailed = true;
      degradedReasons.push("KNOWLEDGE_TEXT_SEARCH_FAILED");
    }

    if (config.enableVectorSearch) {
      try {
        queryEmbedding = await embedOne(primaryQuery, "query");
        embeddingStatus = "generated";
        embeddingProvider = config.embeddingProvider;
      } catch {
        embeddingStatus = "unavailable";
        degradedReasons.push("QUERY_EMBEDDING_UNAVAILABLE");
      }

      if (queryEmbedding && queryEmbedding.length > 0) {
        try {
          vectorHits = await vectorSearchKnowledge(queryEmbedding, parsed.limit, statuses, {
            repoPath: scope.repoPath,
            repoKey: scope.repoKey,
            allowGlobalScope: scope.allowGlobalScope,
            types: parsed.types,
          });
        } catch {
          vectorFailed = true;
          degradedReasons.push("KNOWLEDGE_VECTOR_SEARCH_FAILED");
        }
      }
    }

    return {
      textHits,
      vectorHits,
      embeddingStatus,
      embeddingProvider,
      textFailed,
      vectorFailed,
    };
  };

  const mergeHits = (hits: KnowledgeSearchResult[]): KnowledgeSearchResult[] => {
    const mergedById = new Map<string, KnowledgeSearchResult>();
    for (const item of hits) {
      const existing = mergedById.get(item.id);
      if (!existing || item.score > existing.score) {
        mergedById.set(item.id, item);
      }
    }
    return [...mergedById.values()].sort((a, b) => b.score - a.score).slice(0, parsed.limit);
  };

  let searchResult = await runSearch({
    repoPath,
    repoKey,
    allowGlobalScope: true,
  });
  let merged = mergeHits([...searchResult.textHits, ...searchResult.vectorHits]);
  let repoScopeFallbackUsed = false;

  if (
    scopedSearch &&
    merged.length === 0 &&
    !searchResult.textFailed &&
    !searchResult.vectorFailed
  ) {
    repoScopeFallbackUsed = true;
    degradedReasons.push("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    searchResult = await runSearch({});
    merged = mergeHits([...searchResult.textHits, ...searchResult.vectorHits]);
  }

  if (merged.length === 0 && !searchResult.textFailed && !searchResult.vectorFailed) {
    degradedReasons.push("NO_ACTIVE_KNOWLEDGE_MATCH");
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
      embeddingStatus: searchResult.embeddingStatus,
      embeddingProvider: searchResult.embeddingProvider,
      scopedSearch,
      repoScopeFallbackUsed,
      queryText,
    },
  };
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
