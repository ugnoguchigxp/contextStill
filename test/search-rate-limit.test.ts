import { describe, expect, test } from "vitest";
import {
  deriveBraveRateLimitCooldownSeconds,
  deriveSearchProviderCooldownUntil,
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
});
