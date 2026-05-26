import { groupedConfig } from "../../../config.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmHealthStatus,
  LlmProvider,
} from "../llm-provider.js";
import { LlmProviderHttpError, parseRetryAfterSeconds } from "../provider-http-error.js";
import { normalizeLlmUsage } from "../usage-normalizer.js";
import {
  type AzureOpenAiRuntimeDeployment,
  azureOpenAiCooldownError,
  azureOpenAiDeploymentAt,
  azureOpenAiDeploymentSlot,
  azureOpenAiDeploymentsForTask,
  azureOpenAiHeaders,
  buildAzureOpenAiChatUrl,
  configuredAzureOpenAiDeploymentsForSlots,
  markAzureOpenAiDeploymentRateLimited,
  markAzureOpenAiDeploymentSucceeded,
  primaryAzureOpenAiDeployment,
} from "./azure-openai-config.js";

type AzureOpenAiResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
};

type AzureOpenAiProviderOptions = {
  timeoutMs?: number;
  deploymentIndex?: number;
  deploymentSlots?: number[];
};

const azureHealthCheckMaxTokens = 16;

function isRetryableAzureError(error: unknown): boolean {
  if (!(error instanceof LlmProviderHttpError)) return true;
  if (error.status === 404 && error.message.includes("DeploymentNotFound")) return true;
  return (
    error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
  );
}

function isAzureRateLimitError(error: unknown): boolean {
  return error instanceof LlmProviderHttpError && error.status === 429;
}

function isAzureOutputLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("max_tokens or model output limit") ||
    normalized.includes("maximum output token") ||
    normalized.includes("model output limit")
  );
}

async function parseResponse(response: Response): Promise<LlmChatResponse> {
  const payload = (await response.json()) as AzureOpenAiResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Azure OpenAI returned empty response");
  }
  const usage = payload.usage
    ? normalizeLlmUsage({
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
        reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens,
      })
    : undefined;
  return {
    content,
    finishReason: payload.choices?.[0]?.finish_reason,
    usage,
  };
}

async function pingAzureOpenAiDeployment(
  deployment: AzureOpenAiRuntimeDeployment,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(buildAzureOpenAiChatUrl(deployment), {
    method: "POST",
    headers: azureOpenAiHeaders(deployment),
    body: JSON.stringify({
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      max_completion_tokens: azureHealthCheckMaxTokens,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const message = `Azure OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`;
    if (response.status === 400 && isAzureOutputLimitError(message)) {
      return;
    }
    throw new LlmProviderHttpError({
      provider: "azure-openai",
      status: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(response.headers),
      message,
    });
  }

  try {
    await parseResponse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("returned empty response")) {
      return;
    }
    throw error;
  }
}

async function pingAzureOpenAiDeploymentWithTimeout(
  deployment: AzureOpenAiRuntimeDeployment,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await pingAzureOpenAiDeployment(deployment, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createAzureOpenAiProvider(options: AzureOpenAiProviderOptions = {}): LlmProvider {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 5000);
  const deploymentIndex = options.deploymentIndex;
  const deploymentSlots = options.deploymentSlots;
  let pinnedDeployment: AzureOpenAiRuntimeDeployment | null = null;

  const configuredDeployments = () => {
    if (typeof deploymentIndex === "number") {
      const deployment = azureOpenAiDeploymentAt(deploymentIndex);
      return deployment ? [deployment] : [];
    }
    return configuredAzureOpenAiDeploymentsForSlots(deploymentSlots);
  };
  const selectedDeployments = () => {
    if (typeof deploymentIndex === "number") {
      const deployment = azureOpenAiDeploymentAt(deploymentIndex);
      return deployment ? [deployment] : [];
    }
    return azureOpenAiDeploymentsForTask(pinnedDeployment, deploymentSlots);
  };
  const isConfigured = () => configuredDeployments().length > 0;

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
        const deployments = selectedDeployments();
        if (deployments.length === 0) {
          throw azureOpenAiCooldownError();
        }

        let lastError: unknown;
        for (const [index, deployment] of deployments.entries()) {
          try {
            const response = await fetch(buildAzureOpenAiChatUrl(deployment), {
              method: "POST",
              headers: azureOpenAiHeaders(deployment),
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
              throw new LlmProviderHttpError({
                provider: "azure-openai",
                status: response.status,
                retryAfterSeconds: parseRetryAfterSeconds(response.headers),
                message: `Azure OpenAI HTTP ${response.status}: ${body.slice(0, 500)}`,
              });
            }

            const parsed = await parseResponse(response);
            pinnedDeployment = deployment;
            if (typeof deploymentIndex !== "number") {
              markAzureOpenAiDeploymentSucceeded(deployment);
            }
            return parsed;
          } catch (error) {
            lastError = error;
            if (isAzureRateLimitError(error)) {
              markAzureOpenAiDeploymentRateLimited(deployment, error);
            }
            if (index >= deployments.length - 1 || !isRetryableAzureError(error)) {
              throw error;
            }
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      } finally {
        clearTimeout(timer);
      }
    },
    async healthCheck(): Promise<LlmHealthStatus> {
      const slot =
        typeof deploymentIndex === "number" ? azureOpenAiDeploymentSlot(deploymentIndex) : null;
      const primary =
        typeof deploymentIndex === "number"
          ? azureOpenAiDeploymentAt(deploymentIndex)
          : primaryAzureOpenAiDeployment();
      const result: LlmHealthStatus = {
        provider: "azure-openai",
        configured: isConfigured(),
        reachable: false,
        model: primary?.model ?? slot?.model ?? groupedConfig.azureOpenAi.model,
        endpoint: primary?.apiBaseUrl ?? slot?.apiBaseUrl ?? groupedConfig.azureOpenAi.apiBaseUrl,
      };

      if (!result.configured) {
        return { ...result, error: "Azure OpenAI is not configured" };
      }

      const healthDeployments = configuredDeployments();
      let lastError: unknown;

      for (const deployment of healthDeployments) {
        try {
          await pingAzureOpenAiDeploymentWithTimeout(deployment, timeoutMs);
          return {
            ...result,
            reachable: true,
            model: deployment.model,
            endpoint: deployment.apiBaseUrl,
          };
        } catch (error) {
          lastError = error;
          if (isAzureRateLimitError(error)) {
            markAzureOpenAiDeploymentRateLimited(deployment, error);
          }
        }
      }

      const message = lastError instanceof Error ? lastError.message : String(lastError);
      if (isAzureOutputLimitError(message)) {
        const fallbackDeployment = healthDeployments[0];
        if (fallbackDeployment) {
          return {
            ...result,
            reachable: true,
            model: fallbackDeployment.model,
            endpoint: fallbackDeployment.apiBaseUrl,
          };
        }
      }
      return {
        ...result,
        error: message,
      };
    },
  };
}
