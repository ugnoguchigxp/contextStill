const cjkPattern = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/gu;

export type EstimatedLlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

export type EstimateLlmUsageInput = {
  promptMessages?: readonly unknown[];
  promptMetadata?: unknown;
  completionText?: string | null;
  completionMetadata?: unknown;
};

function stableText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function estimateTextTokens(value: unknown): number {
  const text = stableText(value).normalize("NFKC").trim();
  if (!text) return 0;

  const cjkCount = [...text.matchAll(cjkPattern)].length;
  const nonCjkText = text.replace(cjkPattern, "");
  const nonCjkChars = nonCjkText.replace(/\s+/g, " ").trim().length;
  const estimated = cjkCount + Math.ceil(nonCjkChars / 4);

  return Math.max(1, estimated);
}

function estimateMessageTokens(message: unknown): number {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return estimateTextTokens(message);
  }

  const record = message as Record<string, unknown>;
  const roleTokens = estimateTextTokens(record.role);
  const contentTokens = estimateTextTokens(record.content);
  const nameTokens = estimateTextTokens(record.name);
  const toolCallTokens = estimateTextTokens(record.tool_calls);

  // Chat APIs add a small amount of per-message framing that is not visible in content.
  return 4 + roleTokens + contentTokens + nameTokens + toolCallTokens;
}

export function estimateLlmUsage(input: EstimateLlmUsageInput): EstimatedLlmUsage | null {
  const promptTokens =
    (input.promptMessages ?? []).reduce<number>(
      (total, message) => total + estimateMessageTokens(message),
      0,
    ) + estimateTextTokens(input.promptMetadata);
  const completionTokens =
    estimateTextTokens(input.completionText) + estimateTextTokens(input.completionMetadata);

  if (promptTokens === 0 && completionTokens === 0) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}
