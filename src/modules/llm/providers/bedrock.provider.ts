import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { groupedConfig } from "../../../config.js";
import type {
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";
import { normalizeLlmUsage } from "../usage-normalizer.js";

type BedrockProviderOptions = {
  timeoutMs?: number;
  modelConfig?: { region: string; profile: string; model: string };
  probe?: boolean;
};

function asBedrockRole(role: LlmChatMessage["role"]): "user" | "assistant" {
  return role === "assistant" ? "assistant" : "user";
}

function extractText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const output = (response as Record<string, unknown>).output;
  if (!output || typeof output !== "object") return null;
  const message = (output as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return null;

  const texts = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean);

  if (texts.length === 0) return null;
  return texts.join("\n");
}

function isReachableClientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (metadata?.httpStatusCode !== undefined) {
    return metadata.httpStatusCode < 500;
  }

  const name = (error as { name?: string }).name;
  return (
    name === "AccessDeniedException" ||
    name === "ValidationException" ||
    name === "ThrottlingException" ||
    name === "ResourceNotFoundException"
  );
}

export function createBedrockProvider(options: BedrockProviderOptions = {}): LlmProvider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const config = options.modelConfig ?? groupedConfig.bedrock;
  const isConfigured = () => Boolean(config.region.trim() && config.model.trim());

  return {
    name: "bedrock",
    isConfigured,
    async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
      if (!isConfigured()) {
        throw new Error("Bedrock is not configured");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const system = request.messages
          .filter((message) => message.role === "system")
          .map((message) => ({ text: message.content ?? "" }));

        const messages = request.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({
            role: asBedrockRole(message.role),
            content: [{ text: message.content ?? "" }],
          }));

        if (messages.length === 0) {
          messages.push({
            role: "user",
            content: [{ text: "ping" }],
          });
        }

        const command = new ConverseCommand({
          modelId: request.model?.trim() || config.model,
          messages,
          ...(system.length > 0 ? { system } : {}),
          inferenceConfig: {
            maxTokens: request.maxTokens,
            temperature: request.temperature ?? 0,
          },
        });

        const client = new BedrockRuntimeClient({
          region: config.region,
          profile: config.profile || undefined,
          maxAttempts: options.probe ? 1 : undefined,
        });
        let response: ConverseCommandOutput;
        try {
          response = await client.send(command, {
            abortSignal: controller.signal,
          });
        } finally {
          client.destroy();
        }

        const content = extractText(response);
        if (
          (!content || !content.trim()) &&
          !(options.probe && response.output?.message && response.stopReason)
        ) {
          throw new Error("Bedrock returned empty response");
        }

        const stopReason = (response as { stopReason?: string }).stopReason;
        const usage = normalizeLlmUsage({
          promptTokens: response.usage?.inputTokens,
          completionTokens: response.usage?.outputTokens,
          totalTokens: response.usage?.totalTokens,
        });
        return {
          content: content ?? "",
          finishReason: typeof stopReason === "string" ? stopReason : undefined,
          usage,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async healthCheck(): Promise<LlmHealthStatus> {
      const result: LlmHealthStatus = {
        provider: "bedrock",
        configured: isConfigured(),
        reachable: false,
        model: config.model,
        endpoint: `bedrock://${config.region}`,
      };

      if (!result.configured) {
        return { ...result, error: "Bedrock is not configured" };
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
        if (isReachableClientError(error)) {
          return {
            ...result,
            reachable: true,
          };
        }
        return {
          ...result,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
