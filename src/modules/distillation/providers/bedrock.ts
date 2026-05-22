import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type Message,
  type SystemContentBlock,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import { groupedConfig } from "../../../config.js";
import { parseLlmJsonLike } from "../../../lib/llm-output-parser.js";
import { normalizeLlmUsage } from "../../llm/usage-normalizer.js";
import type {
  DistillationChatRequest,
  DistillationChatResponse,
  DistillationMessage,
  DistillationRuntimeToolDefinition,
} from "../types.js";
import { withRequestTimeout } from "./helpers.js";

function parseToolArguments(raw: string): unknown {
  return parseLlmJsonLike(raw)?.value ?? { rawArguments: raw };
}

/** @internal */
export function buildBedrockToolConfig(
  tools: DistillationRuntimeToolDefinition[] | undefined,
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
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };

  const contentBlocks = response.output?.message?.content ?? [];
  const textSegments: string[] = [];
  const toolCalls: any[] = [];

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
    usage: normalizeLlmUsage({
      promptTokens: response.usage?.inputTokens,
      completionTokens: response.usage?.outputTokens,
      totalTokens: response.usage?.totalTokens,
    }),
  };
}

export async function callBedrockChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(
    groupedConfig.distillation.timeoutMs,
    async (signal) => {
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
    },
    request.signal,
  );
}
