import { describe, expect, test } from "vitest";
import {
  computeDecayFactor,
  computeDynamicScore,
} from "../src/modules/knowledge/knowledge-value.service.js";

describe("knowledge value service", () => {
  test("computeDynamicScore increases with usage signals", () => {
    const baseline = computeDynamicScore({
      compileSelectCount: 0,
      recentSelectCount30d: 0,
      agenticAcceptCount: 0,
      explicitUpvoteCount: 0,
      explicitDownvoteCount: 0,
    });
    const boosted = computeDynamicScore({
      compileSelectCount: 15,
      recentSelectCount30d: 4,
      agenticAcceptCount: 2,
      explicitUpvoteCount: 1,
      explicitDownvoteCount: 0,
    });
    expect(baseline).toBe(0);
    expect(boosted).toBeGreaterThan(baseline);
    expect(boosted).toBeLessThanOrEqual(100);
  });

  test("computeDynamicScore is reduced by downvotes", () => {
    const withoutDownvotes = computeDynamicScore({
      compileSelectCount: 10,
      recentSelectCount30d: 5,
      agenticAcceptCount: 4,
      explicitUpvoteCount: 0,
      explicitDownvoteCount: 0,
    });
    const withDownvotes = computeDynamicScore({
      compileSelectCount: 10,
      recentSelectCount30d: 5,
      agenticAcceptCount: 4,
      explicitUpvoteCount: 0,
      explicitDownvoteCount: 99,
    });
    expect(withDownvotes).toBeLessThan(withoutDownvotes);
    expect(withDownvotes).toBeGreaterThanOrEqual(0);
  });

  test("computeDynamicScore applies mild not_used penalty weaker than off_topic", () => {
    const baseline = computeDynamicScore({
      compileSelectCount: 10,
      recentSelectCount30d: 5,
      agenticAcceptCount: 4,
      explicitUpvoteCount: 0,
      explicitDownvoteCount: 0,
      usageUsedCount30d: 3,
    });
    const withNotUsed = computeDynamicScore({
      compileSelectCount: 10,
      recentSelectCount30d: 5,
      agenticAcceptCount: 4,
      explicitUpvoteCount: 0,
      explicitDownvoteCount: 0,
      usageUsedCount30d: 3,
      usageNotUsedCount30d: 5,
    });
    const withOffTopic = computeDynamicScore({
      compileSelectCount: 10,
      recentSelectCount30d: 5,
      agenticAcceptCount: 4,
      explicitUpvoteCount: 0,
      explicitDownvoteCount: 0,
      usageUsedCount30d: 3,
      usageOffTopicCount30d: 5,
    });

    expect(withNotUsed).toBeLessThan(baseline);
    expect(withOffTopic).toBeLessThan(withNotUsed);
  });

  test("computeDecayFactor decays procedure faster than rule", () => {
    const now = new Date("2026-05-16T00:00:00.000Z");
    const updatedAt = new Date("2025-11-17T00:00:00.000Z");
    const ruleDecay = computeDecayFactor({
      type: "rule",
      scope: "repo",
      lastVerifiedAt: null,
      updatedAt,
      now,
    });
    const procedureDecay = computeDecayFactor({
      type: "procedure",
      scope: "repo",
      lastVerifiedAt: null,
      updatedAt,
      now,
    });
    expect(ruleDecay).toBeGreaterThan(procedureDecay);
    expect(ruleDecay).toBeLessThan(1);
    expect(procedureDecay).toBeGreaterThan(0);
  });

  test("computeDecayFactor keeps global scope less decayed", () => {
    const now = new Date("2026-05-16T00:00:00.000Z");
    const updatedAt = new Date("2025-11-17T00:00:00.000Z");
    const repoDecay = computeDecayFactor({
      type: "procedure",
      scope: "repo",
      lastVerifiedAt: null,
      updatedAt,
      now,
    });
    const globalDecay = computeDecayFactor({
      type: "procedure",
      scope: "global",
      lastVerifiedAt: null,
      updatedAt,
      now,
    });
    expect(globalDecay).toBeGreaterThan(repoDecay);
  });
});
