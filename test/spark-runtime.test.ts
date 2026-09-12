import { describe, expect, it } from "vitest";
import { sparkQuotaAvailability } from "../src/modules/codex/spark-runtime.js";
const limits = (primary: unknown, secondary: unknown) => ({
  rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 100 } },
    codex_bengalfox: { limitName: "GPT-5.3-Codex-Spark", primary, secondary },
  },
});
describe("Spark separate quota", () => {
  it("ignores exhaustion of the ordinary Codex bucket", () => {
    expect(sparkQuotaAvailability(limits({ usedPercent: 0 }, null))).toEqual({ available: true });
  });
  it("excludes Spark until every exhausted window resets", () => {
    expect(
      sparkQuotaAvailability(
        limits({ usedPercent: 100, resetsAt: 2000 }, { usedPercent: 100, resetsAt: 9000 }),
        1000,
      ),
    ).toEqual({ available: false, retryAt: 9000 });
  });
  it("does not confuse unknown quota with an exhausted bucket", () => {
    expect(() => sparkQuotaAvailability({})).toThrow("unavailable");
    expect(() => sparkQuotaAvailability(limits(null, null))).toThrow("unavailable");
  });
  it("allows Spark again when the provider reports recovered quota", () => {
    expect(sparkQuotaAvailability(limits({ usedPercent: 10 }, { usedPercent: 25 }))).toEqual({
      available: true,
    });
  });
});

it("recognizes the named bucket by its map key and returns integer reset seconds", () => {
  expect(
    sparkQuotaAvailability(
      { rateLimitsByLimitId: { codex_bengalfox: { primary: { usedPercent: 100 } } } },
      1000.2,
    ),
  ).toEqual({ available: false, retryAt: 1301 });
});
it("rejects invalid or incomplete window values without assuming quota is available", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, undefined]) {
    expect(() =>
      sparkQuotaAvailability(limits({ usedPercent: 0 }, { usedPercent: value })),
    ).toThrow("unavailable");
  }
  expect(
    sparkQuotaAvailability(limits({ usedPercent: 100, resetsAt: Number.NaN }, null), 1000),
  ).toEqual({ available: false, retryAt: 1300 });
});
