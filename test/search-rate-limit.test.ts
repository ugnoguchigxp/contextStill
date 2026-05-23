import { describe, expect, test } from "vitest";
import {
  deriveBraveRateLimitCooldownSeconds,
  deriveSearchProviderCooldownSeconds,
  deriveSearchProviderCooldownUntil,
  parseRetryAfterSeconds,
} from "../src/modules/distillation/search-rate-limit.js";

describe("search rate limit parsing", () => {
  test("uses the longest exhausted Brave bucket reset", () => {
    expect(
      deriveBraveRateLimitCooldownSeconds(
        {
          status: 429,
          remaining: "0, 0",
          reset: "1, 839879",
          policy: "1;w=1, 2000;w=2678400",
        },
        Date.parse("2026-05-22T06:41:59.162Z"),
      ),
    ).toBe(839879);
  });

  test("reconstructs long cooldowns from saved Brave rate-limit metadata", () => {
    expect(
      deriveSearchProviderCooldownUntil({
        provider: "brave",
        updatedAt: "2026-05-22T06:41:59.162Z",
        nowMs: Date.parse("2026-05-22T06:42:00.000Z"),
        rateLimit: {
          status: 429,
          limit: "1, 2000",
          remaining: "0, 0",
          reset: "1, 839879",
          policy: "1;w=1, 2000;w=2678400",
        },
      }),
    ).toBe("2026-05-31T23:59:58.162Z");
  });

  test("parses HTTP-date format in Retry-After header", () => {
    const nowMs = Date.parse("2026-05-23 Arrow 00:00:00.000Z");
    const testNowMs = Date.parse("2026-05-23T00:00:00.000Z");
    // Date is 120 seconds in the future
    const retryDateStr = "Sat, 23 May 2026 00:02:00 GMT";
    expect(parseRetryAfterSeconds(retryDateStr, testNowMs)).toBe(120);

    // Date is in the past
    const pastDateStr = "Fri, 22 May 2026 00:00:00 GMT";
    expect(parseRetryAfterSeconds(pastDateStr, testNowMs)).toBeUndefined();

    // Invalid format
    expect(parseRetryAfterSeconds("not-a-number-or-date", testNowMs)).toBeUndefined();
  });

  test("parses epoch timestamp in Brave reset headers", () => {
    const nowMs = 1716465600000; // 1716465600 epoch seconds
    const resetTimeSec = 1716465630; // 30 seconds in the future
    const resetTimeMsStr = String(resetTimeSec * 1000); // 13-digit epoch ms

    expect(
      deriveBraveRateLimitCooldownSeconds(
        {
          status: 429,
          remaining: "0",
          reset: String(resetTimeSec),
        },
        nowMs,
      ),
    ).toBe(30);

    // Test with 13-digit millisecond timestamp
    expect(
      deriveBraveRateLimitCooldownSeconds(
        {
          status: 429,
          remaining: "0",
          reset: resetTimeMsStr,
        },
        nowMs,
      ),
    ).toBe(30);
  });

  test("falls back to Brave reset or policy window when status is 429 but buckets are not exhausted", () => {
    expect(
      deriveBraveRateLimitCooldownSeconds({
        status: 429,
        remaining: "1, 5",
        reset: "10, 20",
      }),
    ).toBe(20);

    expect(
      deriveBraveRateLimitCooldownSeconds({
        status: 429,
        remaining: "1, 5",
        reset: "",
        policy: "1;w=15, 2000;w=45",
      }),
    ).toBe(45);
  });

  test("derives cooldown for non-Brave providers", () => {
    const cooldown = deriveSearchProviderCooldownSeconds("google" as any, {
      status: 429,
      retryAfter: "30",
    });
    expect(cooldown).toBe(30);

    expect(deriveSearchProviderCooldownSeconds("google" as any, undefined)).toBeUndefined();
  });

  test("returns null for deriveSearchProviderCooldownUntil when updatedAt is missing or invalid", () => {
    expect(
      deriveSearchProviderCooldownUntil({
        provider: "brave",
        updatedAt: null,
      }),
    ).toBeNull();

    expect(
      deriveSearchProviderCooldownUntil({
        provider: "brave",
        updatedAt: "invalid-date",
      }),
    ).toBeNull();
  });

  test("returns null for deriveSearchProviderCooldownUntil when cooldown has already expired", () => {
    const nowMs = Date.parse("2026-05-23T12:00:00.000Z");
    const updatedAt = "2026-05-23T11:59:00.000Z"; // 60 seconds ago

    expect(
      deriveSearchProviderCooldownUntil({
        provider: "google" as any,
        updatedAt,
        nowMs,
        rateLimit: {
          status: 429,
          retryAfter: "30", // expired 30 seconds ago
        },
      }),
    ).toBeNull();
  });
});
