import { describe, expect, test } from "bun:test";
import {
  extractArtifactSymbols,
  normalizeActivityArtifacts,
  parseUnifiedDiffArtifacts,
} from "../src/modules/activity/artifact-ingestion.service.js";

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

describe("activity artifact ingestion", () => {
  test("parseUnifiedDiffArtifacts splits unified diff into file artifacts", () => {
    const artifacts = parseUnifiedDiffArtifacts(diff);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.filePath).toBe("src/math.ts");
    expect(artifacts[0]?.language).toBe("typescript");
    expect(artifacts[0]?.content).toContain("export function add");
    expect(artifacts[0]?.diff).toContain("diff --git");
  });

  test("extractArtifactSymbols captures names, content, and line ranges", () => {
    const [artifact] = parseUnifiedDiffArtifacts(diff);
    const symbols = extractArtifactSymbols({
      filePath: artifact?.filePath ?? "src/math.ts",
      content: artifact?.content ?? "",
    });

    const add = symbols.find((symbol) => symbol.symbolName === "add");
    const calculator = symbols.find((symbol) => symbol.symbolName === "Calculator");
    const answer = symbols.find((symbol) => symbol.symbolName === "answer");

    expect(add?.symbolKind).toBe("function");
    expect(add?.startLine).toBe(1);
    expect(add?.endLine).toBe(3);
    expect(add?.content).toContain("return a + b");
    expect(calculator?.symbolKind).toBe("class");
    expect(answer?.symbolKind).toBe("variable");
  });

  test("normalizeActivityArtifacts merges top-level diff and explicit artifacts", () => {
    const artifacts = normalizeActivityArtifacts({
      diff,
      artifacts: [
        {
          filePath: "src/math.ts",
          content: "export function subtract(a: number, b: number) {\n  return a - b;\n}\n",
          metadata: { origin: "explicit" },
          symbols: [],
        },
      ],
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content).toContain("subtract");
    expect(artifacts[0]?.diff).toContain("diff --git");
    expect(artifacts[0]?.metadata.origin).toBe("explicit");
    expect(artifacts[0]?.symbols.some((symbol) => symbol.symbolName === "subtract")).toBe(true);
  });
});
