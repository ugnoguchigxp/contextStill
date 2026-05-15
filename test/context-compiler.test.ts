import { describe, expect, test } from "bun:test";
import { renderContextPackMarkdown } from "../src/modules/context-compiler/pack-renderer.js";
import { rankAndDedupe } from "../src/modules/context-compiler/ranking.service.js";

describe("context compiler helpers", () => {
  test("rankAndDedupe keeps highest score per id", () => {
    const ranked = rankAndDedupe(
      [
        { id: "a", title: "A1", content: "x", score: 0.3, confidence: 0.5, importance: 0.5 },
        { id: "a", title: "A2", content: "x", score: 0.7, confidence: 0.5, importance: 0.5 },
        { id: "b", title: "B", content: "x", score: 0.6, confidence: 0.5, importance: 0.5 },
      ],
      10,
    );

    expect(ranked).toHaveLength(2);
    expect(ranked[0]?.id).toBe("a");
    expect(ranked[1]?.id).toBe("b");
  });

  test("pack renderer emits markdown sections", () => {
    const markdown = renderContextPackMarkdown({
      runId: "00000000-0000-0000-0000-000000000001",
      goal: "test",
      intent: "edit",
      retrievalMode: "task_context",
      status: "ok",
      minimalTasks: ["one"],
      rules: [],
      procedures: [],
      codeContext: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: { degradedReasons: [], retrievalStats: {} },
    });

    expect(markdown.includes("# Context Pack")).toBe(true);
    expect(markdown.includes("## Rules")).toBe(true);
  });
});
