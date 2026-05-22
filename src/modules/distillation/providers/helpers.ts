import { parseLlmJsonLike } from "../../../lib/llm-output-parser.js";
import type { DistillationToolCall } from "../distillation-tools.service.js";
import type { DistillationChatResponse } from "../types.js";

type OpenAiToolCall = {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
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
