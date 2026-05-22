import { groupedConfig } from "../../config.js";
import { recordLlmUsage } from "../llm/llm-usage-logger.js";
import {
  type DistillationToolCall,
  type DistillationToolResult,
  distillationEvidenceToolNames,
  distillationToolDefinitions,
  executeDistillationToolCall,
} from "./distillation-tools.service.js";
import {
  type DistillationProviderName,
  type DistillationProviderSetting,
  defaultModelForProvider,
  isProviderConfigured,
  resolveDistillationProviderOrder,
} from "./llm-resolver.js";
import { callLocalLlmChat } from "./providers/local-llm.js";
import { callAzureOpenAiChat } from "./providers/azure-openai.js";
import { callBedrockChat } from "./providers/bedrock.js";

// Re-export types from types.ts to preserve public schema
export type {
  DistillationRuntimeToolDefinition,
  DistillationMessage,
  DistillationModelRequest,
  DistillationChatClient,
  DistillationToolExecutor,
  DistillationCompletionResult,
  DistillationRuntimeOptions,
} from "./types.js";

import type {
  DistillationChatClient,
  DistillationChatRequest,
  DistillationChatResponse,
  DistillationCompletionResult,
  DistillationMessage,
  DistillationModelRequest,
  DistillationRuntimeOptions,
} from "./types.js";

// Re-export resolveDistillationModel and ProviderSetting
export { resolveDistillationModel, type DistillationProviderSetting } from "./llm-resolver.js";

// Re-export internal utilities used by external libraries/tests
export { parseToolCalls, parseOpenAiStyleResponse } from "./providers/helpers.js";
export {
  buildBedrockToolConfig,
  buildBedrockConversation,
  parseBedrockResponse,
} from "./providers/bedrock.js";

type DistillationErrorWithToolEvents = Error & {
  distillationToolEvents?: DistillationToolResult[];
};

export function distillationToolEventsFromError(error: unknown): DistillationToolResult[] {
  if (!error || typeof error !== "object") return [];
  const events = (error as { distillationToolEvents?: unknown }).distillationToolEvents;
  return Array.isArray(events) ? (events as DistillationToolResult[]) : [];
}

export function errorWithDistillationToolEvents(
  error: unknown,
  toolEvents: DistillationToolResult[],
): Error {
  const normalized: DistillationErrorWithToolEvents =
    error instanceof Error ? error : new Error(String(error));
  if (toolEvents.length > 0) {
    normalized.distillationToolEvents = [...toolEvents];
  }
  return normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("distillation request aborted");
    error.name = "AbortError";
    throw error;
  }
}

function createDefaultChatClient(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
  usageSource = "distillation",
): DistillationChatClient {
  const order = resolveDistillationProviderOrder(providerSetting);
  let pinnedProvider: DistillationProviderName | null = null;

  const callByProvider: Record<DistillationProviderName, DistillationChatClient> = {
    "local-llm": callLocalLlmChat,
    "azure-openai": callAzureOpenAiChat,
    bedrock: callBedrockChat,
  };

  return async (request: DistillationChatRequest): Promise<DistillationChatResponse> => {
    const providersToTry = pinnedProvider ? [pinnedProvider] : order;
    const errors: string[] = [];

    for (const provider of providersToTry) {
      if (!isProviderConfigured(provider)) {
        errors.push(`${provider}: not configured`);
        continue;
      }

      const model = request.model.trim() ? request.model : defaultModelForProvider(provider);

      try {
        const response = await callByProvider[provider]({ ...request, model });
        recordLlmUsage({
          provider,
          model,
          usage: response.usage,
          promptMessages: request.messages,
          promptMetadata: {
            tools: request.tools,
            toolChoice: request.toolChoice,
          },
          completionText: response.content ?? "",
          completionMetadata: response.toolCalls,
          source: usageSource,
        });
        pinnedProvider = provider;
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${provider}: ${message}`);
        if (providerSetting !== "auto") {
          throw error;
        }
        pinnedProvider = null;
      }
    }

    throw new Error(errors.join(" | ") || "no distillation provider available");
  };
}

export async function runDistillationCompletion(
  request: DistillationModelRequest,
  options: DistillationRuntimeOptions = {},
): Promise<DistillationCompletionResult> {
  const chatClient =
    options.chatClient ??
    createDefaultChatClient(
      options.providerSetting ?? groupedConfig.distillation.provider,
      options.usageSource ?? "distillation",
    );
  const toolExecutor = options.toolExecutor ?? executeDistillationToolCall;
  const maxToolRounds = Math.max(
    0,
    options.maxToolRounds ?? groupedConfig.distillationTools.maxRounds,
  );
  const enableTools = options.enableTools ?? true;
  const defaultToolNames = new Set<string>(distillationEvidenceToolNames);
  const toolDefinitions =
    options.toolDefinitions && options.toolDefinitions.length > 0
      ? options.toolDefinitions
      : options.toolNames?.length
        ? distillationToolDefinitions.filter((tool) =>
            options.toolNames?.includes(tool.function.name),
          )
        : distillationToolDefinitions.filter((tool) => defaultToolNames.has(tool.function.name));
  const requireToolCall = Boolean(options.requireToolCall);
  const messages = request.messages.map((message) => ({ ...message }));
  const toolEvents: DistillationToolResult[] = [];
  let toolRounds = 0;
  let requiredToolReminderSent = false;
  let blankResponseReminderSent = false;

  try {
    while (true) {
      throwIfAborted(options.signal);
      const allowTools = enableTools && toolRounds < maxToolRounds;
      const toolChoice = allowTools
        ? requireToolCall && toolRounds === 0
          ? "required"
          : "auto"
        : "none";
      const response = await chatClient({
        ...request,
        messages,
        tools: allowTools ? toolDefinitions : undefined,
        toolChoice,
        signal: options.signal,
      });

      if (response.toolCalls.length > 0 && allowTools) {
        messages.push({
          role: "assistant",
          content: response.content ?? null,
          tool_calls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          throwIfAborted(options.signal);
          const toolResult = await toolExecutor(toolCall, options.auditContext);
          throwIfAborted(options.signal);
          toolEvents.push(toolResult);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolResult.name,
            content: toolResult.content,
          });
        }
        toolRounds += 1;
        continue;
      }

      if (response.toolCalls.length > 0) {
        throw new Error(`distillation tool loop exceeded max rounds (${maxToolRounds})`);
      }

      if (
        typeof response.content === "string" &&
        allowTools &&
        requireToolCall &&
        toolRounds === 0 &&
        toolEvents.length === 0 &&
        !requiredToolReminderSent
      ) {
        requiredToolReminderSent = true;
        messages.push({
          role: "assistant",
          content: response.content,
        });
        const reminderLines =
          options.requireToolCallReminder && options.requireToolCallReminder.length > 0
            ? options.requireToolCallReminder
            : [
                "直前の応答はまだ採用できません。",
                "この検証 session は外部証拠の tool call が必須です。最終候補を返す前に search_web または fetch_content を少なくとも 1 回呼び出してください。",
                "search_web の結果は URL 発見用です。検索結果を受け取った後は、有望な一次ソース URL を fetch_content してから最終候補を返してください。",
                "fetch_content は複数回呼べます。同義の search_web query を繰り返すより、検索結果 URL を fetch_content してください。",
                'ローカル tool-call parser 向けには {"name":"search_web","arguments":{"query":"..."}} または {"name":"fetch_content","arguments":{"url":"https://..."}} だけを返してください。',
                "この tool-call JSON は中間応答専用です。最終 candidates の title/body に tool 名だけを入れないでください。",
              ];
        messages.push({
          role: "user",
          content: reminderLines.join("\n"),
        });
        continue;
      }

      if (typeof response.content === "string" && response.content.trim()) {
        const finalMessage: DistillationMessage = {
          role: "assistant",
          content: response.content,
        };
        return {
          content: response.content,
          toolEvents,
          messages: [...messages, finalMessage],
        };
      }

      if (
        typeof response.content === "string" &&
        !response.content.trim() &&
        !blankResponseReminderSent
      ) {
        blankResponseReminderSent = true;
        messages.push({
          role: "assistant",
          content: response.content,
        });
        const reminderLines =
          options.blankResponseReminder && options.blankResponseReminder.length > 0
            ? options.blankResponseReminder
            : [
                "直前の応答は空でした。",
                '最終回答として {"candidates":[]}、または TYPE: rule、TITLE: ...、BODY: ...、CONFIDENCE: ...、IMPORTANCE: ... のラベル付きテキストを返してください。',
                "TYPE / TITLE / BODY のような見出し行だけを出さないでください。",
              ];
        messages.push({
          role: "user",
          content: reminderLines.join("\n"),
        });
        continue;
      }

      throw new Error("distillation response did not include assistant content");
    }
  } catch (error) {
    throw errorWithDistillationToolEvents(error, toolEvents);
  }
}

export async function callLocalLlmCompletionForDistillation(
  request: DistillationModelRequest,
): Promise<DistillationCompletionResult> {
  return runDistillationCompletion(request, {
    providerSetting: "local-llm",
    usageSource: "distillation",
  });
}
