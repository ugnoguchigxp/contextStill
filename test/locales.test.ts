import { describe, expect, test } from "vitest";
import { buildInitialInstructionsText } from "../src/shared/locales/initial-instructions.js";
import { resolveLocale } from "../src/shared/locales/locale.js";

describe("locale helpers", () => {
  test("resolveLocale falls back to ja", () => {
    expect(resolveLocale(undefined)).toBe("ja");
    expect(resolveLocale("fr")).toBe("ja");
  });

  test("resolveLocale accepts ja/en and locale variants", () => {
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
  });

  test("buildInitialInstructionsText returns localized headings", () => {
    expect(buildInitialInstructionsText("ja")).toContain("## 常用ルール");
    expect(buildInitialInstructionsText("en")).toContain("## Core Rules");
  });
});
