import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { composeContextResponse } from "../src/modules/context-compiler/context-response-composer.service.js";
import { getAgenticLlmProviders } from "../src/modules/llm/agentic-llm.service.js";

vi.mock("../src/modules/llm/agentic-llm.service.js");

describe("context response composer", () => {
  const originalEnabled = groupedConfig.agenticCompile.enabled;
  const originalProviderSetting = groupedConfig.agenticCompile.provider;

  const mockProvider = {
    name: "mock-llm",
    isConfigured: vi.fn().mockReturnValue(true),
    chat: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.agenticCompile.provider = "mock-llm" as any;
    vi.mocked(getAgenticLlmProviders).mockReturnValue([mockProvider] as any);
  });

  afterAll(() => {
    groupedConfig.agenticCompile.enabled = originalEnabled;
    groupedConfig.agenticCompile.provider = originalProviderSetting;
  });

  test("returns No Content when no selected knowledge exists", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "HonoでAPIルートを追加する",
      },
      retrievalMode: "task_context",
      rules: [],
      procedures: [],
    });

    expect(result.markdown).toBe("No Content");
    expect(result.agenticUsed).toBe(false);
    expect(result.usedKnowledge).toEqual([]);
  });

  test("builds natural-language implementation context when knowledge exists", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "Hono APIでcompile runs一覧にstatusフィルタを追加し、React一覧へ連動させる",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "HonoではzValidatorを使う",
          content: "HonoではzValidatorでqueryを検証する。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [
        {
          id: "knowledge:p1",
          itemKind: "procedure",
          itemId: "p1",
          section: "procedures",
          title: "一覧フィルタ追加手順",
          content:
            "Workflow:\n1. API query schemaにstatusを追加する。\n2. 一覧UIでstatus選択を反映する。\nVerification:\n- status変更で一覧結果が一致する。\nAvoid:\n- バリデーションなしでqueryを受け取らない。",
          score: 0.8,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.markdown).toContain("## 実装手順");
    expect(result.markdown).toContain("## 検証観点");
    expect(result.markdown).not.toContain("## Rules");
    expect(result.markdown).not.toContain("## Procedures");
    expect(result.usedKnowledge.length).toBeGreaterThan(0);
    expect(result.usedKnowledge[0]?.id).toBe("r1");
  });

  test("uses agentic LLM composer successfully when enabled and output is valid JSON", async () => {
    groupedConfig.agenticCompile.enabled = true;

    // Successful JSON composition response aligned with goal (contains "Hono" / "API")
    const mockJson = {
      markdown: "## 実装フォーカス\n- Hono APIにフィルタを追加します。",
      usedKnowledge: [
        {
          id: "r1",
          confidence: 0.95,
          evidence: "Hono requirement matches",
          outputSection: "focus",
          reason: "crucial rule",
        },
      ],
    };
    mockProvider.chat.mockResolvedValue({
      content: JSON.stringify(mockJson),
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIにフィルタを追加する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "HonoではzValidatorを使う",
          content: "HonoではzValidatorでqueryを検証する。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono APIにフィルタを追加します。");
    expect(result.usedKnowledge).toHaveLength(1);
    expect(result.usedKnowledge[0]).toEqual(
      expect.objectContaining({
        id: "r1",
        confidence: 0.95,
        evidence: "Hono requirement matches",
      }),
    );
    expect(mockProvider.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        responseFormat: "json",
        maxTokens: expect.any(Number),
      }),
    );
    const chatRequest = mockProvider.chat.mock.calls[0]?.[0];
    const systemPrompt = chatRequest?.messages?.[0]?.content ?? "";
    const markdownTargetTokens = Number(systemPrompt.match(/本文は (\d+) トークン/u)?.[1]);
    expect(systemPrompt).toContain("JSON は必ず完結");
    expect(markdownTargetTokens).toBeGreaterThan(0);
    expect(chatRequest?.maxTokens).toBeGreaterThan(markdownTargetTokens);
  });

  test("falls back to plain markdown text when LLM outputs non-JSON content", async () => {
    groupedConfig.agenticCompile.enabled = true;

    // Output is plain Markdown text (not JSON) but goal-aligned
    mockProvider.chat.mockResolvedValue({
      content: "## 実装フォーカス\n- Hono APIを検証します。",
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono APIを検証します。");
    expect(result.usedKnowledge).toEqual([]);
  });

  test("falls back to local template when LLM returns truncated JSON", async () => {
    groupedConfig.agenticCompile.enabled = true;

    mockProvider.chat.mockResolvedValue({
      content:
        '{"markdown":"## 実装フォーカス\\n- Hono APIを検証します。","usedKnowledge":[{"id":"r1"',
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.markdown).not.toContain('{"markdown"');
    expect(result.error).toBe("COMPOSER_JSON_PARSE_FAILED");
  });

  test("uses valid JSON even when LLM reports token limit finish reason", async () => {
    groupedConfig.agenticCompile.enabled = true;

    mockProvider.chat.mockResolvedValue({
      content: JSON.stringify({
        markdown: "## 実装フォーカス\n- Hono APIを検証します。",
        usedKnowledge: [],
      }),
      finishReason: "length",
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono APIを検証します。");
    expect(result.error).toBeUndefined();
  });

  test("returns No Content if agentic output is not aligned with goal", async () => {
    groupedConfig.agenticCompile.enabled = true;

    // Output does not contain Hono / API keywords from goal
    mockProvider.chat.mockResolvedValue({
      content: "## 実装フォーカス\n- Completely unrelated text here.",
    });

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.markdown).toBe("No Content");
    expect(result.agenticUsed).toBe(true);
  });

  test("falls back to local template when all LLM providers throw error", async () => {
    groupedConfig.agenticCompile.enabled = true;

    mockProvider.chat.mockRejectedValue(new Error("API quota exceeded"));

    const result = await composeContextResponse({
      input: {
        goal: "Hono APIを検証する",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono requirement",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    // Should fall back to template composition
    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.error).toContain("CONTEXT_RESPONSE_COMPOSE_FAILED: API quota exceeded");
  });

  test("handles multiple providers fallback on error", async () => {
    groupedConfig.agenticCompile.enabled = true;

    const failingProvider = {
      name: "failing-llm",
      isConfigured: vi.fn().mockReturnValue(true),
      chat: vi.fn().mockRejectedValue(new Error("Timeout")),
    };

    const succeedingProvider = {
      name: "succeeding-llm",
      isConfigured: vi.fn().mockReturnValue(true),
      chat: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          markdown: "## 実装フォーカス\n- Hono API composed successfully",
          usedKnowledge: [],
        }),
      }),
    };

    vi.mocked(getAgenticLlmProviders).mockReturnValue([failingProvider, succeedingProvider] as any);

    const result = await composeContextResponse({
      input: {
        goal: "Hono API",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(true);
    expect(result.markdown).toBe("## 実装フォーカス\n- Hono API composed successfully");
  });

  test("skips unconfigured LLM providers", async () => {
    groupedConfig.agenticCompile.enabled = true;

    const unconfiguredProvider = {
      name: "unconfigured-llm",
      isConfigured: vi.fn().mockReturnValue(false),
      chat: vi.fn(),
    };

    vi.mocked(getAgenticLlmProviders).mockReturnValue([unconfiguredProvider] as any);

    const result = await composeContextResponse({
      input: {
        goal: "Hono API",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Hono",
          content: "Hono body",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [],
    });

    expect(result.agenticUsed).toBe(false); // Fell back to template
    expect(unconfiguredProvider.chat).not.toHaveBeenCalled();
  });
});
