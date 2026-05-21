import { describe, expect, test } from "vitest";
import {
  normalizeRepoPath,
  normalizeRepoKey,
  fileHintsFromInput,
  buildRetrievalQueryText,
} from "../src/modules/context-compiler/query-context.js";
import path from "node:path";

describe("Query Context Utility", () => {
  test("normalizeRepoPath handles various inputs", () => {
    expect(normalizeRepoPath("  ")).toBeUndefined();
    expect(normalizeRepoPath("/abs/path")).toBe("/abs/path");

    const rel = normalizeRepoPath("./test");
    expect(rel).toBe(path.resolve("./test").replace(/\\/g, "/"));

    expect(normalizeRepoPath("file:///tmp/test")).toBe("/tmp/test");
    // Ensure it doesn't crash on malformed URI
    expect(typeof normalizeRepoPath("file://malformed")).toBe("string");
  });

  test("normalizeRepoKey lowercases path", () => {
    expect(normalizeRepoKey("/Abs/Path")).toBe("/abs/path");
    expect(normalizeRepoKey(undefined)).toBeUndefined();
  });

  test("fileHintsFromInput extracts useful segments", () => {
    const input = { files: ["src/app/main.ts", "  ", "src/app/main.ts"] };
    const hints = fileHintsFromInput(input);

    expect(hints).toContain("src/app/main.ts");
    expect(hints).toContain("main.ts");
    expect(hints).toContain("ts");
    expect(hints).toContain("src/app");
    expect(hints.length).toBe(4); // 1 path + 1 basename + 1 ext + 1 dir
  });

  test("buildRetrievalQueryText concatenates fields", () => {
    const input = {
      goal: "fix bug",
      changeTypes: ["feat"],
      technologies: ["react"],
      domains: ["context-compiler"],
    };
    const text = buildRetrievalQueryText(input);
    expect(text).toContain("fix bug");
    expect(text).toContain("changeTypes: feat");
    expect(text).toContain("technologies: react");
    expect(text).toContain("domains: context-compiler");
  });

  test("buildRetrievalQueryText handles minimal input", () => {
    const text = buildRetrievalQueryText({ goal: "test" } as any);
    expect(text).toBe("test");
  });
});
