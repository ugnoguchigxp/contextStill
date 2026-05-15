const KNOWLEDGE_SCORE_MIN = 0;
const KNOWLEDGE_SCORE_MAX = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeKnowledgeScore(value: unknown, fallback: number): number {
  const fallbackScore = clamp(Number(fallback), KNOWLEDGE_SCORE_MIN, KNOWLEDGE_SCORE_MAX);
  if (value === null || value === undefined || value === "") return fallbackScore;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallbackScore;
  // Preserve an explicit 1% input; only fractional legacy values are upscaled.
  if (num > 0 && num < 1) return clamp(num * 100, KNOWLEDGE_SCORE_MIN, KNOWLEDGE_SCORE_MAX);
  return clamp(num, KNOWLEDGE_SCORE_MIN, KNOWLEDGE_SCORE_MAX);
}

export function toUnitKnowledgeScore(value: unknown, fallback = 0): number {
  return normalizeKnowledgeScore(value, fallback) / 100;
}
