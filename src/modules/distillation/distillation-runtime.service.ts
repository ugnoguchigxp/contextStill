import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import {
  distillationToolDefinitions,
  executeDistillationToolCall,
  type DistillationToolCall,
  type DistillationToolDefinition,
  type DistillationToolResult,
} from "./distillation-tools.service.js";

export type DistillationMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: DistillationToolCall[];
};

export type DistillationModelRequest = {
  model: string;
  messages: DistillationMessage[];
  maxTokens: number;
};

type DistillationChatRequest = DistillationModelRequest & {
  tools?: DistillationToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
};

type DistillationChatResponse = {
  content?: string | null;
  toolCalls: DistillationToolCall[];
  finishReason?: string;
};

export type DistillationChatClient = (
  request: DistillationChatRequest,
) => Promise<DistillationChatResponse>;

export type DistillationToolExecutor = (
  toolCall: DistillationToolCall,
  auditContext?: Record<string, unknown>,
) => Promise<DistillationToolResult>;

export type DistillationCompletionResult = {
  content: string;
  toolEvents: DistillationToolResult[];
  messages: DistillationMessage[];
};

type DistillationErrorWithToolEvents = Error & {
  distillationToolEvents?: DistillationToolResult[];
};

export type DistillationRuntimeOptions = {
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  enableTools?: boolean;
  maxToolRounds?: number;
  auditContext?: Record<string, unknown>;
  requireToolCall?: boolean;
};

type DistillationProviderName = "local-llm" | "azure-openai" | "bedrock";
type DistillationProviderSetting = "local-llm" | "azure-openai" | "bedrock" | "auto";

type OpenAiToolCall = {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
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

function resolveDistillationProviderOrder(
  setting: DistillationProviderSetting,
): DistillationProviderName[] {
  if (setting === "auto") {
    return ["local-llm", "azure-openai", "bedrock"];
  }
  return [setting];
}

function defaultModelForProvider(provider: DistillationProviderName): string {
  switch (provider) {
    case "azure-openai":
      return groupedConfig.azureOpenAi.model;
    case "bedrock":
      return groupedConfig.bedrock.model;
    default:
      return groupedConfig.localLlm.model;
  }
}

function isProviderConfigured(provider: DistillationProviderName): boolean {
  switch (provider) {
    case "azure-openai":
      return Boolean(
        groupedConfig.azureOpenAi.apiKey.trim() &&
          groupedConfig.azureOpenAi.apiBaseUrl.trim() &&
          groupedConfig.azureOpenAi.model.trim(),
      );
    case "bedrock":
      return Boolean(groupedConfig.bedrock.region.trim() && groupedConfig.bedrock.model.trim());
    default:
      return Boolean(
        groupedConfig.localLlm.apiBaseUrl.trim() && groupedConfig.localLlm.model.trim(),
      );
  }
}

function resolveProviderForDistillation(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
): DistillationProviderName {
  const order = resolveDistillationProviderOrder(providerSetting);
  for (const provider of order) {
    if (isProviderConfigured(provider)) {
      return provider;
    }
  }
  return order[0] ?? "local-llm";
}

export function resolveDistillationModel(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
): string {
  return defaultModelForProvider(resolveProviderForDistillation(providerSetting));
}

function withRequestTimeout<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new Error(`distillation LLM request timed out after ${timeoutMs}ms`);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const request = task(controller.signal).catch((error) => {
    if (error instanceof Error && error.name === "AbortError") {
      throw timeoutError();
    }
    throw error;
  });

  return Promise.race([request, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** @internal */
export function parseToolCalls(value: unknown): DistillationToolCall[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawCall, index) => {
    if (!rawCall || typeof rawCall !== "object") return [];
    const call = rawCall as OpenAiToolCall;
    const name = call.function?.name;
    if (typeof name !== "string" || !name.trim()) return [];
    const rawArguments = call.function?.arguments;
    const args =
      typeof rawArguments === "string"
        ? rawArguments
        : rawArguments === undefined
          ? "{}"
          : JSON.stringify(rawArguments);
    return [
      {
        id: typeof call.id === "string" && call.id.trim() ? call.id : `tool-call-${index + 1}`,
        type: call.type === "function" ? "function" : undefined,
        function: {
          name,
          arguments: args,
        },
      },
    ];
  });
}

function localLlmHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (groupedConfig.localLlm.apiKey.trim()) {
    headers.Authorization = `Bearer ${groupedConfig.localLlm.apiKey.trim()}`;
  }
  return headers;
}

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

/** @internal */
export function parseOpenAiStyleResponse(payload: unknown): DistillationChatResponse {
  const parsed = payload as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown };
      finish_reason?: unknown;
    }>;
  };
  const choice = parsed.choices?.[0];
  const rawContent = choice?.message?.content;
  return {
    content: typeof rawContent === "string" ? rawContent : null,
    toolCalls: parseToolCalls(choice?.message?.tool_calls),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

function parseToolArguments(raw: string): unknown {
  return parseLlmJsonLike(raw)?.value ?? { rawArguments: raw };
}

/** @internal */
export function buildBedrockToolConfig(
  tools: DistillationToolDefinition[] | undefined,
  toolChoice: DistillationChatRequest["toolChoice"] = "auto",
): ToolConfiguration | undefined {
  if (!tools || tools.length === 0) return undefined;
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: {
          json: tool.function.parameters as unknown,
        },
      },
    })) as ToolConfiguration["tools"],
    toolChoice: (toolChoice === "required"
      ? { any: {} }
      : { auto: {} }) as ToolConfiguration["toolChoice"],
  };
}

/** @internal */
export function buildBedrockConversation(messages: DistillationMessage[]): {
  system: SystemContentBlock[];
  messages: Message[];
} {
  const system: SystemContentBlock[] = [];
  const converted: Message[] = [];

  let pendingToolResults: ContentBlock[] = [];

  const flushPendingToolResults = () => {
    if (pendingToolResults.length === 0) return;
    converted.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      flushPendingToolResults();
      if (typeof message.content === "string" && message.content.trim()) {
        system.push({ text: message.content });
      }
      continue;
    }

    if (message.role === "tool") {
      const toolUseId = message.tool_call_id?.trim();
      if (!toolUseId) {
        continue;
      }
      pendingToolResults.push({
        toolResult: {
          toolUseId,
          content: [
            {
              text: typeof message.content === "string" ? message.content : "",
            },
          ],
          status: "success",
        },
      });
      continue;
    }

    flushPendingToolResults();

    if (message.role === "user") {
      converted.push({
        role: "user",
        content: [{ text: typeof message.content === "string" ? message.content : "" }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: ContentBlock[] = [];
      if (typeof message.content === "string" && message.content.trim()) {
        content.push({ text: message.content });
      }
      for (const toolCall of message.tool_calls ?? []) {
        const toolUseId =
          typeof toolCall.id === "string" && toolCall.id.trim()
            ? toolCall.id
            : `tool-call-${content.length + 1}`;
        content.push({
          toolUse: {
            toolUseId,
            name: toolCall.function.name,
            input: parseToolArguments(toolCall.function.arguments) as never,
          },
        } as ContentBlock);
      }
      if (content.length === 0) {
        content.push({ text: "" });
      }
      converted.push({ role: "assistant", content });
    }
  }

  flushPendingToolResults();

  if (converted.length === 0) {
    converted.push({
      role: "user",
      content: [{ text: "ping" }],
    });
  }

  return { system, messages: converted };
}

/** @internal */
export function parseBedrockResponse(payload: unknown): DistillationChatResponse {
  const response = payload as {
    output?: {
      message?: {
        content?: Array<{
          text?: string;
          toolUse?: { toolUseId?: string; name?: string; input?: unknown };
        }>;
      };
    };
    stopReason?: string;
  };

  const contentBlocks = response.output?.message?.content ?? [];
  const textSegments: string[] = [];
  const toolCalls: DistillationToolCall[] = [];

  for (const block of contentBlocks) {
    if (typeof block.text === "string" && block.text.trim()) {
      textSegments.push(block.text);
    }
    if (block.toolUse) {
      const toolUseId =
        typeof block.toolUse.toolUseId === "string" && block.toolUse.toolUseId.trim()
          ? block.toolUse.toolUseId
          : `tool-call-${toolCalls.length + 1}`;
      const toolName =
        typeof block.toolUse.name === "string" && block.toolUse.name.trim()
          ? block.toolUse.name
          : "unknown_tool";
      toolCalls.push({
        id: toolUseId,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(block.toolUse.input ?? {}),
        },
      });
    }
  }

  return {
    content: textSegments.length > 0 ? textSegments.join("\n") : null,
    toolCalls,
    finishReason: response.stopReason,
  };
}

async function callLocalLlmChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(groupedConfig.distillation.timeoutMs, async (signal) => {
    const response = await fetch(`${groupedConfig.localLlm.apiBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: localLlmHeaders(),
      body: JSON.stringify({
        model: request.model,
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
  });
}

async function callAzureOpenAiChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(groupedConfig.distillation.timeoutMs, async (signal) => {
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
  });
}

async function callBedrockChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(groupedConfig.distillation.timeoutMs, async (signal) => {
    const { system, messages } = buildBedrockConversation(request.messages);
    const toolConfig =
      request.toolChoice === "none"
        ? undefined
        : buildBedrockToolConfig(request.tools, request.toolChoice);

    if (groupedConfig.bedrock.profile.trim()) {
      process.env.AWS_PROFILE = groupedConfig.bedrock.profile.trim();
    }
    const client = new BedrockRuntimeClient({
      region: groupedConfig.bedrock.region,
    });

    const response = await client.send(
      new ConverseCommand({
        modelId: request.model,
        messages,
        ...(system.length > 0 ? { system } : {}),
        inferenceConfig: {
          maxTokens: request.maxTokens,
          temperature: 0,
        },
        ...(toolConfig ? { toolConfig } : {}),
      }),
      { abortSignal: signal },
    );

    return parseBedrockResponse(response);
  });
}

function createDefaultChatClient(
  providerSetting: DistillationProviderSetting = groupedConfig.distillation.provider,
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
  const chatClient = options.chatClient ?? createDefaultChatClient();
  const toolExecutor = options.toolExecutor ?? executeDistillationToolCall;
  const maxToolRounds = Math.max(
    0,
    options.maxToolRounds ?? groupedConfig.distillationTools.maxRounds,
  );
  const enableTools = options.enableTools ?? true;
  const requireToolCall = Boolean(options.requireToolCall);
  const messages = request.messages.map((message) => ({ ...message }));
  const toolEvents: DistillationToolResult[] = [];
  let toolRounds = 0;
  let requiredToolReminderSent = false;
  let blankResponseReminderSent = false;

  try {
    while (true) {
      const allowTools = enableTools && toolRounds < maxToolRounds;
      const toolChoice = allowTools
        ? requireToolCall && toolRounds === 0
          ? "required"
          : "auto"
        : "none";
      const response = await chatClient({
        ...request,
        messages,
        tools: allowTools ? distillationToolDefinitions : undefined,
        toolChoice,
      });

      if (response.toolCalls.length > 0 && allowTools) {
        messages.push({
          role: "assistant",
          content: response.content ?? null,
          tool_calls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const toolResult = await toolExecutor(toolCall, options.auditContext);
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
        messages.push({
          role: "user",
          content: [
            "直前の応答はまだ採用できません。",
            "この検証 session は外部証拠の tool call が必須です。最終候補を返す前に search_web または fetch_content を 1 回だけ呼び出してください。",
            'ローカル tool-call parser 向けには {"name":"search_web","arguments":{"query":"..."}} または {"name":"fetch_content","arguments":{"url":"https://..."}} だけを返してください。',
            "この tool-call JSON は中間応答専用です。最終 candidates の title/body に tool 名だけを入れないでください。",
          ].join("\n"),
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
        messages.push({
          role: "user",
          content: [
            "直前の応答は空でした。",
            '最終回答として {"candidates":[]}、または TYPE / TITLE / BODY のラベル付きテキストを返してください。',
          ].join("\n"),
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
    chatClient: callLocalLlmChat,
  });
}
