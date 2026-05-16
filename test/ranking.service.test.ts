import { describe, expect, test } from "vitest";
import { rankAndDedupe } from "../src/modules/context-compiler/ranking.service.js";

describe("Ranking Service", () => {
  test("ranks items by weighted score", () => {
    const items = [
      { id: "1", title: "Low", content: "", score: 0.1 },
      { id: "2", title: "High", content: "", score: 0.9 },
    ];
    const result = rankAndDedupe(items, 10);
    expect(result[0].id).toBe("2");
    expect(result[1].id).toBe("1");
  });

  test("applies importance and confidence boosts", () => {
    const items = [
      { id: "1", title: "Base", content: "", score: 0.5 },
      { id: "2", title: "Boosted", content: "", score: 0.5, importance: 100, confidence: 100 },
    ];
    const result = rankAndDedupe(items, 10);
    expect(result[0].id).toBe("2");
  });

  test("applies dynamic score boost when relevance is similar", () => {
    const items = [
      { id: "1", title: "Static", content: "", score: 0.6, dynamicScore: 0 },
      { id: "2", title: "Used", content: "", score: 0.6, dynamicScore: 90 },
    ];
    const result = rankAndDedupe(items, 10);
    expect(result[0].id).toBe("2");
  });

  test("applies decay penalty when relevance is similar", () => {
    const items = [
      { id: "1", title: "Fresh", content: "", score: 0.6, decayFactor: 1 },
      { id: "2", title: "Old", content: "", score: 0.6, decayFactor: 0.2 },
    ];
    const result = rankAndDedupe(items, 10);
    expect(result[0].id).toBe("1");
  });

  test("applies penalties for deprecated and stale items", () => {
    const items = [
      { id: "1", title: "Deprecated", content: "", score: 0.9, status: "deprecated" },
      { id: "2", title: "Stale", content: "", score: 0.9, stale: true },
      { id: "3", title: "Active", content: "", score: 0.5 },
    ];
    // Deprecated penalty: 0.5, Stale penalty: 0.4
    // 1: 0.9 - 0.5 = 0.4
    // 2: 0.9 - 0.4 = 0.5
    // 3: 0.5
    const result = rankAndDedupe(items, 10);
    expect(result[0].id).toBe("2"); // 0.5
    expect(result[1].id).toBe("3"); // 0.5 (Tied with 2, but 2 has higher raw score)
    expect(result[2].id).toBe("1"); // 0.4
  });

  test("resolves ties using sourceRefCount, raw score, and ID", () => {
    const items = [
      { id: "b", title: "Tied", content: "", score: 0.5 },
      { id: "a", title: "Tied", content: "", score: 0.5 },
      { id: "c", title: "Tied Ref", content: "", score: 0.5, sourceRefCount: 5 },
      { id: "d", title: "Tied Raw", content: "", score: 0.6, stale: true }, // 0.6 - 0.4 = 0.2 (Low)
    ];
    const result = rankAndDedupe(items, 10);
    expect(result[0].id).toBe("c"); // Source ref boost + tied logic
    expect(result[1].id).toBe("a"); // ID "a" before "b"
    expect(result[2].id).toBe("b");
  });

  test("deduplicates items by ID, keeping the highest weighted score", () => {
    const items = [
      { id: "k1", title: "Low", content: "", score: 0.1 },
      { id: "k1", title: "High", content: "", score: 0.9 },
    ];
    const result = rankAndDedupe(items, 10);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.9);
  });
});
