import { describe, expect, test } from "vitest";
import {
  extractAgentDiffContentFromText,
  extractAgentDiffSymbols,
  normalizeAgentDiffEntries,
  parseApplyPatchAgentDiffs,
  parseUnifiedAgentDiffs,
  stripAgentDiffContentFromText,
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

  test("parseApplyPatchAgentDiffs extracts file and symbols from apply_patch input", () => {
    const patch = `*** Begin Patch
*** Add File: src/hello.ts
+export function hello(name: string): string {
+  return \`hello \${name}\`;
+}
*** End Patch`;

    const fileDiffs = parseApplyPatchAgentDiffs(patch);
    expect(fileDiffs).toHaveLength(1);
    expect(fileDiffs[0]?.filePath).toBe("src/hello.ts");
    expect(fileDiffs[0]?.changeType).toBe("add");

    const entries = normalizeAgentDiffEntries({ diff: patch });
    expect(entries.some((entry) => entry.symbolName === "hello")).toBe(true);
    expect(entries[0]?.metadata.source).toBe("apply_patch");
  });

  test("extractAgentDiffContentFromText pulls diff blocks from mixed chat text", () => {
    const mixed = `実装しました。

\`\`\`diff
${diff}
\`\`\`

確認してください。`;

    const extracted = extractAgentDiffContentFromText(mixed);
    expect(extracted).toContain("diff --git");
    expect(extracted).toContain("src/math.ts");
  });

  test("stripAgentDiffContentFromText removes diff blocks but keeps natural chat", () => {
    const stripped = stripAgentDiffContentFromText(`実装しました。

\`\`\`diff
${diff}
\`\`\`

確認してください。`);

    expect(stripped).toBe("実装しました。\n\n確認してください。");
    expect(stripped).not.toContain("diff --git");
  });

  test("extractAgentDiffSymbols captures interface and enum", () => {
    const content = `
      export interface User { id: string; name: string; }
      export enum Status { Active, Inactive }
    `;
    const symbols = extractAgentDiffSymbols({ filePath: "types.ts", content });
    expect(symbols.some((s) => s.symbolName === "User" && s.symbolKind === "interface")).toBe(true);
    expect(symbols.some((s) => s.symbolName === "Status" && s.symbolKind === "enum")).toBe(true);
  });

  test("parseUnifiedAgentDiffs handles deleted file", () => {
    const deleteDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-old content`;
    const entries = parseUnifiedAgentDiffs(deleteDiff);
    expect(entries[0].changeType).toBe("delete");
    expect(entries[0].filePath).toBe("old.ts");
  });

  test("parseUnifiedAgentDiffs handles /dev/null for new files", () => {
    const newDiff = `--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+new content`;
    const entries = parseUnifiedAgentDiffs(newDiff);
    expect(entries[0].changeType).toBe("add");
    expect(entries[0].filePath).toBe("new.ts");
  });
});
