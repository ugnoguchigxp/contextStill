import { describe, expect, test } from "vitest";
import { normalizeSearchApiStatus } from "../api/modules/overview/overview.repository.js";

describe("normalizeSearchApiStatus", () => {
  test("returns cooldown status when cooldownUntil is missing but rate-limit signal exists", () => {
    const status = normalizeSearchApiStatus({
      providers: {
        brave: {
          updatedAt: "2026-05-22T08:00:00.000Z",
          lastRateLimit: {
            status: 429,
          },
          lastError: "Brave search HTTP 429",
        },
      },
    });

    expect(status.brave.status).toBe("cooldown");
    expect(status.brave.cooldownUntil).toBeNull();
    expect(status.brave.lastError).toBe("Brave search HTTP 429");
  });

  test("returns ok status when cooldown is already expired", () => {
    const status = normalizeSearchApiStatus({
      providers: {
        exa: {
          cooldownUntil: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
          lastRateLimit: {
            status: 200,
          },
          lastError: null,
        },
      },
    });

    expect(status.exa.status).toBe("ok");
    expect(status.exa.cooldownUntil).toBeNull();
  });
});
