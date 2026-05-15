import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  resolveDistillationModel,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";
import { groupedConfig } from "../src/config.js";

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    distillationProvider: "local-llm",
    localLlmApiBaseUrl: "http://llm",
    localLlmApiKey: "test-key",
    localLlmModel: "mock-local-model",
    azureOpenAiApiKey: "",
    azureOpenAiApiBaseUrl: "",
    azureOpenAiApiPath: "/openai/deployments",
    azureOpenAiApiVersion: "2025-04-01-preview",
    azureOpenAiModel: "",
    bedrockRegion: "",
    bedrockModel: "",
    bedrockProfile: "",
    vibeDistillationTimeoutMs: 1000,
    distillationToolMaxRounds: 5,
  },
}));

describe("Distillation Runtime Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.distillation.provider = "local-llm";
    groupedConfig.localLlm.apiBaseUrl = "http://llm";
    groupedConfig.localLlm.model = "mock-local-model";
    groupedConfig.azureOpenAi.apiKey = "";
    groupedConfig.azureOpenAi.apiBaseUrl = "";
    groupedConfig.azureOpenAi.model = "";
    groupedConfig.bedrock.region = "";
    groupedConfig.bedrock.model = "";
  });

  test("runDistillationCompletion returns content immediately if no tools", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: "Hello result",
      toolCalls: [],
    });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient },
    );

    expect(result.content).toBe("Hello result");
    expect(chatClient).toHaveBeenCalledTimes(1);
  });

  test("runDistillationCompletion loops for tool calls", async () => {
    const chatClient = vi
      .fn()
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [{ id: "c1", function: { name: "tool", arguments: "{}" } }],
      })
      .mockResolvedValueOnce({
        content: "Final answer",
        toolCalls: [],
      });

    const toolExecutor = vi.fn().mockResolvedValue({
      name: "tool",
      content: "tool result",
      ok: true,
    });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient, toolExecutor },
    );

    expect(result.content).toBe("Final answer");
    expect(chatClient).toHaveBeenCalledTimes(2);
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(result.toolEvents).toHaveLength(1);
  });

  test("throws error when max rounds exceeded", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: null,
      toolCalls: [{ id: "c1", function: { name: "tool", arguments: "{}" } }],
    });

    await expect(
      runDistillationCompletion(
        { model: "test", messages: [], maxTokens: 100 },
        { chatClient, maxToolRounds: 1 },
      ),
    ).rejects.toThrow("distillation tool loop exceeded max rounds");
  });

  test("throws error if no content and no tools", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: "",
      toolCalls: [],
    });

    await expect(
      runDistillationCompletion({ model: "test", messages: [], maxTokens: 100 }, { chatClient }),
    ).rejects.toThrow("distillation response did not include assistant content");
  });

  test("callLocalLlmChat performs fetch and parses response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Fetched content", tool_calls: [] } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const result = await callLocalLlmCompletionForDistillation({
      model: "m1",
      messages: [],
      maxTokens: 50,
    });

    expect(result.content).toBe("Fetched content");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/chat/completions"),
      expect.any(Object),
    );
  });

  test("callLocalLlmChat handles HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Error"),
      }),
    );

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    await expect(
      callLocalLlmCompletionForDistillation({ model: "m1", messages: [], maxTokens: 50 }),
    ).rejects.toThrow("local-llm HTTP 500");
  });

  test("callLocalLlmChat handles complex/malformed tool calls", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { function: { name: " valid ", arguments: { a: 1 } } },
                    { function: { name: "no-args" } },
                    {
                      id: "c1",
                      type: "function",
                      function: { name: "with-id", arguments: '{"b":2}' },
                    },
                    null,
                    { function: { name: "" } },
                  ],
                },
              },
            ],
          }),
      })
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "Done", tool_calls: [] } }],
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { callLocalLlmCompletionForDistillation } = await import(
      "../src/modules/distillation/distillation-runtime.service.js"
    );
    const result = await callLocalLlmCompletionForDistillation({
      model: "m1",
      messages: [],
      maxTokens: 50,
    });

    // valid, no-args, with-id should remain (3 total)
    expect(result.messages.find((m) => m.role === "assistant")?.tool_calls).toHaveLength(3);
  });

  test("resolveDistillationModel uses selected provider model", () => {
    groupedConfig.distillation.provider = "azure-openai";
    groupedConfig.azureOpenAi.apiKey = "key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://example.openai.azure.com";
    groupedConfig.azureOpenAi.model = "gpt-5-4-mini";

    expect(resolveDistillationModel()).toBe("gpt-5-4-mini");
  });

  test("resolveDistillationModel auto picks first configured provider", () => {
    groupedConfig.distillation.provider = "auto";
    groupedConfig.localLlm.apiBaseUrl = "";
    groupedConfig.localLlm.model = "";
    groupedConfig.azureOpenAi.apiKey = "key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://example.openai.azure.com";
    groupedConfig.azureOpenAi.model = "gpt-5-4-mini";

    expect(resolveDistillationModel()).toBe("gpt-5-4-mini");
  });
});
