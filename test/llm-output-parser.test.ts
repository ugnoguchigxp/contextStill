import { describe, expect, test } from "vitest";
import { extractCompleteJsonValues, parseLlmJsonLike } from "../src/lib/llm-output-parser.js";

describe("llm-output-parser", () => {
  test("parses strict JSON directly", () => {
    expect(parseLlmJsonLike('{"selectedIds":["a"]}')?.value).toEqual({
      selectedIds: ["a"],
    });
  });

  test("repairs common LLM JSON issues before parsing", () => {
    const parsed = parseLlmJsonLike(`
      Here:
      \`\`\`json
      {
        selectedIds: ['b', 'a',],
        reasoning: 'quoted loosely',
        enabled: True,
      }
      \`\`\`
    `);

    expect(parsed?.value).toEqual({
      selectedIds: ["b", "a"],
      reasoning: "quoted loosely",
      enabled: true,
    });
    expect(parsed?.repaired).toBe(true);
  });

  test("wraps loose top-level properties", () => {
    expect(parseLlmJsonLike("selectedIds: ['2','1'], reasoning: 'ok'")?.value).toEqual({
      selectedIds: ["2", "1"],
      reasoning: "ok",
    });
  });

  test("extracts complete JSON-like values from truncated text", () => {
    const values = extractCompleteJsonValues(
      '{"type":"rule","title":"A","body":"B"},{"type":"rule","title":"unfinished"',
    );

    expect(values).toEqual(['{"type":"rule","title":"A","body":"B"}']);
  });
});
