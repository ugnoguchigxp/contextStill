import type { LandscapeUsageVerdict, LandscapeVerdictMix } from "./landscape-replay.types.js";
import type {
  LandscapeClassificationConfidence,
  LandscapeFeedbackConfidence,
} from "./landscape.types.js";

export type PackItemForReplay = {
  itemId: string;
  score: number;
  createdAt: Date;
};

export type UsageEventForReplay = {
  runId: string;
  knowledgeId: string;
  verdict: LandscapeUsageVerdict;
  actor: "agent" | "user" | "system";
  metadata: Record<string, unknown>;
};

export function emptyVerdictMix(): LandscapeVerdictMix {
  return { used: 0, notUsed: 0, offTopic: 0, wrong: 0 };
}

export function addVerdictMix(target: LandscapeVerdictMix, source: LandscapeVerdictMix): void {
  target.used += source.used;
  target.notUsed += source.notUsed;
  target.offTopic += source.offTopic;
  target.wrong += source.wrong;
}

export function incrementVerdict(
  target: LandscapeVerdictMix,
  verdict: LandscapeUsageVerdict,
): void {
  if (verdict === "used") target.used += 1;
  if (verdict === "not_used") target.notUsed += 1;
  if (verdict === "off_topic") target.offTopic += 1;
  if (verdict === "wrong") target.wrong += 1;
}

export function feedbackCount(mix: LandscapeVerdictMix): number {
  return mix.used + mix.notUsed + mix.offTopic + mix.wrong;
}

export function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function asKnowledgeNodeId(nodeId: string): string {
  return nodeId.replace(/^knowledge:/, "");
}

function orderPackItems(items: PackItemForReplay[]): PackItemForReplay[] {
  return [...items].sort(
    (a, b) =>
      b.score - a.score ||
      b.createdAt.getTime() - a.createdAt.getTime() ||
      a.itemId.localeCompare(b.itemId),
  );
}

export function buildSelectedRankMap(items: PackItemForReplay[]): Map<string, number> {
  const rankByKnowledgeId = new Map<string, number>();
  for (const [index, item] of orderPackItems(items).entries()) {
    if (rankByKnowledgeId.has(item.itemId)) continue;
    rankByKnowledgeId.set(item.itemId, index + 1);
  }
  return rankByKnowledgeId;
}

export function asClassificationConfidence(value: unknown): LandscapeClassificationConfidence {
  return value === "high" || value === "medium" ? value : "low";
}

export function asFeedbackConfidence(value: unknown): LandscapeFeedbackConfidence {
  return value === "high" || value === "medium" || value === "low" ? value : "insufficient";
}

export function groupByRunId<T extends { runId: string }>(rows: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const rowsForRun = result.get(row.runId) ?? [];
    rowsForRun.push(row);
    result.set(row.runId, rowsForRun);
  }
  return result;
}
