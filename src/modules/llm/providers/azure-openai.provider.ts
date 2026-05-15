import { groupedConfig } from "../../../config.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";

type AzureOpenAiResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
};

type AzureOpenAiProviderOptions = {
  timeoutMs?: number;
};

function isConfigured(): boolean {
  return Boolean(
    groupedConfig.azureOpenAi.apiKey.trim() &&
      groupedConfig.azureOpenAi.apiBaseUrl.trim() &&
      groupedConfig.azureOpenAi.model.trim(),
  );
}

function buildAzureOpenAiUrl(): string {
  const { apiBaseUrl, apiPath, model, apiVersion } = groupedConfig.azureOpenAi;
  const path = `${apiPath.replace(/\/+$/, "")}/${encodeURIComponent(
    model,
  )}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  return new URL(path, apiBaseUrl).toString();
}

function headers(): HeadersInit {
  return {
    "api-key": groupedConfig.azureOpenAi.apiKey,
    "content-type": "application/json",
  };
}

async function parseResponse(response: Response): Promise<LlmChatResponse> {
  const payload = (await response.json()) as AzureOpenAiResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Azure OpenAI returned empty response");
  }
  return {
    content,
    finishReason: payload.choices?.[0]?.finish_reason,
  };
}

export function createAzureOpenAiProvider(options: AzureOpenAiProviderOptions = {}): LlmProvider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);

  return {
    name: "azure-openai",
    isConfigured,
    async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
      if (!isConfigured()) {
        throw new Error("Azure OpenAI is not configured");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(buildAzureOpenAiUrl(), {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
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
          throw new Error(`Azure OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`);
        }

        return parseResponse(response);
      } finally {
        clearTimeout(timer);
      }
    },
    async healthCheck(): Promise<LlmHealthStatus> {
      const result: LlmHealthStatus = {
        provider: "azure-openai",
        configured: isConfigured(),
        reachable: false,
        model: groupedConfig.azureOpenAi.model,
        endpoint: groupedConfig.azureOpenAi.apiBaseUrl,
      };

      if (!result.configured) {
        return { ...result, error: "Azure OpenAI is not configured" };
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
