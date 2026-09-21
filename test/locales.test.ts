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

  test("initial instructions emphasize primary tools over supplemental tools", () => {
    const ja = buildInitialInstructionsText("ja");
    const en = buildInitialInstructionsText("en");

    for (const text of [ja, en]) {
      expect(text).toContain("initial_instructions");
      expect(text).toContain("context_compile");
      expect(text).toContain("compile_eval");
      expect(text).not.toContain("context_decision");
      expect(text).not.toContain("context_decision_feedback");
      expect(text).not.toContain("`register_candidates`");
      expect(text).not.toContain("`register_candidate`");
      expect(text).not.toContain("`session_memo`");
      expect(text).not.toContain("Use when:");
      expect(text).not.toContain("Workflow:");
      expect(text).not.toContain("Verification:");
      expect(text).not.toContain("Avoid:");
    }

    expect(ja).toContain("## 主要MCPツール");
    expect(ja).toContain("Planでも実装判断でもない単純な単タスクでは `context_compile` を省略");
    expect(ja).toContain("Planまたは実装判断を伴うタスクでは");
    expect(ja).toContain("関連する設計書を先に読み");
    expect(ja).toContain("対象がどのような実装かを確認してから `context_compile`");
    expect(ja).toContain("## SAAA・エージェントからの検索");
    expect(ja).toContain("`search_knowledge`: 特定の制約・ルール・再利用可能な手順");
    expect(ja).toContain("`search_episodes`: 類似した過去事例、その結果、教訓");
    expect(ja).toContain("最終判断はSAAAなどの呼出し元が行う");
    expect(ja).toContain("生の会話やユーザー事実はSAAA側のMemory");
    expect(ja).toContain("その他の公開ツールは補助機能");
    expect(ja).not.toContain("プロジェクト依存の記述を除いて");
    expect(ja).not.toContain("title / body / avoid / prefer の自然文は日本語");
    expect(ja).not.toContain("SKILL.md 相当");
    expect(en).toContain("## Primary MCP Tools");
    expect(en).toContain("neither planning nor implementation decisions");
    expect(en).toContain("For planning or tasks that require implementation decisions");
    expect(en).toContain("first read the relevant design documents");
    expect(en).toContain("confirm how the target is implemented, then call `context_compile`");
    expect(en).toContain("## Search from SAAA or Other Agents");
    expect(en).toContain("`search_knowledge`: Use it to directly find a specific constraint");
    expect(en).toContain("`search_episodes`: Use it to find similar past precedents");
    expect(en).toContain("The caller, such as SAAA, makes the final judgment");
    expect(en).toContain("Raw conversations and user facts belong in SAAA-owned memory");
    expect(en).toContain("Other exposed tools are supplemental");
    expect(en).not.toContain("remove project-specific wording");
    expect(en).not.toContain("title / body / avoid / prefer natural language in Japanese");
    expect(en).not.toContain("SKILL.md-like shape");
  });
});
