import { describe, expect, test } from "vitest";
import { parseDistillationCandidateList } from "../src/modules/distillation/distillation-candidates.js";

describe("parseDistillationCandidateList", () => {
  test("recovers complete candidates from truncated JSON output", () => {
    const response = `\`\`\`json
{
  "candidates": [
    {
      "type": "procedure",
      "title": "表示フィールド決定ロジックの更新",
      "body": "displayField は displayFieldForTable(columns) で動的決定する。",
      "confidence": 92,
      "importance": 88,
      "score": 0.9,
      "sourceRefs": [
        "file: /Users/y.noguchi/Code/composia-ui/api/modules/database-design/database-design.provider.ts"
      ]
    },
    {
      "type": "procedure",
      "title": "データベース設計スキーマの正規化と`;

    const candidates = parseDistillationCandidateList(response);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe("表示フィールド決定ロジックの更新");
    expect(candidates[0]?.score).toBe(0.9);
  });

  test("throws when no complete candidate can be recovered", () => {
    const response = `\`\`\`json
{"candidates":[{"type":"rule","title":"未完`;

    expect(() => parseDistillationCandidateList(response)).toThrow(
      "distillation response did not contain valid JSON",
    );
  });
});
