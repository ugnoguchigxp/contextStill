import path from "node:path";
import { config } from "../../config.js";
import type { CompileInput } from "../../shared/schemas/compile.schema.js";
import type { RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { embedOne } from "../embedding/embedding.service.js";
import { evidenceSearchInputSchema } from "../../shared/schemas/evidence.schema.js";
import {
  type EvidenceSearchResult,
  insertEvidenceFragment,
  searchEvidence,
  upsertEvidenceSource,
  vectorSearchEvidence,
} from "./evidence.repository.js";

export type EvidenceRetrievalResult = {
  items: EvidenceSearchResult[];
  degradedReasons: string[];
  stats: {
    hitCount: number;
    textHitCount: number;
    vectorHitCount: number;
    searchFailed: boolean;
    embeddingStatus: "generated" | "unavailable" | "disabled" | "provided";
  };
};

function getEvidenceRetrievalProfile(retrievalMode: RetrievalMode): {
  limit: number;
  sourceKinds?: Array<"markdown" | "session" | "tool_output" | "git" | "web" | "manual">;
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

function mergeEvidenceHits(
  primary: EvidenceSearchResult[],
  secondary: EvidenceSearchResult[],
  limit: number,
): EvidenceSearchResult[] {
  const byId = new Map<string, EvidenceSearchResult>();
  for (const item of [...primary, ...secondary]) {
    const existing = byId.get(item.id);
    if (!existing || item.score > existing.score) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function retrieveEvidence(
  input: CompileInput,
  options: { retrievalMode: RetrievalMode },
): Promise<EvidenceRetrievalResult> {
  const profile = getEvidenceRetrievalProfile(options.retrievalMode);
  const params = evidenceSearchInputSchema.parse({
    query: input.goal,
    limit: profile.limit,
    sourceKinds: profile.sourceKinds,
  });
  let items: EvidenceSearchResult[] = [];
  let textHits: EvidenceSearchResult[] = [];
  let vectorHits: EvidenceSearchResult[] = [];
  let searchFailed = false;
  let embeddingStatus: EvidenceRetrievalResult["stats"]["embeddingStatus"] = "disabled";
  const degradedReasons: string[] = [];
  try {
    const baseHits = await searchEvidence(params.query, params.limit, params.sourceKinds);
    textHits = baseHits;
    const pathHints = (input.files ?? [])
      .map((filePath) => path.basename(filePath))
      .filter((hint) => hint.length >= 3);
    if (pathHints.length > 0) {
      const hintHits = await searchEvidence(
        pathHints.slice(0, 2).join(" "),
        Math.max(3, Math.floor(params.limit / 2)),
        params.sourceKinds,
      );
      textHits = mergeEvidenceHits(baseHits, hintHits, params.limit);
    } else {
      textHits = baseHits;
    }

    if (config.enableVectorSearch) {
      try {
        const queryEmbedding = input.queryEmbedding ?? (await embedOne(input.goal, "query"));
        embeddingStatus = input.queryEmbedding ? "provided" : "generated";
        vectorHits = await vectorSearchEvidence(queryEmbedding, params.limit, params.sourceKinds);
      } catch {
        embeddingStatus = "unavailable";
        degradedReasons.push("EVIDENCE_QUERY_EMBEDDING_UNAVAILABLE");
      }
    }

    items = mergeEvidenceHits(textHits, vectorHits, params.limit);
  } catch {
    searchFailed = true;
    degradedReasons.push("EVIDENCE_SEARCH_FAILED");
  }
  if (!searchFailed && items.length === 0) {
    degradedReasons.push("NO_EVIDENCE_MATCH");
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

export async function registerEvidenceFromText(params: {
  sourceKind: "markdown" | "session" | "tool_output" | "git" | "web" | "manual";
  uri: string;
  title?: string;
  contentHash: string;
  text: string;
  locator?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ sourceId: string; fragmentId: string }> {
  let embedding: number[] | undefined;
  try {
    embedding = await embedOne(params.text, "passage");
  } catch {
    embedding = undefined;
  }
  const sourceId = await upsertEvidenceSource({
    sourceKind: params.sourceKind,
    uri: params.uri,
    title: params.title,
    contentHash: params.contentHash,
    metadata: params.metadata,
  });

  const fragmentId = await insertEvidenceFragment({
    sourceId,
    locator: params.locator ?? "full",
    content: params.text,
    metadata: params.metadata,
    embedding,
  });

  return { sourceId, fragmentId };
}
