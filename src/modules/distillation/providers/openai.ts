import { groupedConfig } from "../../../config.js";
import type { DistillationChatRequest, DistillationChatResponse } from "../types.js";
import { parseOpenAiStyleResponse, withRequestTimeout } from "./helpers.js";

function openAiHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (groupedConfig.openAi.apiKey.trim()) {
    headers.Authorization = `Bearer ${groupedConfig.openAi.apiKey.trim()}`;
  }
  return headers;
}

function buildOpenAiUrl(): string {
  return `${groupedConfig.openAi.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export async function callOpenAiChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(
    request.timeoutMs ?? groupedConfig.distillation.timeoutMs,
    async (signal) => {
      const response = await fetch(buildOpenAiUrl(), {
        method: "POST",
        headers: openAiHeaders(),
        body: JSON.stringify({
          model: request.model,
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
        throw new Error(`OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      return parseOpenAiStyleResponse(await response.json());
    },
    request.signal,
  );
}
