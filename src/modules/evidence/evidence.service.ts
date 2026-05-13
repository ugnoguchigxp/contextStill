import path from "node:path";
import type { CompileInput } from "../../shared/schemas/compile.schema.js";
import type { RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { evidenceSearchInputSchema } from "../../shared/schemas/evidence.schema.js";
import {
  type EvidenceSearchResult,
  insertEvidenceFragment,
  searchEvidence,
  upsertEvidenceSource,
} from "./evidence.repository.js";

export type EvidenceRetrievalResult = {
  items: EvidenceSearchResult[];
  degradedReasons: string[];
  stats: {
    hitCount: number;
    searchFailed: boolean;
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
  let searchFailed = false;
  const degradedReasons: string[] = [];
  try {
    const baseHits = await searchEvidence(params.query, params.limit, params.sourceKinds);
    const pathHints = (input.files ?? [])
      .map((filePath) => path.basename(filePath))
      .filter((hint) => hint.length >= 3);
    if (pathHints.length > 0) {
      const hintHits = await searchEvidence(
        pathHints.slice(0, 2).join(" "),
        Math.max(3, Math.floor(params.limit / 2)),
        params.sourceKinds,
      );
      items = mergeEvidenceHits(baseHits, hintHits, params.limit);
    } else {
      items = baseHits;
    }
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
    stats: { hitCount: items.length, searchFailed },
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
  });

  return { sourceId, fragmentId };
}
