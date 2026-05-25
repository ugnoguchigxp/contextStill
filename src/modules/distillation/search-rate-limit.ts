import type { SearchProviderName, SearchProviderRateLimit } from "./search-provider.types.js";

function splitHeaderList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseResetSeconds(value: string | undefined, nowMs = Date.now()): number | undefined {
  const parsed = parsePositiveNumber(value);
  if (parsed === undefined) return undefined;
  if (parsed > 1_000_000_000) {
    const epochSeconds = parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    const seconds = epochSeconds - Math.floor(nowMs / 1000);
    return seconds > 0 ? seconds : undefined;
  }
  return Math.ceil(parsed);
}

export function parseRetryAfterSeconds(
  value: string | undefined | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const seconds = Math.ceil((dateMs - nowMs) / 1000);
    return seconds > 0 ? seconds : undefined;
  }
  return undefined;
}

function maxPositive(values: Array<number | undefined>): number | undefined {
  const positives = values.filter((value): value is number => value !== undefined && value > 0);
  return positives.length > 0 ? Math.max(...positives) : undefined;
}

function parsePolicyWindows(policy: string | undefined): number[] {
  return splitHeaderList(policy).flatMap((part) => {
    const match = part.match(/;\s*w=(\d+)/i);
    const windowSeconds = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(windowSeconds) && windowSeconds > 0 ? [windowSeconds] : [];
  });
}

export function deriveBraveRateLimitCooldownSeconds(
  rateLimit: Pick<
    SearchProviderRateLimit,
    "remaining" | "reset" | "policy" | "retryAfter" | "retryAfterSeconds" | "status"
  >,
  nowMs = Date.now(),
): number | undefined {
  const retryAfterSeconds =
    rateLimit.retryAfterSeconds ?? parseRetryAfterSeconds(rateLimit.retryAfter, nowMs);
  const remainingValues = splitHeaderList(rateLimit.remaining).map((value) => Number(value));
  const resetValues = splitHeaderList(rateLimit.reset).map((value) =>
    parseResetSeconds(value, nowMs),
  );
  const exhaustedResetValues = remainingValues.flatMap((remaining, index) =>
    Number.isFinite(remaining) && remaining <= 0 ? [resetValues[index]] : [],
  );
  const exhaustedReset = maxPositive(exhaustedResetValues);
  if (exhaustedReset !== undefined) {
    return Math.max(exhaustedReset, retryAfterSeconds ?? 0);
  }

  const resetSeconds = maxPositive(resetValues);
  if (rateLimit.status === 429 && resetSeconds !== undefined) {
    return Math.max(resetSeconds, retryAfterSeconds ?? 0);
  }

  const policyWindowSeconds = maxPositive(parsePolicyWindows(rateLimit.policy));
  if (rateLimit.status === 429 && policyWindowSeconds !== undefined) {
    return Math.max(policyWindowSeconds, retryAfterSeconds ?? 0);
  }

  return retryAfterSeconds;
}

export function deriveSearchProviderCooldownSeconds(
  provider: SearchProviderName,
  rateLimit: SearchProviderRateLimit | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!rateLimit) return undefined;
  if (provider === "brave") {
    return deriveBraveRateLimitCooldownSeconds(rateLimit, nowMs);
  }
  return rateLimit.retryAfterSeconds ?? parseRetryAfterSeconds(rateLimit.retryAfter, nowMs);
}

export function deriveSearchProviderCooldownUntil(params: {
  provider: SearchProviderName;
  rateLimit?: SearchProviderRateLimit;
  updatedAt?: string | null;
  nowMs?: number;
}): string | null {
  const nowMs = params.nowMs ?? Date.now();
  const updatedAtMs = params.updatedAt ? Date.parse(params.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAtMs)) return null;
  const cooldownSeconds = deriveSearchProviderCooldownSeconds(
    params.provider,
    params.rateLimit,
    updatedAtMs,
  );
  if (cooldownSeconds === undefined) return null;
  const untilMs = updatedAtMs + cooldownSeconds * 1000;
  return untilMs > nowMs ? new Date(untilMs).toISOString() : null;
}
