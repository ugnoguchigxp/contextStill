import { describe, expect, test } from "vitest";
import { normalizeKnowledgeScore, toUnitKnowledgeScore } from "../src/lib/score-scale.js";

describe("score scale utilities", () => {
  test("normalizeKnowledgeScore clamps values", () => {
    expect(normalizeKnowledgeScore(150, 50)).toBe(100);
    expect(normalizeKnowledgeScore(-10, 50)).toBe(0);
  });

  test("normalizeKnowledgeScore handles invalid input with fallback", () => {
    expect(normalizeKnowledgeScore(null, 50)).toBe(50);
    expect(normalizeKnowledgeScore("invalid", 30)).toBe(30);
  });

  test("normalizeKnowledgeScore upscales fractional legacy values", () => {
    expect(normalizeKnowledgeScore(0.8, 0)).toBe(80);
    expect(normalizeKnowledgeScore(1, 0)).toBe(1);
    expect(normalizeKnowledgeScore(0, 50)).toBe(0);
  });

  test("toUnitKnowledgeScore converts to 0-1 scale", () => {
    expect(toUnitKnowledgeScore(80)).toBe(0.8);
    expect(toUnitKnowledgeScore(0.5)).toBe(0.5);
    expect(toUnitKnowledgeScore(100)).toBe(1.0);
  });
});
