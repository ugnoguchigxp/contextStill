import { describe, expect, test } from "vitest";
import { normalizeKnowledgeScore, toUnitKnowledgeScore } from "../src/lib/score-scale.js";
import { renderContextPackMarkdown } from "../src/modules/context-compiler/pack-renderer.js";
import { normalizeRepoPath } from "../src/modules/context-compiler/query-context.js";
import { rankAndDedupe } from "../src/modules/context-compiler/ranking.service.js";

describe("context compiler helpers", () => {
  test("rankAndDedupe keeps highest score per id", () => {
    const ranked = rankAndDedupe(
      [
        { id: "a", title: "A1", content: "x", score: 0.3, confidence: 50, importance: 50 },
        { id: "a", title: "A2", content: "x", score: 0.7, confidence: 50, importance: 50 },
        { id: "b", title: "B", content: "x", score: 0.6, confidence: 50, importance: 50 },
      ],
      10,
    );

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.id).toBe("a");
    expect(ranked[1]?.id).toBe("b");
  });

  test("rankAndDedupe applies penalties and boosts", () => {
    const items = [
      {
        id: "active",
        title: "A",
        content: "x",
        score: 0.5,
        status: "active",
        hasSourceLinks: true,
      },
      { id: "deprecated", title: "D", content: "x", score: 0.9, status: "deprecated" },
      { id: "stale", title: "S", content: "x", score: 0.9, stale: true },
    ];
    const ranked = rankAndDedupe(items, 10);
    expect(ranked[0].id).toBe("active"); // 0.5 + 0.05 vs 0.9 - 0.5 vs 0.9 - 0.4
  });

  test("rankAndDedupe falls back to sourceRefCount and raw score", () => {
    const items = [
      { id: "low-ref", title: "L", content: "x", score: 0.5, sourceRefCount: 1 },
      { id: "high-ref", title: "H", content: "x", score: 0.5, sourceRefCount: 5 },
      { id: "high-score", title: "S", content: "x", score: 0.6, sourceRefCount: 0 },
    ];
    const ranked = rankAndDedupe(items, 10);
    expect(ranked[0].id).toBe("high-score"); // 0.6 beats 0.5 + 0.05 boost
  });

  test("rankAndDedupe tie-breaking logic", () => {
    const items = [
      { id: "b", title: "T1", content: "x", score: 0.5, sourceRefCount: 2 },
      { id: "a", title: "T2", content: "x", score: 0.5, sourceRefCount: 2 },
    ];
    const ranked = rankAndDedupe(items, 10);
    expect(ranked[0].id).toBe("a"); // localeCompare fallback
  });

  test("rankAndDedupe treats legacy unit-scale quality and 100-scale quality consistently", () => {
    const ranked = rankAndDedupe(
      [
        {
          id: "legacy",
          title: "Legacy",
          content: "x",
          score: 0.4,
          confidence: 0.9,
          importance: 0.9,
        },
        { id: "modern", title: "Modern", content: "x", score: 0.4, confidence: 90, importance: 90 },
        { id: "low", title: "Low", content: "x", score: 0.45, confidence: 20, importance: 20 },
      ],
      10,
    );

    expect(ranked.map((item) => item.id).slice(0, 2)).toEqual(["legacy", "modern"]);
  });

  test("pack renderer emits markdown sections", () => {
    const markdown = renderContextPackMarkdown({
      runId: "00000000-0000-0000-0000-000000000001",
      goal: "test",
      retrievalMode: "task_context",
      status: "ok",
      minimalTasks: ["one"],
      rules: [],
      procedures: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: { degradedReasons: [], retrievalStats: {} },
    });

    expect(markdown).toBe("No Content");
  });

  test("normalizeRepoPath resolves file URI input", () => {
    expect(normalizeRepoPath("file:///tmp/repo-a")).toBe("/tmp/repo-a");
  });

  test("knowledge score normalization keeps 1 as 1% while supporting legacy decimals", () => {
    expect(normalizeKnowledgeScore(0.7, 70)).toBeCloseTo(70);
    expect(normalizeKnowledgeScore(70, 10)).toBe(70);
    expect(normalizeKnowledgeScore(1, 70)).toBe(1);
    expect(normalizeKnowledgeScore(undefined, 65)).toBe(65);
    expect(normalizeKnowledgeScore(-10, 65)).toBe(0);
    expect(normalizeKnowledgeScore(120, 65)).toBe(100);
    expect(toUnitKnowledgeScore(0.7, 70)).toBeCloseTo(0.7);
    expect(toUnitKnowledgeScore(70, 70)).toBeCloseTo(0.7);
    expect(toUnitKnowledgeScore(1, 70)).toBeCloseTo(0.01);
  });
});
