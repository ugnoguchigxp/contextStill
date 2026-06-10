import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { createOpenAiProvider } from "../src/modules/llm/providers/openai.provider.js";

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    openAi: {
      apiKey: "test-api-key",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    },
  },
}));

describe("openai provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    groupedConfig.openAi.apiKey = "test-api-key";
    groupedConfig.openAi.apiBaseUrl = "https://api.openai.com/v1";
    groupedConfig.openAi.model = "gpt-4o";
  });

  test("chat succeeds and normalizes usage", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: "Hello from OpenAI",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        completion_tokens_details: {
          reasoning_tokens: 5,
        },
      },
    };

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const provider = createOpenAiProvider();
    const result = await provider.chat({
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
      temperature: 0.7,
      responseFormat: "json",
    });

    expect(spy).toHaveBeenCalled();
    expect(result.content).toBe("Hello from OpenAI");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 5,
    });

    const fetchArgs = spy.mock.calls[0];
    expect(fetchArgs?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    const options = fetchArgs?.[1];
    expect(options?.method).toBe("POST");
    expect((options?.headers as any).Authorization).toBe("Bearer test-api-key");
    const body = JSON.parse(options?.body as string);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("chat fails when api key is not configured", async () => {
    groupedConfig.openAi.apiKey = " ";
    const provider = createOpenAiProvider();
    await expect(
      provider.chat({
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 100,
      }),
    ).rejects.toThrow("OpenAI is not configured");
  });

  test("chat throws LlmProviderHttpError on failure response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers({ "retry-after": "10", "x-request-id": "req-1" }),
      text: async () => "Bad Request Error details",
    } as unknown as Response);

    const provider = createOpenAiProvider();
    await expect(
      provider.chat({
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 100,
      }),
    ).rejects.toThrow("OpenAI HTTP 400: Bad Request Error details");
  });

  test("chat throws error when response choices is empty", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response);

    const provider = createOpenAiProvider();
    await expect(
      provider.chat({
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 100,
      }),
    ).rejects.toThrow("OpenAI returned empty response");
  });

  test("healthCheck succeeds", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const provider = createOpenAiProvider();
    const status = await provider.healthCheck();
    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.model).toBe("gpt-4o");
  });

  test("healthCheck returns false reachable when unconfigured", async () => {
    groupedConfig.openAi.apiKey = "";
    const provider = createOpenAiProvider();
    const status = await provider.healthCheck();
    expect(status.configured).toBe(false);
    expect(status.reachable).toBe(false);
    expect(status.error).toBe("OpenAI is not configured");
  });

  test("healthCheck handles HTTP 4xx errors as reachable", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => "HTTP 400 Bad Request (e.g. output limit)",
    } as unknown as Response);

    const provider = createOpenAiProvider();
    const status = await provider.healthCheck();
    expect(status.reachable).toBe(true);
  });

  test("healthCheck handles other errors as unreachable", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("Network Error"));

    const provider = createOpenAiProvider();
    const status = await provider.healthCheck();
    expect(status.reachable).toBe(false);
    expect(status.error).toBe("Network Error");
  });

  test("healthCheck handles non-Error errors as unreachable", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue("String Network Error");

    const provider = createOpenAiProvider();
    const status = await provider.healthCheck();
    expect(status.reachable).toBe(false);
    expect(status.error).toBe("String Network Error");
  });
});
