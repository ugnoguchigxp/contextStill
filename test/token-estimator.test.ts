import { describe, expect, test } from "vitest";
import { estimateLlmUsage, estimateTextTokens } from "../src/modules/llm/token-estimator.js";

describe("token-estimator", () => {
  describe("estimateTextTokens", () => {
    test("handles null and undefined", () => {
      expect(estimateTextTokens(null)).toBe(0);
      expect(estimateTextTokens(undefined)).toBe(0);
    });

    test("handles strings", () => {
      expect(estimateTextTokens("hello")).toBe(2);
      expect(estimateTextTokens("")).toBe(0);
    });

    test("handles CJK text", () => {
      // CJK characters count as 1 token each
      expect(estimateTextTokens("日本語")).toBe(3);
    });

    test("handles normal objects via stringify", () => {
      expect(estimateTextTokens({ foo: "bar" })).toBeGreaterThan(0);
    });

    test("handles circular reference objects by falling back to String()", () => {
      const circular: any = {};
      circular.self = circular;
      expect(estimateTextTokens(circular)).toBeGreaterThan(0);
    });
  });

  describe("estimateLlmUsage", () => {
    test("returns null when prompt and completion are empty", () => {
      expect(estimateLlmUsage({})).toBeNull();
    });

    test("estimates usage with promptMessages and completionText", () => {
      const usage = estimateLlmUsage({
        promptMessages: [{ role: "user", content: "hello" }, "non-object-message"],
        completionText: "response",
      });

      expect(usage).not.toBeNull();
      if (usage) {
        expect(usage.promptTokens).toBeGreaterThan(0);
        expect(usage.completionTokens).toBeGreaterThan(0);
        expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
      }
    });

    test("estimates usage with promptMetadata and completionMetadata", () => {
      const usage = estimateLlmUsage({
        promptMetadata: "metadata prompt",
        completionMetadata: "metadata completion",
      });

      expect(usage).not.toBeNull();
      if (usage) {
        expect(usage.promptTokens).toBeGreaterThan(0);
        expect(usage.completionTokens).toBeGreaterThan(0);
        expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
      }
    });
  });
});
