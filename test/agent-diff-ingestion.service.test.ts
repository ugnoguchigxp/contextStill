import { describe, expect, test } from "vitest";
import {
  extractAgentDiffContentFromText,
  stripAgentDiffContentFromText,
  parseUnifiedAgentDiffs,
  parseApplyPatchAgentDiffs,
  extractAgentDiffSymbols,
  normalizeAgentDiffEntries,
} from "../src/modules/vibe-memory/agent-diff-ingestion.service.js";

describe("Agent Diff Ingestion Service", () => {
  describe("extractAgentDiffContentFromText", () => {
    test("extracts fenced diff blocks", () => {
      const text =
        "Some notes\n```diff\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n```";
      const extracted = extractAgentDiffContentFromText(text);
      expect(extracted).toContain("--- a/file.ts");
    });

    test("extracts raw git diff blocks", () => {
      const text =
        "Context\ndiff --git a/file.ts b/file.ts\nindex 123..456\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n\nUSER: Next message";
      const extracted = extractAgentDiffContentFromText(text);
      expect(extracted).toContain("diff --git a/file.ts");
      expect(extracted).not.toContain("USER:");
    });

    test("extracts Begin Patch blocks", () => {
      const text = "Context\n*** Begin Patch\n*** Add File: test.ts\n+content\n*** End Patch";
      const extracted = extractAgentDiffContentFromText(text);
      expect(extracted).toContain("*** Add File: test.ts");
    });
  });

  describe("stripAgentDiffContentFromText", () => {
    test("removes diff content and leaves clean text", () => {
      const text =
        "Main thoughts\n```diff\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n```\nFinal thoughts";
      const stripped = stripAgentDiffContentFromText(text);
      expect(stripped).toBe("Main thoughts\n\nFinal thoughts");
    });
  });

  describe("parseUnifiedAgentDiffs", () => {
    test("parses add and modify diffs", () => {
      const diff = [
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1 @@",
        "+const x = 1;",
        "diff --git a/old.ts b/old.ts",
        "--- a/old.ts",
        "+++ b/old.ts",
        "@@ -1 +1 @@",
        "-const x = 0;",
        "+const x = 2;",
      ].join("\n");

      const parsed = parseUnifiedAgentDiffs(diff);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].changeType).toBe("add");
      expect(parsed[1].changeType).toBe("modify");
      expect(parsed[0].newContent).toBe("const x = 1;");
    });
  });

  describe("extractAgentDiffSymbols", () => {
    test("extracts various symbols from TS content", () => {
      const content = `
        export interface User { id: string; }
        export enum Status { Active, Inactive }
        type ID = string;
        export function foo() { return 1; }
        class Bar { 
          baz() { return 2; }
        }
        const x = 1, y = 2;
      `;
      const symbols = extractAgentDiffSymbols({ filePath: "test.ts", content });
      const names = symbols.map((s) => s.symbolName);
      expect(names).toContain("User");
      expect(names).toContain("Status");
      expect(names).toContain("ID");
      expect(names).toContain("foo");
      expect(names).toContain("Bar");
      expect(names).toContain("baz");
      expect(names).toContain("x");
      expect(names).toContain("y");
    });
  });

  describe("normalizeAgentDiffEntries", () => {
    test("merges parsed diffs with symbols", () => {
      const diff = [
        "--- a/test.ts",
        "+++ b/test.ts",
        "@@ -1 +1,3 @@",
        " export function test() {",
        "+  return true;",
        " }",
      ].join("\n");

      const entries = normalizeAgentDiffEntries({ diff });
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].symbolName).toBe("test");
      expect(entries[0].changeType).toBe("modify");
    });
  });
});
