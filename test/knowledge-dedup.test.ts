import { describe, expect, it, vi } from "vitest";
import { calculateBigramSimilarity, checkKnowledgeDuplicate } from "../src/lib/knowledge-dedup.js";
import * as embeddingService from "../src/modules/embedding/embedding.service.js";
import * as knowledgeRepository from "../src/modules/knowledge/knowledge.repository.js";

vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/knowledge/knowledge.repository.js");

describe("knowledge-dedup logic", () => {
  describe("calculateBigramSimilarity", () => {
    it("returns 1 for exact match", () => {
      expect(calculateBigramSimilarity("hello world", "hello world")).toBe(1);
    });

    it("is case insensitive and ignores spaces", () => {
      expect(calculateBigramSimilarity("Hello World", "helloworld")).toBe(1);
    });

    it("returns 0 for completely different text", () => {
      expect(calculateBigramSimilarity("abc", "xyz")).toBe(0);
    });

    it("handles empty strings", () => {
      expect(calculateBigramSimilarity("", "")).toBe(1);
      expect(calculateBigramSimilarity("a", "")).toBe(0);
      expect(calculateBigramSimilarity("", "b")).toBe(0);
    });

    it("handles very short strings (less than 2 chars)", () => {
      expect(calculateBigramSimilarity("a", "a")).toBe(1);
      expect(calculateBigramSimilarity("a", "b")).toBe(0);
    });

    it("calculates partial similarity correctly", () => {
      // "night" -> ni, ig, gh, ht (4 bigrams)
      // "nacht" -> na, ac, ch, ht (4 bigrams)
      // intersection: ht (1 bigram)
      // Dice: 2 * 1 / (4 + 4) = 0.25
      expect(calculateBigramSimilarity("night", "nacht")).toBe(0.25);
    });
  });

  describe("checkKnowledgeDuplicate", () => {
    it("returns isDuplicate: true when body similarity exceeds threshold", async () => {
      vi.mocked(embeddingService.embedOne).mockResolvedValue([0.1, 0.2]);
      vi.mocked(knowledgeRepository.vectorSearchKnowledge).mockResolvedValue([
        {
          id: "existing-1",
          title: "Existing Title",
          body: "This is exactly the same body text.",
          status: "active",
          sourceUri: "test://1",
          distillationVersion: "1",
          createdAt: new Date(),
          updatedAt: new Date(),
          metadata: {},
          priorityGroup: "wiki",
          sortKey: "test",
          vectorSimilarity: 0.99,
        } as any,
      ]);

      const result = await checkKnowledgeDuplicate(
        "New Title",
        "This is exactly the same body text.",
      );

      expect(result.isDuplicate).toBe(true);
      if (result.isDuplicate) {
        expect(result.existingId).toBe("existing-1");
        expect(result.reason).toContain("body_bigram");
      }
    });

    it("returns isDuplicate: false when no candidates found", async () => {
      vi.mocked(embeddingService.embedOne).mockResolvedValue([0.1, 0.2]);
      vi.mocked(knowledgeRepository.vectorSearchKnowledge).mockResolvedValue([]);

      const result = await checkKnowledgeDuplicate("Title", "Body text");
      expect(result.isDuplicate).toBe(false);
    });

    it("returns isDuplicate: false when embedding fails", async () => {
      vi.mocked(embeddingService.embedOne).mockRejectedValue(new Error("API Error"));

      const result = await checkKnowledgeDuplicate("Title", "Body");
      expect(result.isDuplicate).toBe(false);
    });

    it("handles short body complementary title check", async () => {
      vi.mocked(embeddingService.embedOne).mockResolvedValue([0.1, 0.2]);
      vi.mocked(knowledgeRepository.vectorSearchKnowledge).mockResolvedValue([
        {
          id: "existing-2",
          title: "Match Title",
          body: "Partial match body",
          status: "active",
        } as any,
      ]);

      // bodySimilarity will be low, but if title matches and body is short...
      const result = await checkKnowledgeDuplicate(
        "Match Title",
        "Partial match body", // short body (< 200 chars)
        { bodySimilarityThreshold: 0.99, titleSimilarityThreshold: 0.9 },
      );

      expect(result.isDuplicate).toBe(true);
    });
  });
});
