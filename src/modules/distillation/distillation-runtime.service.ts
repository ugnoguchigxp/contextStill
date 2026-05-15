import { config } from "../../config.js";
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
  toolChoice?: "auto" | "none";
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
) => Promise<DistillationToolResult>;

export type DistillationCompletionResult = {
  content: string;
  toolEvents: DistillationToolResult[];
  messages: DistillationMessage[];
};

export type DistillationRuntimeOptions = {
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  enableTools?: boolean;
  maxToolRounds?: number;
};

function localLlmHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (config.localLlmApiKey.trim()) {
    headers.Authorization = `Bearer ${config.localLlmApiKey.trim()}`;
  }
  return headers;
}

function parseToolCalls(value: unknown): DistillationToolCall[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((rawCall, index) => {
    if (!rawCall || typeof rawCall !== "object") return [];
    const call = rawCall as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
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

async function callLocalLlmChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.vibeDistillationTimeoutMs);
  try {
    const response = await fetch(`${config.localLlmApiBaseUrl}/v1/chat/completions`, {
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
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`local-llm HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }>;
    };
    const choice = payload.choices?.[0];
    const rawContent = choice?.message?.content;
    return {
      content: typeof rawContent === "string" ? rawContent : null,
      toolCalls: parseToolCalls(choice?.message?.tool_calls),
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runDistillationCompletion(
  request: DistillationModelRequest,
  options: DistillationRuntimeOptions = {},
): Promise<DistillationCompletionResult> {
  const chatClient = options.chatClient ?? callLocalLlmChat;
  const toolExecutor = options.toolExecutor ?? executeDistillationToolCall;
  const maxToolRounds = Math.max(0, options.maxToolRounds ?? config.distillationToolMaxRounds);
  const enableTools = options.enableTools ?? true;
  const messages = request.messages.map((message) => ({ ...message }));
  const toolEvents: DistillationToolResult[] = [];
  let toolRounds = 0;

  while (true) {
    const allowTools = enableTools && toolRounds < maxToolRounds;
    const response = await chatClient({
      ...request,
      messages,
      tools: allowTools ? distillationToolDefinitions : undefined,
      toolChoice: allowTools ? "auto" : "none",
    });

    if (response.toolCalls.length > 0 && allowTools) {
      messages.push({
        role: "assistant",
        content: response.content ?? null,
        tool_calls: response.toolCalls,
      });

      for (const toolCall of response.toolCalls) {
        const toolResult = await toolExecutor(toolCall);
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

    throw new Error("local-llm response did not include assistant content");
  }
}

export async function callLocalLlmCompletionForDistillation(
  request: DistillationModelRequest,
): Promise<DistillationCompletionResult> {
  return runDistillationCompletion(request);
}
