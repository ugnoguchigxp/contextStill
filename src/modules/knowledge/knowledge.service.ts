import { config } from "../../config.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { knowledgeSearchInputSchema } from "../../shared/schemas/knowledge.schema.js";
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
  };
};

function getKnowledgeRetrievalProfile(retrievalMode: RetrievalMode): {
  limit: number;
  types?: Array<
    "fact" | "decision" | "rule" | "procedure" | "skill" | "risk" | "lesson" | "example"
  >;
} {
  switch (retrievalMode) {
    case "review_context":
      return { limit: 12, types: ["rule", "risk", "decision", "example"] };
    case "debug_context":
      return { limit: 14, types: ["risk", "lesson", "procedure", "example", "rule"] };
    case "architecture_context":
      return { limit: 12, types: ["decision", "rule", "fact"] };
    case "skill_context":
      return { limit: 10, types: ["skill", "procedure"] };
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
    includeTrial: input.includeTrial,
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
  if (config.enableVectorSearch) {
    if (input.queryEmbedding && input.queryEmbedding.length > 0) {
      try {
        vectorHits = await vectorSearchKnowledge(input.queryEmbedding, limit, statuses);
      } catch {
        vectorFailed.value = true;
        degradedReasons.push("KNOWLEDGE_VECTOR_SEARCH_FAILED");
      }
    } else {
      degradedReasons.push("VECTOR_EMBEDDING_NOT_PROVIDED");
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
    },
  };
}

export async function registerKnowledgeFromMarkdown(params: {
  sourceUri: string;
  contentHash: string;
  title: string;
  body: string;
  type?: "fact" | "decision" | "rule" | "procedure" | "skill" | "risk" | "lesson" | "example";
  status?: "candidate" | "draft" | "trial" | "active" | "deprecated" | "rejected";
  scope?: "user" | "repo" | "workspace" | "org" | "global";
  confidence?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  return upsertKnowledgeFromSource({
    sourceUri: params.sourceUri,
    contentHash: params.contentHash,
    type: params.type ?? "fact",
    status: params.status ?? "draft",
    scope: params.scope ?? "repo",
    title: params.title,
    body: params.body,
    confidence: params.confidence,
    importance: params.importance,
    metadata: params.metadata,
  });
}
