import { describe, expect, test } from "vitest";
import { normalizeKnowledgeScore, toUnitKnowledgeScore } from "../src/lib/score-scale.js";

describe("Score Scale Utility", () => {
  describe("normalizeKnowledgeScore", () => {
    test("returns fallback for null/undefined/empty", () => {
      expect(normalizeKnowledgeScore(null, 50)).toBe(50);
      expect(normalizeKnowledgeScore(undefined, 50)).toBe(50);
      expect(normalizeKnowledgeScore("", 50)).toBe(50);
    });

    test("returns fallback for non-finite values", () => {
      expect(normalizeKnowledgeScore("abc", 50)).toBe(50);
      expect(normalizeKnowledgeScore(Number.NaN, 50)).toBe(50);
      expect(normalizeKnowledgeScore(Number.POSITIVE_INFINITY, 50)).toBe(50);
    });

    test("upscales fractional values (legacy compatibility)", () => {
      expect(normalizeKnowledgeScore(0.5, 0)).toBe(50);
      expect(normalizeKnowledgeScore(0.01, 0)).toBe(1);
    });

    test("clamps values between 0 and 100", () => {
      expect(normalizeKnowledgeScore(150, 0)).toBe(100);
      expect(normalizeKnowledgeScore(-10, 0)).toBe(0);
    });

    test("preserves explicit integer scores", () => {
      expect(normalizeKnowledgeScore(75, 0)).toBe(75);
    });

    test("extracts numeric values from loose string labels", () => {
      expect(normalizeKnowledgeScore("82%", 0)).toBe(82);
      expect(normalizeKnowledgeScore("confidence: 76", 0)).toBe(76);
    });
  });

  describe("toUnitKnowledgeScore", () => {
    test("converts 0-100 score to 0-1 unit scale", () => {
      expect(toUnitKnowledgeScore(50)).toBe(0.5);
      expect(toUnitKnowledgeScore(100)).toBe(1);
      expect(toUnitKnowledgeScore(0)).toBe(0);
    });

    test("handles fallback", () => {
      expect(toUnitKnowledgeScore(null, 80)).toBe(0.8);
    });
  });
});
