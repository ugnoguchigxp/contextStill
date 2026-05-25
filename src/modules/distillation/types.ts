import type { DistillationToolCall, DistillationToolResult } from "./distillation-tools.service.js";
import type { DistillationProviderName, DistillationProviderSetting } from "./llm-resolver.js";

export type DistillationRuntimeToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    };
  };
};

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

export type DistillationChatRequest = DistillationModelRequest & {
  tools?: DistillationRuntimeToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type DistillationChatResponse = {
  content?: string | null;
  toolCalls: DistillationToolCall[];
  finishReason?: string;
  provider?: DistillationProviderName;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
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

export type DistillationRuntimeOptions = {
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
  providerSetting?: DistillationProviderSetting;
  fallbackOrder?: DistillationProviderName[];
  enableTools?: boolean;
  maxToolRounds?: number;
  toolCallLimits?: Record<string, number>;
  auditContext?: Record<string, unknown>;
  requireToolCall?: boolean;
  toolNames?: readonly string[];
  toolDefinitions?: DistillationRuntimeToolDefinition[];
  usageSource?: string;
  requireToolCallReminder?: string[];
  blankResponseReminder?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
};
