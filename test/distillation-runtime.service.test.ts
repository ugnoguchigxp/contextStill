import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  resolveDistillationModel,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";
import { recordLlmUsage } from "../src/modules/llm/llm-usage-logger.js";

vi.mock("../src/modules/llm/llm-usage-logger.js", () => ({
  recordLlmUsage: vi.fn(),
}));

const originalConfig = {
  distillationProvider: groupedConfig.distillation.provider,
  distillationTimeoutMs: groupedConfig.distillation.timeoutMs,
  localLlmApiBaseUrl: groupedConfig.localLlm.apiBaseUrl,
  localLlmApiKey: groupedConfig.localLlm.apiKey,
  localLlmModel: groupedConfig.localLlm.model,
  azureOpenAiApiKey: groupedConfig.azureOpenAi.apiKey,
  azureOpenAiApiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
  azureOpenAiApiPath: groupedConfig.azureOpenAi.apiPath,
  azureOpenAiApiVersion: groupedConfig.azureOpenAi.apiVersion,
  azureOpenAiModel: groupedConfig.azureOpenAi.model,
  bedrockRegion: groupedConfig.bedrock.region,
  bedrockModel: groupedConfig.bedrock.model,
};

describe("Distillation Runtime Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();

    groupedConfig.distillation.provider = "local-llm";
    groupedConfig.distillation.timeoutMs = 300_000;
    groupedConfig.localLlm.apiBaseUrl = "http://llm";
    groupedConfig.localLlm.apiKey = "test-key";
    groupedConfig.localLlm.model = "mock-local-model";

    groupedConfig.azureOpenAi.apiKey = "";
    groupedConfig.azureOpenAi.apiBaseUrl = "";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.apiVersion = "2025-04-01-preview";
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

  test("throws error if content is missing and no tools", async () => {
    const chatClient = vi.fn().mockResolvedValue({
      content: null,
      toolCalls: [],
    });

    await expect(
      runDistillationCompletion({ model: "test", messages: [], maxTokens: 100 }, { chatClient }),
    ).rejects.toThrow("distillation response did not include assistant content");
  });

  test("reprompts empty-string content so caller receives parseable JSON", async () => {
    const chatClient = vi
      .fn()
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [],
      })
      .mockResolvedValueOnce({
        content: '{"candidates":[]}',
        toolCalls: [],
      });

    const result = await runDistillationCompletion(
      { model: "test", messages: [], maxTokens: 100 },
      { chatClient },
    );
    expect(result.content).toBe('{"candidates":[]}');
    expect(chatClient).toHaveBeenCalledTimes(2);
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "local-llm",
        model: "m1",
        promptMessages: [],
        completionText: "Fetched content",
        source: "distillation",
      }),
    );
  });

  test("callLocalLlmChat forwards required tool choice", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "Fetched content", tool_calls: [] } }],
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await runDistillationCompletion(
      {
        model: "m1",
        messages: [],
        maxTokens: 50,
      },
      { requireToolCall: true },
    );

    const body = JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body));
    expect(body.tool_choice).toBe("required");
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
  afterAll(() => {
    groupedConfig.distillation.provider = originalConfig.distillationProvider;
    groupedConfig.distillation.timeoutMs = originalConfig.distillationTimeoutMs;
    groupedConfig.localLlm.apiBaseUrl = originalConfig.localLlmApiBaseUrl;
    groupedConfig.localLlm.apiKey = originalConfig.localLlmApiKey;
    groupedConfig.localLlm.model = originalConfig.localLlmModel;
    groupedConfig.azureOpenAi.apiKey = originalConfig.azureOpenAiApiKey;
    groupedConfig.azureOpenAi.apiBaseUrl = originalConfig.azureOpenAiApiBaseUrl;
    groupedConfig.azureOpenAi.apiPath = originalConfig.azureOpenAiApiPath;
    groupedConfig.azureOpenAi.apiVersion = originalConfig.azureOpenAiApiVersion;
    groupedConfig.azureOpenAi.model = originalConfig.azureOpenAiModel;
    groupedConfig.bedrock.region = originalConfig.bedrockRegion;
    groupedConfig.bedrock.model = originalConfig.bedrockModel;
    vi.unstubAllGlobals();
  });
});
