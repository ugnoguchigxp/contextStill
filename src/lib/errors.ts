export class ContextStillError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ContextStillError";
    this.code = code;
    this.details = details;
  }
}

export const isContextStillError = (value: unknown): value is ContextStillError =>
  value instanceof ContextStillError;

export const MemoryRouterError = ContextStillError;
export const isMemoryRouterError = isContextStillError;
