export class LlmProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(params: {
    provider: string;
    status: number;
    message: string;
    retryAfterSeconds?: number | null;
  }) {
    super(params.message);
    this.name = "LlmProviderHttpError";
    this.provider = params.provider;
    this.status = params.status;
    this.retryAfterSeconds =
      typeof params.retryAfterSeconds === "number" && Number.isFinite(params.retryAfterSeconds)
        ? Math.max(0, params.retryAfterSeconds)
        : null;
  }
}

function parseInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

type HeaderGetter = {
  get(name: string): string | null;
};

export function parseRetryAfterSeconds(headers: HeaderGetter | null | undefined): number | null {
  if (!headers || typeof headers.get !== "function") return null;
  const direct = parseInteger(headers.get("retry-after"));
  if (direct !== null) return Math.max(0, direct);

  const unixSeconds = parseInteger(headers.get("x-ratelimit-reset"));
  if (unixSeconds !== null) {
    const wait = unixSeconds - Math.floor(Date.now() / 1000);
    return Math.max(0, wait);
  }

  const resetMs = parseInteger(headers.get("x-ratelimit-reset-ms"));
  if (resetMs !== null) {
    return Math.max(0, Math.ceil(resetMs / 1000));
  }

  return null;
}
