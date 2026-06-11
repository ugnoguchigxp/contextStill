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
    expect(buildInitialInstructionsText("en")).toContain("## Operational Rules");
  });

  test("initial instructions prefer generalized bulk candidate registration", () => {
    const ja = buildInitialInstructionsText("ja");
    const en = buildInitialInstructionsText("en");

    for (const text of [ja, en]) {
      expect(text).toContain("context_decision");
      expect(text).toContain("context_decision_feedback");
      expect(text).toContain("register_candidates");
      expect(text).toContain("Use when:");
      expect(text).toContain("Workflow:");
      expect(text).toContain("Verification:");
      expect(text).toContain("Avoid:");
      expect(text).not.toContain("`register_candidate`");
      expect(text).not.toContain("`session_memo`");
    }

    expect(ja).toContain("ブロッカー由来");
    expect(ja).toContain("pre-commit");
    expect(ja).toContain("プロジェクト依存の記述を除いて");
    expect(ja).toContain("SKILL.md 相当");
    expect(en).toContain("blocker-derived");
    expect(en).toContain("pre-commit");
    expect(en).toContain("remove project-specific wording");
    expect(en).toContain("SKILL.md-like shape");
  });
});
