import { describe, expect, test } from "vitest";
import {
  validateDistillationCandidates,
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

  test("parses confidence and importance from labeled natural-language output", () => {
    const candidates = parseDistillationCandidateList(`
TYPE: rule
TITLE: Evidence-backed distillation scoring
BODY: Distilled knowledge must include separate confidence and importance values so review can distinguish certainty from reuse value.
自信度: 82%
重要度: 74
`);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      title: "Evidence-backed distillation scoring",
      confidence: 82,
      importance: 74,
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
            confidence: 82,
            importance: 78,
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
          },
          {
            type: "rule",
            title: "Meaningful distillation output",
            body: "Distilled knowledge must preserve reusable implementation guidance, not tool names.",
            confidence: 82,
            importance: 78,
          },
        ],
      }),
    );

    const gate = validateDistillationCandidates(candidates);

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
          },
        ],
      }),
    );

    const gate = validateDistillationCandidates(candidates);

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toEqual(["Short body"]);
  });

  test("rejects otherwise valid candidates when confidence or importance is missing", () => {
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Missing evaluation labels",
            body: "Distilled knowledge must include confidence and importance values so fallback defaults do not look like LLM scoring.",
          },
        ],
      }),
    );

    const gate = validateDistillationCandidates(candidates);

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toEqual([
      "Missing evaluation labels",
    ]);
  });

  test("rejects candidates below the minimum importance threshold", () => {
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Low importance candidate",
            body: "This candidate is well-formed but not important enough to become reusable knowledge.",
            confidence: 92,
            importance: 59,
          },
        ],
      }),
    );

    const gate = validateDistillationCandidates(candidates);

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toEqual([
      "Low importance candidate",
    ]);
  });

  test("rejects natural-language template headings as candidate content", () => {
    const candidates = parseDistillationCandidateList(`
TYPE / TITLE / BODY
rule
The Too many open files error occurs when a process leaks file descriptors and should be handled by closing resources deterministically.
`);

    const gate = validateDistillationCandidates(candidates);

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toEqual(["rule"]);
  });

  test("keeps labeled natural-language candidates after an accidental heading line", () => {
    const candidates = parseDistillationCandidateList(`
TYPE / TITLE / BODY
TYPE: rule
TITLE: SQLite connection lifecycle
BODY: Database connections opened during background processing must be closed deterministically so repeated jobs do not leak descriptors.
CONFIDENCE: 84
IMPORTANCE: 78
`);

    const gate = validateDistillationCandidates(candidates);

    expect(gate.accepted.map((candidate) => candidate.title)).toEqual([
      "SQLite connection lifecycle",
    ]);
  });

  test("rejects object candidates that keep a format heading as title", () => {
    const candidates = parseDistillationCandidateList(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "TYPE / TITLE / BODY",
            body: "rule\nDatabase connections opened during background processing must be closed deterministically so repeated jobs do not leak descriptors.",
          },
        ],
      }),
    );

    const gate = validateDistillationCandidates(candidates);

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedLowQuality.map((candidate) => candidate.title)).toEqual([
      "TYPE / TITLE / BODY",
    ]);
  });
});
