import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { groupedConfig } from "../src/config.js";
import { composeContextResponse } from "../src/modules/context-compiler/context-response-composer.service.js";

describe("context response composer", () => {
  const originalEnabled = groupedConfig.agenticCompile.enabled;

  beforeEach(() => {
    groupedConfig.agenticCompile.enabled = false;
  });

  afterAll(() => {
    groupedConfig.agenticCompile.enabled = originalEnabled;
  });

  test("returns No Content when no selected knowledge exists", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "HonoでAPIルートを追加する",
      },
      retrievalMode: "task_context",
      rules: [],
      procedures: [],
    });

    expect(result.markdown).toBe("No Content");
    expect(result.agenticUsed).toBe(false);
  });

  test("builds natural-language implementation context when knowledge exists", async () => {
    const result = await composeContextResponse({
      input: {
        goal: "Hono APIでcompile runs一覧にstatusフィルタを追加し、React一覧へ連動させる",
      },
      retrievalMode: "task_context",
      rules: [
        {
          id: "knowledge:r1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "HonoではzValidatorを使う",
          content: "HonoではzValidatorでqueryを検証する。",
          score: 0.9,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
      procedures: [
        {
          id: "knowledge:p1",
          itemKind: "procedure",
          itemId: "p1",
          section: "procedures",
          title: "一覧フィルタ追加手順",
          content:
            "Workflow:\n1. API query schemaにstatusを追加する。\n2. 一覧UIでstatus選択を反映する。\nVerification:\n- status変更で一覧結果が一致する。\nAvoid:\n- バリデーションなしでqueryを受け取らない。",
          score: 0.8,
          rankingReason: "ranked",
          sourceRefs: [],
        },
      ],
    });

    expect(result.agenticUsed).toBe(false);
    expect(result.markdown).toContain("## 実装フォーカス");
    expect(result.markdown).toContain("## 実装手順");
    expect(result.markdown).toContain("## 検証観点");
    expect(result.markdown).not.toContain("## Rules");
    expect(result.markdown).not.toContain("## Procedures");
  });
});
