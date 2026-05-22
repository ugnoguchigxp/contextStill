import { describe, expect, test } from "vitest";
import { normalizeLlmUsage } from "../src/modules/llm/usage-normalizer.js";

describe("normalizeLlmUsage", () => {
  test("accepts number-like string values", () => {
    const usage = normalizeLlmUsage({
      promptTokens: "120",
      completionTokens: "45",
      totalTokens: "165",
      reasoningTokens: "12",
    });

    expect(usage).toEqual({
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
      reasoningTokens: 12,
    });
  });

  test("returns undefined when prompt/completion tokens are missing", () => {
    expect(
      normalizeLlmUsage({
        promptTokens: undefined,
        completionTokens: 40,
      }),
    ).toBeUndefined();
  });

  test("normalizes total tokens to be at least prompt+completion", () => {
    const usage = normalizeLlmUsage({
      promptTokens: 100,
      completionTokens: 30,
      totalTokens: 120,
    });
    expect(usage?.totalTokens).toBe(130);
  });
});
