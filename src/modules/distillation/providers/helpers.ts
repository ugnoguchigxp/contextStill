import { parseLlmJsonLike } from "../../../lib/llm-output-parser.js";
import { normalizeLlmUsage } from "../../llm/usage-normalizer.js";
import type { DistillationToolCall } from "../distillation-tools.service.js";
import type { DistillationChatResponse } from "../types.js";

type OpenAiToolCall = {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type ToolCallLikeObject = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown } | null;
  tool_calls?: unknown;
  toolCalls?: unknown;
};

export function abortError(): Error {
  const error = new Error("distillation request aborted");
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

export function withRequestTimeout<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let parentAbortHandler: (() => void) | undefined;
  const timeoutError = () => new Error(`distillation LLM request timed out after ${timeoutMs}ms`);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const parentAbort = new Promise<never>((_, reject) => {
    if (!parentSignal) return;
    parentAbortHandler = () => {
      controller.abort();
      reject(abortError());
    };
    if (parentSignal.aborted) {
      parentAbortHandler();
      return;
    }
    parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
  });
  const request = task(controller.signal).catch((error) => {
    if (error instanceof Error && error.name === "AbortError") {
      if (!timedOut && parentSignal?.aborted) {
        throw abortError();
      }
      throw timeoutError();
    }
    throw error;
  });

  return Promise.race([request, timeout, parentAbort]).finally(() => {
    if (timer) clearTimeout(timer);
    if (parentSignal && parentAbortHandler) {
      parentSignal.removeEventListener("abort", parentAbortHandler);
    }
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

function normalizeToolCallLike(
  value: unknown,
  index: number,
  options: { requireArguments: boolean },
): DistillationToolCall | null {
  if (!value || typeof value !== "object") return null;
  const call = value as ToolCallLikeObject;
  const functionShape =
    call.function && typeof call.function === "object"
      ? call.function
      : {
          name: call.name,
          arguments: call.arguments,
        };
  const name = functionShape.name;
  if (typeof name !== "string" || !name.trim()) return null;
  if (options.requireArguments && functionShape.arguments === undefined) return null;

  const rawArguments = functionShape.arguments;
  const argumentsText =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined
        ? "{}"
        : JSON.stringify(rawArguments);

  return {
    id: typeof call.id === "string" && call.id.trim() ? call.id : `tool-call-content-${index + 1}`,
    type: call.type === "function" ? "function" : undefined,
    function: {
      name,
      arguments: argumentsText,
    },
  };
}

function parseToolCallsFromContent(rawContent: unknown): DistillationToolCall[] {
  if (typeof rawContent !== "string" || !rawContent.trim()) return [];
  const parsed = parseLlmJsonLike(rawContent)?.value;
  if (!parsed) return [];

  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry, index) => {
      const normalized = normalizeToolCallLike(entry, index, { requireArguments: true });
      return normalized ? [normalized] : [];
    });
  }

  if (!parsed || typeof parsed !== "object") return [];
  const objectValue = parsed as ToolCallLikeObject;
  const nestedCalls = parseToolCalls(objectValue.tool_calls ?? objectValue.toolCalls);
  if (nestedCalls.length > 0) return nestedCalls;

  const single = normalizeToolCallLike(objectValue, 0, { requireArguments: true });
  return single ? [single] : [];
}

/** @internal */
export function parseOpenAiStyleResponse(payload: unknown): DistillationChatResponse {
  const parsed = payload as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown };
      finish_reason?: unknown;
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      completion_tokens_details?: {
        reasoning_tokens?: unknown;
      };
    };
  };
  const choice = parsed.choices?.[0];
  const rawContent = choice?.message?.content;
  const usage = normalizeLlmUsage({
    promptTokens: parsed.usage?.prompt_tokens,
    completionTokens: parsed.usage?.completion_tokens,
    totalTokens: parsed.usage?.total_tokens,
    reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens,
  });
  const explicitToolCalls = parseToolCalls(choice?.message?.tool_calls);
  const recoveredToolCalls =
    explicitToolCalls.length > 0 ? [] : parseToolCallsFromContent(rawContent);
  const toolCalls = explicitToolCalls.length > 0 ? explicitToolCalls : recoveredToolCalls;
  const normalizedContent =
    recoveredToolCalls.length > 0 ? null : typeof rawContent === "string" ? rawContent : null;
  return {
    content: normalizedContent,
    toolCalls,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    usage,
  };
}
