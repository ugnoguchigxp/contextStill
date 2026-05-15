import { config } from "../../config.js";
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
  const textFailed = { value: false };
  const vectorFailed = { value: false };
  const statuses = resolveKnowledgeSearchStatuses({
    retrievalMode: options.retrievalMode,
    includeDraft: input.includeDraft,
  });

  const textInput = knowledgeSearchInputSchema.parse({
    query: input.goal,
    limit,
    types: profile.types,
    statuses,
    status: "active",
  });

  let textHits: KnowledgeSearchResult[] = [];
  try {
    textHits = await searchKnowledge(textInput);
  } catch {
    textFailed.value = true;
    degradedReasons.push("KNOWLEDGE_TEXT_SEARCH_FAILED");
  }

  let vectorHits: KnowledgeSearchResult[] = [];
  let queryEmbedding = input.queryEmbedding;
  let embeddingStatus: KnowledgeRetrievalResult["stats"]["embeddingStatus"] =
    queryEmbedding && queryEmbedding.length > 0 ? "provided" : "disabled";
  let embeddingProvider: string | undefined;
  if (config.enableVectorSearch) {
    if (!queryEmbedding || queryEmbedding.length === 0) {
      try {
        const generated = await embedOne(input.goal, "query");
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
        vectorHits = await vectorSearchKnowledge(queryEmbedding, limit, statuses);
      } catch {
        vectorFailed.value = true;
        degradedReasons.push("KNOWLEDGE_VECTOR_SEARCH_FAILED");
      }
    }
  }

  const mergedById = new Map<string, KnowledgeSearchResult>();
  for (const item of [...textHits, ...vectorHits]) {
    const existing = mergedById.get(item.id);
    if (!existing || item.score > existing.score) {
      mergedById.set(item.id, item);
    }
  }

  const merged = [...mergedById.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  if (merged.length === 0 && !textFailed.value && !vectorFailed.value) {
    degradedReasons.push("NO_ACTIVE_KNOWLEDGE_MATCH");
  }

  return {
    items: merged,
    degradedReasons,
    stats: {
      textHitCount: textHits.length,
      vectorHitCount: vectorHits.length,
      mergedCount: merged.length,
      textFailed: textFailed.value,
      vectorFailed: vectorFailed.value,
      embeddingStatus,
      embeddingProvider,
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
}): Promise<string> {
  let embedding: number[] | undefined;
  try {
    embedding = await embedOne(`${params.title}\n${params.body}`, "passage");
  } catch {
    embedding = undefined;
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
