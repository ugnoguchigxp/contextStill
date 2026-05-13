export class MemoryRouterError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MemoryRouterError";
    this.code = code;
    this.details = details;
  }
}

export const isMemoryRouterError = (value: unknown): value is MemoryRouterError =>
  value instanceof MemoryRouterError;
