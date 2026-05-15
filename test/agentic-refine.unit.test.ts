import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  agenticRefine,
  checkAzureOpenAiHealth,
  type AgenticCandidate,
} from "../src/modules/context-compiler/agentic-refine.service.js";
import { config } from "../src/config.js";
import type { CompileInput } from "../src/shared/schemas/compile.schema.js";

const mockFetch = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
global.fetch = mockFetch as any;

describe("agentic-refine.service", () => {
  const originalConfig = {
    agenticCompileEnabled: config.agenticCompileEnabled,
    azureOpenAiApiKey: config.azureOpenAiApiKey,
    azureOpenAiApiBaseUrl: config.azureOpenAiApiBaseUrl,
    azureOpenAiModel: config.azureOpenAiModel,
    azureOpenAiApiVersion: config.azureOpenAiApiVersion,
  };

  beforeEach(() => {
    mockFetch.mockReset();
    config.agenticCompileEnabled = true;
    config.azureOpenAiApiKey = "test-key";
    config.azureOpenAiApiBaseUrl = "https://test.openai.azure.com";
    config.azureOpenAiModel = "test-model";
    config.azureOpenAiApiVersion = "2024-04-01-preview";
  });

  afterEach(() => {
    config.agenticCompileEnabled = originalConfig.agenticCompileEnabled;
    config.azureOpenAiApiKey = originalConfig.azureOpenAiApiKey;
    config.azureOpenAiApiBaseUrl = originalConfig.azureOpenAiApiBaseUrl;
    config.azureOpenAiModel = originalConfig.azureOpenAiModel;
    config.azureOpenAiApiVersion = originalConfig.azureOpenAiApiVersion;
  });

  const candidates: AgenticCandidate[] = [
    {
      id: "1",
      type: "rule",
      status: "active",
      title: "Rule 1",
      content: "Content 1",
      score: 0.9,
      sourceRefs: [],
    },
    {
      id: "2",
      type: "procedure",
      status: "active",
      title: "Proc 1",
      content: "Content 2",
      score: 0.8,
      sourceRefs: [],
    },
    {
      id: "3",
      type: "rule",
      status: "draft",
      title: "Rule 3",
      content: "Content 3",
      score: 0.7,
      sourceRefs: [],
    },
  ];

  const input: CompileInput = {
    goal: "Test goal",
    intent: "edit",
    files: ["test.ts"],
    includeDraft: false,
  };

  describe("agenticRefine", () => {
    it("returns candidates directly if agenticCompileEnabled is false", async () => {
      config.agenticCompileEnabled = false;
      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.items).toEqual(candidates);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns candidates directly if not fully configured", async () => {
      config.azureOpenAiApiKey = "";
      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toBeUndefined();
      expect(result.items).toEqual(candidates);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns empty array if candidates are empty", async () => {
      const result = await agenticRefine([], input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.items).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("calls Azure OpenAI and reorders candidates based on JSON response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["2", "1"],
                  reasoning: "Rule 3 is draft, Proc 1 is most relevant",
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.reasoning).toBe("Rule 3 is draft, Proc 1 is most relevant");
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("2");
      expect(result.items[1].id).toBe("1");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe(
        "https://test.openai.azure.com/openai/deployments/test-model/chat/completions?api-version=2024-04-01-preview",
      );
    });

    it("handles HTTP error gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toContain("AGENTIC_REFINE_FAILED");
      expect(result.error).toContain("HTTP 401");
      expect(result.items).toEqual(candidates);
    });

    it("handles markdown code block JSON response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Here is the result:\n```json\n{\n  "selectedIds": ["3"]\n}\n```',
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("3");
    });

    it("filters out invalid IDs returned by LLM", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: ["1", "unknown-id", "2"],
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("1");
      expect(result.items[1].id).toBe("2");
    });

    it("falls back when LLM selects nothing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  selectedIds: [],
                  reasoning: "該当なし",
                }),
              },
            },
          ],
        }),
      });

      const result = await agenticRefine(candidates, input, "task_context");
      expect(result.agenticUsed).toBe(false);
      expect(result.error).toBe("AGENTIC_EMPTY_SELECTION");
      expect(result.items).toEqual(candidates);
    });
  });

  describe("checkAzureOpenAiHealth", () => {
    it("returns configured=false if API key is missing", async () => {
      config.azureOpenAiApiKey = "";
      const result = await checkAzureOpenAiHealth();
      expect(result.configured).toBe(false);
      expect(result.reachable).toBe(false);
      expect(result.error).toBe("Azure OpenAI is not configured");
    });

    it("returns reachable=true if ping succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 200,
      });

      const result = await checkAzureOpenAiHealth();
      expect(result.configured).toBe(true);
      expect(result.reachable).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns reachable=true even for 400 errors (auth/payload errors)", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 401,
      });

      const result = await checkAzureOpenAiHealth();
      expect(result.configured).toBe(true);
      expect(result.reachable).toBe(true); // endpoint is reachable, just unauthorized
      expect(result.error).toBeUndefined();
    });

    it("returns reachable=false for 500 errors", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 502,
      });

      const result = await checkAzureOpenAiHealth();
      expect(result.configured).toBe(true);
      expect(result.reachable).toBe(false);
      expect(result.error).toBe("HTTP 502");
    });

    it("returns reachable=false for network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await checkAzureOpenAiHealth();
      expect(result.configured).toBe(true);
      expect(result.reachable).toBe(false);
      expect(result.error).toBe("Network error");
    });
  });
});
