import { describe, expect, test } from "bun:test";
import {
  extractAgentDiffSymbols,
  normalizeAgentDiffEntries,
  parseUnifiedAgentDiffs,
} from "../src/modules/vibe-memory/agent-diff-ingestion.service.js";

const diff = `diff --git a/src/math.ts b/src/math.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/math.ts
@@ -0,0 +1,12 @@
+export function add(a: number, b: number): number {
+  return a + b;
+}
+
+export class Calculator {
+  multiply(a: number, b: number): number {
+    return a * b;
+  }
+}
+
+export const answer = 42;
`;

describe("agent diff ingestion", () => {
  test("parseUnifiedAgentDiffs splits unified diff into file diff entries", () => {
    const entries = parseUnifiedAgentDiffs(diff);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.filePath).toBe("src/math.ts");
    expect(entries[0]?.changeType).toBe("add");
    expect(entries[0]?.language).toBe("typescript");
    expect(entries[0]?.diffHunk).toContain("diff --git");
  });

  test("extractAgentDiffSymbols captures names and line ranges without persisted content", () => {
    const [entry] = parseUnifiedAgentDiffs(diff);
    const symbols = extractAgentDiffSymbols({
      filePath: entry?.filePath ?? "src/math.ts",
      content: entry?.newContent ?? "",
    });

    const add = symbols.find((symbol) => symbol.symbolName === "add");
    const calculator = symbols.find((symbol) => symbol.symbolName === "Calculator");
    const answer = symbols.find((symbol) => symbol.symbolName === "answer");

    expect(add?.symbolKind).toBe("function");
    expect(add?.startLine).toBe(1);
    expect(add?.endLine).toBe(3);
    expect(add?.signature).toContain("export function add");
    expect(calculator?.symbolKind).toBe("class");
    expect(answer?.symbolKind).toBe("variable");
  });

  test("normalizeAgentDiffEntries merges top-level diff and explicit diff entries", () => {
    const entries = normalizeAgentDiffEntries({
      diff,
      agentDiffs: [
        {
          filePath: "src/math.ts",
          diffHunk:
            "@@ -1,0 +1,3 @@\n+export function subtract(a: number, b: number) {\n+  return a - b;\n+}",
          symbolName: "subtract",
          symbolKind: "function",
          startLine: 1,
          endLine: 3,
          metadata: { origin: "explicit" },
        },
      ],
    });

    expect(entries.some((entry) => entry.symbolName === "add")).toBe(true);
    const subtract = entries.find((entry) => entry.symbolName === "subtract");
    expect(subtract?.diffHunk).toContain("subtract");
    expect(subtract?.metadata.origin).toBe("explicit");
  });
});
