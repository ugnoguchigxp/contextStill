import path from "node:path";
import { config } from "../../config.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { embedOne } from "../embedding/embedding.service.js";
import {
  type SourceKind,
  type SourceSearchResult,
  searchSourceContent,
  vectorSearchSourceContent,
} from "./source.repository.js";

export type SourceRetrievalResult = {
  items: SourceSearchResult[];
  degradedReasons: string[];
  stats: {
    hitCount: number;
    textHitCount: number;
    vectorHitCount: number;
    searchFailed: boolean;
    embeddingStatus: "generated" | "unavailable" | "disabled" | "provided";
  };
};

function getSourceRetrievalProfile(retrievalMode: RetrievalMode): {
  limit: number;
  sourceKinds?: SourceKind[];
} {
  switch (retrievalMode) {
    case "review_context":
      return { limit: 10, sourceKinds: ["markdown", "manual", "session", "tool_output"] };
    case "debug_context":
      return { limit: 12, sourceKinds: ["session", "tool_output", "git", "markdown"] };
    case "architecture_context":
      return { limit: 10, sourceKinds: ["markdown", "manual", "web", "git"] };
    case "skill_context":
      return { limit: 10, sourceKinds: ["manual", "markdown", "tool_output"] };
    case "learning_context":
      return { limit: 10 };
    default:
      return { limit: 8, sourceKinds: ["markdown", "manual", "git"] };
  }
}

function mergeSourceHits(
  primary: SourceSearchResult[],
  secondary: SourceSearchResult[],
  limit: number,
): SourceSearchResult[] {
  const byId = new Map<string, SourceSearchResult>();
  for (const item of [...primary, ...secondary]) {
    const existing = byId.get(item.id);
    if (!existing || item.score > existing.score) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function retrieveSources(
  input: CompileInput,
  options: { retrievalMode: RetrievalMode },
): Promise<SourceRetrievalResult> {
  const profile = getSourceRetrievalProfile(options.retrievalMode);
  let items: SourceSearchResult[] = [];
  let textHits: SourceSearchResult[] = [];
  let vectorHits: SourceSearchResult[] = [];
  let searchFailed = false;
  let embeddingStatus: SourceRetrievalResult["stats"]["embeddingStatus"] = "disabled";
  const degradedReasons: string[] = [];

  try {
    const baseHits = await searchSourceContent(input.goal, profile.limit, profile.sourceKinds);
    const pathHints = (input.files ?? [])
      .map((filePath) => path.basename(filePath))
      .filter((hint) => hint.length >= 3);

    if (pathHints.length > 0) {
      const hintHits = await searchSourceContent(
        pathHints.slice(0, 2).join(" "),
        Math.max(3, Math.floor(profile.limit / 2)),
        profile.sourceKinds,
      );
      textHits = mergeSourceHits(baseHits, hintHits, profile.limit);
    } else {
      textHits = baseHits;
    }

    if (config.enableVectorSearch) {
      try {
        const queryEmbedding = input.queryEmbedding ?? (await embedOne(input.goal, "query"));
        embeddingStatus = input.queryEmbedding ? "provided" : "generated";
        vectorHits = await vectorSearchSourceContent(
          queryEmbedding,
          profile.limit,
          profile.sourceKinds,
        );
      } catch {
        embeddingStatus = "unavailable";
        degradedReasons.push("SOURCE_QUERY_EMBEDDING_UNAVAILABLE");
      }
    }

    items = mergeSourceHits(textHits, vectorHits, profile.limit);
  } catch {
    searchFailed = true;
    degradedReasons.push("SOURCE_SEARCH_FAILED");
  }

  if (!searchFailed && items.length === 0) {
    degradedReasons.push("NO_SOURCE_MATCH");
  }

  return {
    items,
    degradedReasons,
    stats: {
      hitCount: items.length,
      textHitCount: textHits.length,
      vectorHitCount: vectorHits.length,
      searchFailed,
      embeddingStatus,
    },
  };
}
