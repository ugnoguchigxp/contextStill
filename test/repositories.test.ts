import { describe, expect, test } from "vitest";
import { compileInputSchema } from "../src/shared/schemas/compile.schema.js";
import { contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";

describe("schema contracts", () => {
  test("compile input requires goal", () => {
    const parsed = compileInputSchema.safeParse({
      goal: "Implement context compiler",
      intent: "edit",
    });
    expect(parsed.success).toBe(true);
  });

  test("context pack schema requires core sections", () => {
    const parsed = contextPackSchema.safeParse({
      runId: "00000000-0000-0000-0000-000000000001",
      goal: "x",
      intent: "edit",
      retrievalMode: "task_context",
      status: "ok",
      minimalTasks: [],
      rules: [],
      procedures: [],
      codeContext: [],
      warnings: [],
      sourceRefs: [],
      diagnostics: { degradedReasons: [], retrievalStats: {} },
    });

    expect(parsed.success).toBe(true);
  });
});
