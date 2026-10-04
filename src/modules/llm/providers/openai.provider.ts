import { groupedConfig } from "../../../config.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";
import { LlmProviderHttpError, parseRetryAfterSeconds } from "../provider-http-error.js";
import { normalizeLlmUsage } from "../usage-normalizer.js";

type OpenAiResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
};

type OpenAiProviderOptions = {
  timeoutMs?: number;
  modelConfig?: { apiBaseUrl: string; apiKey: string; model: string };
  probe?: boolean;
};

async function parseResponse(response: Response, probe = false): Promise<LlmChatResponse> {
  const payload = (await response.json()) as OpenAiResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (
    typeof content !== "string" ||
    (!probe && !content.trim()) ||
    (probe && !["stop", "length"].includes(payload.choices?.[0]?.finish_reason ?? ""))
  ) {
    throw new Error("OpenAI returned empty response");
  }
  const usage = payload.usage
    ? normalizeLlmUsage({
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
        reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens,
      })
    : undefined;
  return {
    content,
    finishReason: payload.choices?.[0]?.finish_reason,
    usage,
  };
}

export function createOpenAiProvider(options: OpenAiProviderOptions = {}): LlmProvider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const config = options.modelConfig ?? groupedConfig.openAi;
  const isConfigured = () =>
    Boolean(config.apiKey.trim() && config.apiBaseUrl.trim() && config.model.trim());

  return {
    name: "openai",
    isConfigured,
    async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
      if (!isConfigured()) {
        throw new Error("OpenAI is not configured");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(`${config.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          redirect: "error",
          body: JSON.stringify({
            model: request.model?.trim() || config.model,
            messages: request.messages,
            temperature: request.temperature ?? 0,
            max_completion_tokens: request.maxTokens,
            ...(request.responseFormat === "json"
              ? { response_format: { type: "json_object" as const } }
              : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new LlmProviderHttpError({
            provider: "openai",
            status: response.status,
            retryAfterSeconds: parseRetryAfterSeconds(response.headers),
            requestId: response.headers.get("x-request-id") || undefined,
            message: `OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`,
          });
        }

        return parseResponse(response, options.probe);
      } finally {
        clearTimeout(timer);
      }
    },
    async healthCheck(): Promise<LlmHealthStatus> {
      const result: LlmHealthStatus = {
        provider: "openai",
        configured: isConfigured(),
        reachable: false,
        model: config.model,
        endpoint: config.apiBaseUrl,
      };

      if (!result.configured) {
        return { ...result, error: "OpenAI is not configured" };
      }

      try {
        const ping = await this.chat({
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 1,
          temperature: 0,
        });
        return {
          ...result,
          reachable: Boolean(ping.content.trim()),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("HTTP 4")) {
          return {
            ...result,
            reachable: true,
          };
        }
        return {
          ...result,
          error: message,
        };
      }
    },
  };
}
