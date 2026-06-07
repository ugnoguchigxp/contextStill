import { groupedConfig } from "../../../config.js";
import {
  buildLocalLlmChatCompletionsUrl,
  resolveLocalLlmModelConfig,
} from "../../llm/providers/local-llm-config.js";
import type { DistillationChatRequest, DistillationChatResponse } from "../types.js";
import { parseOpenAiStyleResponse, withRequestTimeout } from "./helpers.js";

function localLlmHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (groupedConfig.localLlm.apiKey.trim()) {
    headers.Authorization = `Bearer ${groupedConfig.localLlm.apiKey.trim()}`;
  }
  return headers;
}

export async function callLocalLlmChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(
    request.timeoutMs ?? groupedConfig.distillation.timeoutMs,
    async (signal) => {
      const config = resolveLocalLlmModelConfig(request.model);
      const response = await fetch(buildLocalLlmChatCompletionsUrl(config.apiBaseUrl), {
        method: "POST",
        headers: localLlmHeaders(),
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          stream: false,
          temperature: 0,
          max_tokens: request.maxTokens,
          priority: "low",
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
        throw new Error(`local-llm HTTP ${response.status}: ${body.slice(0, 500)}`);
      }

      return parseOpenAiStyleResponse(await response.json());
    },
    request.signal,
  );
}
