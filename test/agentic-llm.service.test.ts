import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  checkAgenticLlmHealth,
  checkDistillationLlmHealth,
  getAgenticLlmProviders,
} from "../src/modules/llm/agentic-llm.service.js";
import { recordLlmUsage } from "../src/modules/llm/llm-usage-logger.js";
import { createAzureOpenAiProvider } from "../src/modules/llm/providers/azure-openai.provider.js";
import { createBedrockProvider } from "../src/modules/llm/providers/bedrock.provider.js";
import { createLocalLlmProvider } from "../src/modules/llm/providers/local-llm.provider.js";

vi.mock("../src/modules/llm/llm-usage-logger.js", () => ({
  recordLlmUsage: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/azure-openai.provider.js", () => ({
  createAzureOpenAiProvider: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/bedrock.provider.js", () => ({
  createBedrockProvider: vi.fn(),
}));
vi.mock("../src/modules/llm/providers/local-llm.provider.js", () => ({
  createLocalLlmProvider: vi.fn(),
}));

describe("agentic-llm service tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockProvider = (name: string, configured: boolean, reachable: boolean, error?: string) => {
    return {
      name,
      isConfigured: vi.fn(() => configured),
      chat: vi.fn().mockResolvedValue({ content: "ok" }),
      healthCheck: vi.fn().mockResolvedValue({
        provider: name,
        configured,
        reachable,
        error: error || (configured && !reachable ? "unreachable" : null),
      }),
    };
  };

  test("getAgenticLlmProviders resolves fallback providers list", () => {
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(
      mockProvider("azure-openai", true, true) as any,
    );
    vi.mocked(createBedrockProvider).mockReturnValue(mockProvider("bedrock", true, true) as any);
    vi.mocked(createLocalLlmProvider).mockReturnValue(mockProvider("local-llm", true, true) as any);

    const providers = getAgenticLlmProviders("auto", 2000);
    expect(providers).toHaveLength(3);
    expect(providers[0]?.name).toBe("azure-openai");
    expect(providers[1]?.name).toBe("bedrock");
    expect(providers[2]?.name).toBe("local-llm");

    // timeout parameter should be passed down
    expect(createAzureOpenAiProvider).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });

  test("getAgenticLlmProviders can wrap chat calls with usage logging", async () => {
    const usage = {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      reasoningTokens: 5,
    };
    const azure = mockProvider("azure-openai", true, true);
    azure.chat.mockResolvedValue({ content: "ok", usage });
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

    const [provider] = getAgenticLlmProviders("azure-openai", 2000, "context-compiler");
    await provider?.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    });

    expect(azure.chat).toHaveBeenCalledTimes(1);
    expect(recordLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "azure-openai",
        model: expect.any(String),
        usage,
        promptMessages: [{ role: "user", content: "hi" }],
        completionText: "ok",
        source: "context-compiler",
      }),
    );
  });

  test("wrapped chat does not wait for usage persistence", async () => {
    const azure = mockProvider("azure-openai", true, true);
    azure.chat.mockResolvedValue({ content: "ok" });
    vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

    vi.mocked(recordLlmUsage).mockReturnValueOnce(new Promise<void>(() => undefined) as never);

    const [provider] = getAgenticLlmProviders("azure-openai", 2000, "context-compiler");
    const result = await provider?.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 10,
    });

    expect(result?.content).toBe("ok");
    expect(recordLlmUsage).toHaveBeenCalledTimes(1);
  });

  describe("checkAgenticLlmHealth fallback logic", () => {
    test("returns first configured and reachable provider", async () => {
      // First is unconfigured, second is configured & reachable, third is unreachable
      const first = mockProvider("azure-openai", false, false);
      const second = mockProvider("bedrock", true, true);
      const third = mockProvider("local-llm", true, false);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(first as any);
      vi.mocked(createBedrockProvider).mockReturnValue(second as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(third as any);

      const health = await checkAgenticLlmHealth("auto");

      expect(health.reachable).toBe(true);
      expect(health.selectedProvider).toBe("bedrock");
      expect(health.providerSetting).toBe("auto");
      expect(first.healthCheck).toHaveBeenCalled();
      expect(second.healthCheck).toHaveBeenCalled();
      expect(third.healthCheck).not.toHaveBeenCalled(); // short-circuited
    });

    test("stops immediately if non-auto setting provider is unreachable", async () => {
      const azure = mockProvider("azure-openai", true, false); // configured but unreachable

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);

      const health = await checkAgenticLlmHealth("azure-openai");

      expect(health.reachable).toBe(false);
      expect(health.selectedProvider).toBe("azure-openai");
      expect(health.providerSetting).toBe("azure-openai");
      expect(azure.healthCheck).toHaveBeenCalled();
    });

    test("returns first configured but unreachable provider if all configured are unreachable in auto mode", async () => {
      // First is unconfigured, second and third are configured but unreachable
      const first = mockProvider("azure-openai", false, false);
      const second = mockProvider("bedrock", true, false);
      const third = mockProvider("local-llm", true, false);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(first as any);
      vi.mocked(createBedrockProvider).mockReturnValue(second as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(third as any);

      const health = await checkAgenticLlmHealth("auto");

      expect(health.reachable).toBe(false);
      expect(health.selectedProvider).toBe("bedrock"); // first configured
      expect(second.healthCheck).toHaveBeenCalled();
      expect(third.healthCheck).toHaveBeenCalled(); // checks all to find a reachable one
    });

    test("returns error if no providers are configured in auto mode", async () => {
      const first = mockProvider("azure-openai", false, false);
      const second = mockProvider("bedrock", false, false);
      const third = mockProvider("local-llm", false, false);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(first as any);
      vi.mocked(createBedrockProvider).mockReturnValue(second as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(third as any);

      const health = await checkAgenticLlmHealth("auto");

      expect(health.configured).toBe(false);
      expect(health.reachable).toBe(false);
      expect(health.error).toBe("No configured provider in fallback chain");
      expect(first.healthCheck).toHaveBeenCalledTimes(2); // one in loop, one for fallback first status
    });
  });

  describe("checkDistillationLlmHealth tests", () => {
    test("uses distillation fallback order (local-llm first)", async () => {
      const azure = mockProvider("azure-openai", true, true);
      const bedrock = mockProvider("bedrock", true, true);
      const local = mockProvider("local-llm", true, true);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);
      vi.mocked(createBedrockProvider).mockReturnValue(bedrock as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

      const health = await checkDistillationLlmHealth("auto");

      expect(health.selectedProvider).toBe("local-llm"); // Local LLM is first for distillation fallback
      expect(local.healthCheck).toHaveBeenCalled();
      expect(azure.healthCheck).not.toHaveBeenCalled();
    });

    test("returns error if distillation fallback has no configured providers", async () => {
      const azure = mockProvider("azure-openai", false, false);
      const bedrock = mockProvider("bedrock", false, false);
      const local = mockProvider("local-llm", false, false);

      vi.mocked(createAzureOpenAiProvider).mockReturnValue(azure as any);
      vi.mocked(createBedrockProvider).mockReturnValue(bedrock as any);
      vi.mocked(createLocalLlmProvider).mockReturnValue(local as any);

      const health = await checkDistillationLlmHealth("auto");

      expect(health.configured).toBe(false);
      expect(health.error).toBe("No configured provider in distillation fallback chain");
    });
  });
});
