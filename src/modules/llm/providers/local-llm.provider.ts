import { groupedConfig } from "../../../config.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";
import { normalizeLlmUsage } from "../usage-normalizer.js";

type LocalLlmResponse = {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type LocalLlmHealthResponse = {
  status?: unknown;
  ready?: unknown;
  loaded?: unknown;
  modelId?: unknown;
  modelPath?: unknown;
  preloadError?: unknown;
};

type LocalLlmProviderOptions = {
  timeoutMs?: number;
};

function isConfigured(): boolean {
  return Boolean(groupedConfig.localLlm.apiBaseUrl.trim() && groupedConfig.localLlm.model.trim());
}

function headers(): HeadersInit {
  const result: HeadersInit = { "content-type": "application/json" };
  const apiKey = groupedConfig.localLlm.apiKey.trim();
  if (apiKey) {
    result.Authorization = `Bearer ${apiKey}`;
  }
  return result;
}

function healthUrl(): string {
  return `${groupedConfig.localLlm.apiBaseUrl.replace(/\/+$/, "")}/health`;
}

function chatUrl(): string {
  return `${groupedConfig.localLlm.apiBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
}

async function parseResponse(response: Response): Promise<LlmChatResponse> {
  const payload = (await response.json()) as LocalLlmResponse;
  const choice = payload.choices?.[0];
  const rawContent = choice?.message?.content;
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    throw new Error("local-llm response did not include assistant content");
  }
  const usage = payload.usage
    ? normalizeLlmUsage({
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
      })
    : undefined;
  return {
    content: rawContent,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    usage,
  };
}

export function createLocalLlmProvider(options: LocalLlmProviderOptions = {}): LlmProvider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);

  return {
    name: "local-llm",
    isConfigured,
    async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
      if (!isConfigured()) {
        throw new Error("local-llm is not configured");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(chatUrl(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            model: groupedConfig.localLlm.model,
            messages: request.messages,
            stream: false,
            temperature: request.temperature ?? 0,
            max_tokens: request.maxTokens,
            ...(request.responseFormat === "json"
              ? { response_format: { type: "json_object" as const } }
              : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`local-llm HTTP ${response.status}: ${body.slice(0, 500)}`);
        }

        return parseResponse(response);
      } finally {
        clearTimeout(timer);
      }
    },
    async healthCheck(): Promise<LlmHealthStatus> {
      const result: LlmHealthStatus = {
        provider: "local-llm",
        configured: isConfigured(),
        reachable: false,
        model: groupedConfig.localLlm.model,
        endpoint: groupedConfig.localLlm.apiBaseUrl,
      };

      if (!result.configured) {
        return { ...result, error: "local-llm is not configured" };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const health = await fetch(healthUrl(), {
          method: "GET",
          headers: headers(),
          signal: controller.signal,
        });
        if (health.ok) {
          const payload = (await health.json()) as LocalLlmHealthResponse;
          const ready = payload.ready === true || payload.status === "ok";
          const loaded = payload.loaded !== false;
          const model =
            typeof payload.modelId === "string" && payload.modelId.trim()
              ? payload.modelId
              : result.model;
          if (ready && loaded) {
            return {
              ...result,
              reachable: true,
              model,
            };
          }
          const preloadError =
            typeof payload.preloadError === "string" && payload.preloadError.trim()
              ? `: ${payload.preloadError}`
              : "";
          return {
            ...result,
            model,
            error: `local-llm health endpoint is not ready${preloadError}`,
          };
        }
      } catch (error) {
        if ((error as { name?: unknown })?.name === "AbortError") {
          return {
            ...result,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        clearTimeout(timer);
      }

      try {
        const ping = await this.chat({
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 8,
          temperature: 0,
        });
        return {
          ...result,
          reachable: Boolean(ping.content.trim()),
        };
      } catch (error) {
        return {
          ...result,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
