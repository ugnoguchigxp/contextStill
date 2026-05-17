import { describe, expect, test } from "vitest";
import {
  filterDistillationCandidatesByScore,
  parseDistillationCandidateList,
} from "../src/modules/distillation/distillation-candidates.js";
import { distillationToolNames } from "../src/modules/distillation/distillation-tools.service.js";

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

  test("returns empty list when no complete candidate can be recovered", () => {
    const response = `\`\`\`json
{"candidates":[{"type":"rule","title":"未完`;

    expect(parseDistillationCandidateList(response)).toEqual([]);
  });

  test("parses loose JSON-like candidate output", () => {
    const response = `
      candidates: [{
        type: 'rule',
        title: 'Gemma4 output should stay simple',
        body: 'Prefer relaxed structure and normalize it in code.',
        confidence: 81,
        importance: 76,
      }]
    `;

    const candidates = parseDistillationCandidateList(response);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "rule",
      title: "Gemma4 output should stay simple",
      confidence: 81,
      importance: 76,
    });
  });

  test("does not treat tool-call JSON as a natural-language candidate", () => {
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        name: "custom_lookup",
        arguments: { query: "example docs" },
      }),
    );

    expect(candidates).toEqual([]);
  });

  test("filters tool-call objects out of candidate arrays", () => {
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        candidates: [
          {
            function: {
              name: "custom_lookup",
              arguments: { query: "example docs" },
            },
          },
          {
            type: "rule",
            title: "Meaningful distillation output",
            body: "Distilled knowledge must preserve reusable implementation guidance, not tool names.",
            score: 1,
          },
        ],
      }),
    );

    expect(candidates.map((candidate) => candidate.title)).toEqual([
      "Meaningful distillation output",
    ]);
  });

  test("ignores loose tool-call JSON instead of falling back to title/body parsing", () => {
    const response = `
      {
        name: 'custom_lookup',
        arguments: { query: 'example docs' },
      }
    `;

    expect(parseDistillationCandidateList(response)).toEqual([]);
  });

  test("rejects tool-name-only and identical title/body candidates", () => {
    const knownToolName = distillationToolNames[0];
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: knownToolName,
            body: knownToolName,
            score: 1,
          },
          {
            type: "rule",
            title: "Meaningful distillation output",
            body: "Distilled knowledge must preserve reusable implementation guidance, not tool names.",
            score: 1,
          },
        ],
      }),
    );

    const gate = filterDistillationCandidatesByScore(candidates);

    expect(gate.accepted.map((candidate) => candidate.title)).toEqual([
      "Meaningful distillation output",
    ]);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toContain(knownToolName);
  });

  test("rejects candidates with bodies too short to be reusable knowledge", () => {
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Short body",
            body: "Too short.",
            score: 1,
          },
        ],
      }),
    );

    const gate = filterDistillationCandidatesByScore(candidates);

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toEqual(["Short body"]);
  });
});
