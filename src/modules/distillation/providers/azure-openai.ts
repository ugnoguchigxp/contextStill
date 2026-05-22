import { groupedConfig } from "../../../config.js";
import type { DistillationChatRequest, DistillationChatResponse } from "../types.js";
import { parseOpenAiStyleResponse, withRequestTimeout } from "./helpers.js";

function azureHeaders(): HeadersInit {
  return {
    "api-key": groupedConfig.azureOpenAi.apiKey,
    "content-type": "application/json",
  };
}

function buildAzureOpenAiUrl(): string {
  const path = `${groupedConfig.azureOpenAi.apiPath.replace(/\/+$/, "")}/${encodeURIComponent(
    groupedConfig.azureOpenAi.model,
  )}/chat/completions?api-version=${encodeURIComponent(groupedConfig.azureOpenAi.apiVersion)}`;
  return new URL(path, groupedConfig.azureOpenAi.apiBaseUrl).toString();
}

export async function callAzureOpenAiChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(
    groupedConfig.distillation.timeoutMs,
    async (signal) => {
      const response = await fetch(buildAzureOpenAiUrl(), {
        method: "POST",
        headers: azureHeaders(),
        body: JSON.stringify({
          messages: request.messages,
          temperature: 0,
          max_completion_tokens: request.maxTokens,
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools,
                tool_choice: request.toolChoice ?? "auto",
              }
            : {
                tool_choice: request.toolChoice ?? "none",
              }),
        }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Azure OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      return parseOpenAiStyleResponse(await response.json());
    },
    request.signal,
  );
}
