import { describe, expect, it } from "vitest";
import { normalizeDistillationSearchQuery } from "../src/modules/distillation/search-providers.js";

describe("search-providers normalizeDistillationSearchQuery", () => {
  it("normalizes queries using NFKC format", () => {
    // 全角英数字や全角スペースの正規化を検証
    const input = "Ｍｅｍｏｒｙ　Ｒｏｕｔｅｒ　　Ｔｅｓｔ";
    const expected = "memory router test";
    expect(normalizeDistillationSearchQuery(input)).toBe(expected);
  });

  it("trims external whitespace and compacts inner spaces", () => {
    expect(normalizeDistillationSearchQuery("   multiple     spaces   ")).toBe("multiple spaces");
    expect(normalizeDistillationSearchQuery("\tnew\nline\t")).toBe("new line");
  });

  it("converts all characters to lowercase", () => {
    expect(normalizeDistillationSearchQuery("TypeScript AND Vitest")).toBe("typescript and vitest");
  });

  it("returns empty string if query is just empty or whitespace", () => {
    expect(normalizeDistillationSearchQuery("   ")).toBe("");
    expect(normalizeDistillationSearchQuery("")).toBe("");
  });
});
