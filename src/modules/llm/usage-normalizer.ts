import type { LlmChatResponse } from "./llm-provider.js";

export type NormalizedLlmUsage = NonNullable<LlmChatResponse["usage"]>;

function toNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return Math.round(parsed);
  }
  return undefined;
}

export function normalizeLlmUsage(input: {
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
  reasoningTokens?: unknown;
}): NormalizedLlmUsage | undefined {
  const promptTokens = toNonNegativeInteger(input.promptTokens);
  const completionTokens = toNonNegativeInteger(input.completionTokens);
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }

  const totalTokensCandidate = toNonNegativeInteger(input.totalTokens);
  const totalTokens = Math.max(
    promptTokens + completionTokens,
    totalTokensCandidate ?? promptTokens + completionTokens,
  );
  const reasoningTokens = toNonNegativeInteger(input.reasoningTokens) ?? 0;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
  };
}
