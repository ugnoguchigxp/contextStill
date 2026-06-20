import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { createLocalLlmProvider } from "../src/modules/llm/providers/local-llm.provider.js";

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    localLlm: {
      apiBaseUrl: "http://127.0.0.1:44448",
      apiKey: "",
      model: "gemma-4-e4b-it",
      models: [],
    },
  },
}));

describe("local-llm provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.apiKey = "";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.localLlm.models = [];
  });

  test("healthCheck uses the lightweight health endpoint when available", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        ready: true,
        loaded: true,
        modelId: "gemma-4-e4b-it",
      }),
    } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status).toMatchObject({
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "gemma-4-e4b-it",
      endpoint: "http://127.0.0.1:44448",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44448/health");
  });

  test("healthCheck can target a configured local model", async () => {
    groupedConfig.localLlm.models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      },
    ];
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        ready: true,
        loaded: true,
        modelId: "qwen-3.6-14b-it",
      }),
    } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck({
      model: "qwen-3.6-14b-it",
    });

    expect(status).toMatchObject({
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "qwen-3.6-14b-it",
      endpoint: "http://127.0.0.1:44449",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44449/health");
  });

  test("healthCheck reports not-ready health payloads without waiting for chat", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "loading",
        ready: false,
        loaded: false,
        preloadError: "model is loading",
      }),
    } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.reachable).toBe(false);
    expect(status.error).toContain("model is loading");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("healthCheck falls back to chat when the health endpoint is not available", async () => {
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "not found",
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.reachable).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toBe("http://127.0.0.1:44448/v1/chat/completions");
    expect(JSON.parse(spy.mock.calls[1]?.[1]?.body as string).max_tokens).toBe(8);
  });

  test("chat does not append a second v1 segment when base URL already includes v1", async () => {
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448/v1";
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const response = await createLocalLlmProvider({ timeoutMs: 1000 }).chat({
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      temperature: 0,
    });

    expect(response.content).toBe("pong");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44448/v1/chat/completions");
  });

  test("uses providerOptions.modelConfig when request model is missing", async () => {
    const provider = createLocalLlmProvider({
      modelConfig: {
        apiBaseUrl: "http://options-url",
        model: "options-model",
      },
    });

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const response = await provider.chat({
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 100,
    });

    expect(response.content).toBe("pong");
    expect(spy.mock.calls[0]?.[0]).toBe("http://options-url/v1/chat/completions");
  });

  test("healthCheck handles AbortError correctly", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    vi.spyOn(global, "fetch").mockRejectedValue(abortError);

    const provider = createLocalLlmProvider({ timeoutMs: 1000 });
    const status = await provider.healthCheck();

    expect(status.reachable).toBe(false);
    expect(status.error).toBe("The operation was aborted.");
  });

  test("healthCheck handles fallback chat failure", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response)
      .mockRejectedValueOnce(new Error("Chat failed"));

    const provider = createLocalLlmProvider({ timeoutMs: 1000 });
    const status = await provider.healthCheck();

    expect(status.reachable).toBe(false);
    expect(status.error).toBe("Chat failed");
  });
});
