import { groupedConfig } from "../../../config.js";
import { LlmProviderHttpError, parseRetryAfterSeconds } from "../../llm/provider-http-error.js";
import {
  type AzureOpenAiRuntimeDeployment,
  azureOpenAiDeploymentAuditLabel,
  azureOpenAiCooldownError,
  azureOpenAiDeploymentsForTask,
  azureOpenAiHeaders,
  buildAzureOpenAiChatUrl,
  configuredAzureOpenAiDeploymentsForSlots,
  markAzureOpenAiDeploymentRateLimited,
  markAzureOpenAiDeploymentSucceeded,
} from "../../llm/providers/azure-openai-config.js";
import type {
  DistillationChatClient,
  DistillationChatRequest,
  DistillationChatResponse,
} from "../types.js";
import { parseOpenAiStyleResponse, withRequestTimeout } from "./helpers.js";

function buildAzureOpenAiChatBody(request: DistillationChatRequest): Record<string, unknown> {
  const base = {
    messages: request.messages,
    temperature: 0,
    max_completion_tokens: request.maxTokens,
  };
  if (request.tools && request.tools.length > 0) {
    return {
      ...base,
      tools: request.tools,
      tool_choice: request.toolChoice ?? "auto",
    };
  }
  return base;
}

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

async function callAzureOpenAiChatWithDeploymentPool(
  request: DistillationChatRequest,
  pinnedDeployment: AzureOpenAiRuntimeDeployment | null,
  selectedSlots: number[] | undefined,
  setPinnedDeployment: (deployment: AzureOpenAiRuntimeDeployment) => void,
): Promise<DistillationChatResponse> {
  return withRequestTimeout(
    request.timeoutMs ?? groupedConfig.distillation.timeoutMs,
    async (signal) => {
      if (configuredAzureOpenAiDeploymentsForSlots(selectedSlots).length === 0) {
        throw new Error("Azure OpenAI is not configured");
      }

      const deployments = azureOpenAiDeploymentsForTask(pinnedDeployment, selectedSlots);
      if (deployments.length === 0) {
        throw azureOpenAiCooldownError();
      }

      let lastError: unknown;
      for (const [index, deployment] of deployments.entries()) {
        try {
          const response = await fetch(buildAzureOpenAiChatUrl(deployment), {
            method: "POST",
            headers: azureOpenAiHeaders(deployment),
            body: JSON.stringify(buildAzureOpenAiChatBody(request)),
            signal,
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

          const parsed = parseOpenAiStyleResponse(await response.json());
          setPinnedDeployment(deployment);
          markAzureOpenAiDeploymentSucceeded(deployment);
          return {
            ...parsed,
            providerMetadata: {
              azureDeployment: azureOpenAiDeploymentAuditLabel(deployment),
            },
          };
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
    },
    request.signal,
  );
}

export function createAzureOpenAiChatClient(selectedSlots?: number[]): DistillationChatClient {
  let pinnedDeployment: AzureOpenAiRuntimeDeployment | null = null;
  return (request) =>
    callAzureOpenAiChatWithDeploymentPool(
      request,
      pinnedDeployment,
      selectedSlots,
      (deployment) => {
        pinnedDeployment = deployment;
      },
    );
}

export async function callAzureOpenAiChat(
  request: DistillationChatRequest,
): Promise<DistillationChatResponse> {
  return createAzureOpenAiChatClient()(request);
}
