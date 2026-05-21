import { toUnitKnowledgeScore } from "../../lib/score-scale.js";

export type Rankable = {
  id: string;
  title: string;
  content: string;
  score: number;
  confidence?: number;
  importance?: number;
  dynamicScore?: number;
  decayFactor?: number;
  status?: string;
  hasSourceLinks?: boolean;
  sourceRefCount?: number;
  stale?: boolean;
  errorKeywordHits?: number;
  errorFileHits?: number;
  errorContextWeight?: number;
  applicabilityScore?: number;
};

function weightedScore(item: Rankable): number {
  const decayFactor = Math.min(1, Math.max(0, Number(item.decayFactor ?? 1)));
  const baseScore =
    item.score +
    toUnitKnowledgeScore(item.importance, 0) * 0.2 +
    toUnitKnowledgeScore(item.confidence, 0) * 0.1;
  const dynamicBoost = toUnitKnowledgeScore(item.dynamicScore, 0) * 0.12;
  const decayPenalty = (1 - decayFactor) * 0.12;
  const sourceLinkBoost = item.hasSourceLinks || (item.sourceRefCount ?? 0) > 0 ? 0.05 : 0;
  const errorKeywordBoost = Math.min(0.18, Math.max(0, item.errorKeywordHits ?? 0) * 0.03);
  const errorFileBoost = Math.min(0.16, Math.max(0, item.errorFileHits ?? 0) * 0.04);
  const errorContextBoost =
    (item.errorContextWeight ?? 0) > 0 && (errorKeywordBoost > 0 || errorFileBoost > 0) ? 0.06 : 0;
  const applicabilityBoost = Math.max(0, Number(item.applicabilityScore ?? 0));
  const deprecatedPenalty = item.status === "deprecated" ? 0.5 : 0;
  const stalePenalty = item.stale ? 0.4 : 0;
  return (
    baseScore +
    dynamicBoost +
    sourceLinkBoost +
    errorKeywordBoost +
    errorFileBoost +
    applicabilityBoost +
    errorContextBoost -
    decayPenalty -
    deprecatedPenalty -
    stalePenalty
  );
}

export function rankAndDedupe<T extends Rankable>(items: T[], limit: number): T[] {
  const byId = new Map<string, { item: T; weighted: number }>();
  for (const item of items) {
    const existing = byId.get(item.id);
    const weighted = weightedScore(item);
    if (!existing || weighted > existing.weighted) {
      byId.set(item.id, { item, weighted });
    }
  }

  return [...byId.values()]
    .sort((a, b) => {
      const scoreDelta = b.weighted - a.weighted;
      if (scoreDelta !== 0) return scoreDelta;
      const sourceRefDelta = (b.item.sourceRefCount ?? 0) - (a.item.sourceRefCount ?? 0);
      if (sourceRefDelta !== 0) return sourceRefDelta;
      const rawScoreDelta = b.item.score - a.item.score;
      if (rawScoreDelta !== 0) return rawScoreDelta;
      return a.item.id.localeCompare(b.item.id);
    })
    .map((entry) => entry.item)
    .slice(0, limit);
}
