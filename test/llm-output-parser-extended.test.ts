import { describe, expect, it } from "vitest";
import { extractCompleteJsonValues, parseLlmJsonLike } from "../src/lib/llm-output-parser.js";

describe("llm-output-parser extended", () => {
  describe("parseLlmJsonLike", () => {
    it("parses JSON inside markdown blocks", () => {
      const text = '```json\n{"key": "value"}\n```';
      const result = parseLlmJsonLike(text);
      expect(result?.value).toEqual({ key: "value" });
      expect(result?.strategy).toBe("json");
    });

    it("parses JSON from raw text", () => {
      const result = parseLlmJsonLike('{"a": 1}');
      expect(result?.value).toEqual({ a: 1 });
    });

    it("returns null for invalid JSON", () => {
      expect(parseLlmJsonLike("{invalid}")).toBeNull();
    });

    it("repairs trailing commas", () => {
      const text = '{"a": 1,}';
      const result = parseLlmJsonLike(text);
      expect(result?.value).toEqual({ a: 1 });
      expect(result?.strategy).toBe("json_repaired");
    });

    it("repairs single quotes", () => {
      const text = "{'a': 'b'}";
      const result = parseLlmJsonLike(text);
      expect(result?.value).toEqual({ a: "b" });
      expect(result?.strategy).toBe("json_repaired");
    });

    it("repairs bare keys", () => {
      const text = '{key: "value"}';
      const result = parseLlmJsonLike(text);
      expect(result?.value).toEqual({ key: "value" });
      expect(result?.strategy).toBe("json_repaired");
    });
  });

  describe("extractCompleteJsonValues", () => {
    it("extracts multiple objects from text", () => {
      const text = 'here is one: {"a": 1} and another: [2, 3]';
      expect(extractCompleteJsonValues(text)).toEqual(['{"a": 1}', "[2, 3]"]);
    });
  });
});
