import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { llmUsageLogs } from "../src/db/schema.js";
import { logLlmUsage, recordLlmUsage } from "../src/modules/llm/llm-usage-logger.js";

const valuesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: valuesMock,
    })),
  },
}));

describe("logLlmUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("records estimated tokens when provider usage is missing", async () => {
    await logLlmUsage({
      provider: "local-llm",
      model: "gemma-4-e4b-it",
      promptMessages: [{ role: "user", content: "日本語の質問と English context" }],
      completionText: "回答します",
      source: "distillation",
    });

    expect(db.insert).toHaveBeenCalledWith(llmUsageLogs);
    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toEqual(
      expect.objectContaining({
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        costJpy: 0,
        usageMode: "estimated",
        source: "distillation",
      }),
    );
    expect(row.promptTokens).toBeGreaterThan(0);
    expect(row.completionTokens).toBeGreaterThan(0);
    expect(row.totalTokens).toBe(row.promptTokens + row.completionTokens);
  });

  test("uses measured provider usage when it exists", async () => {
    await logLlmUsage({
      provider: "azure-openai",
      model: "gpt-4o",
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        reasoningTokens: 3,
      },
      promptMessages: [{ role: "user", content: "fallback should not win" }],
      completionText: "fallback",
      source: "context-compiler",
    });

    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toEqual(
      expect.objectContaining({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        reasoningTokens: 3,
        usageMode: "measured",
        source: "context-compiler",
      }),
    );
  });

  test("falls back to estimated usage when measured usage is malformed", async () => {
    await logLlmUsage({
      provider: "azure-openai",
      model: "gpt-4o",
      usage: {
        promptTokens: Number.NaN,
        completionTokens: 20,
        totalTokens: 20,
      } as any,
      promptMessages: [{ role: "user", content: "fallback prompt" }],
      completionText: "fallback completion",
      source: "context-compiler",
    });

    const row = valuesMock.mock.calls[0]?.[0];
    expect(row).toEqual(
      expect.objectContaining({
        usageMode: "estimated",
        source: "context-compiler",
      }),
    );
    expect(row.promptTokens).toBeGreaterThan(0);
    expect(row.completionTokens).toBeGreaterThan(0);
  });

  test("records usage without returning a persistence promise", () => {
    const result = recordLlmUsage({
      provider: "local-llm",
      model: "gemma-4-e4b-it",
      promptMessages: [{ role: "user", content: "background logging" }],
      completionText: "done",
      source: "find-candidate",
    });

    expect(result).toBeUndefined();
    expect(db.insert).toHaveBeenCalledWith(llmUsageLogs);
    expect(valuesMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        usageMode: "estimated",
        source: "find-candidate",
      }),
    );
  });
});
