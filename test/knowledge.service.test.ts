import { describe, expect, test, vi, beforeEach } from "vitest";
import { retrieveKnowledge, searchKnowledgeCandidates } from "../src/modules/knowledge/knowledge.service.js";
import * as repository from "../src/modules/knowledge/knowledge.repository.js";
import * as embedding from "../src/modules/embedding/embedding.service.js";
import { config } from "../src/config.js";

vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/config.js", () => ({
  config: {
    enableVectorSearch: true,
    embeddingProvider: "test-provider",
  },
}));

describe("knowledge service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("retrieveKnowledge", () => {
    test("returns merged hits from text and vector search", async () => {
      const mockTextHits = [
        { id: "1", score: 0.8, title: "Text Hit 1" },
      ];
      const mockVectorHits = [
        { id: "2", score: 0.9, title: "Vector Hit 1" },
      ];

      vi.mocked(repository.searchKnowledge).mockResolvedValue(mockTextHits as any);
      vi.mocked(repository.vectorSearchKnowledge).mockResolvedValue(mockVectorHits as any);
      vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);

      const result = await retrieveKnowledge(
        { goal: "test goal", repoPath: "/test/repo" },
        { retrievalMode: "learning_context" }
      );

      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("2"); // Higher score first
      expect(result.stats.textHitCount).toBe(1);
      expect(result.stats.vectorHitCount).toBe(1);
      expect(result.stats.embeddingStatus).toBe("generated");
    });

    test("falls back to global search if scoped search returns no hits", async () => {
      vi.mocked(repository.searchKnowledge)
        .mockResolvedValueOnce([]) // First call (scoped)
        .mockResolvedValueOnce([{ id: "global-1", score: 0.5, title: "Global Hit" }] as any); // Second call (fallback)
      
      vi.mocked(repository.vectorSearchKnowledge).mockResolvedValue([]);

      const result = await retrieveKnowledge(
        { goal: "test goal", repoPath: "/test/repo" },
        { retrievalMode: "learning_context" }
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("global-1");
      expect(result.stats.repoScopeFallbackUsed).toBe(true);
      expect(result.degradedReasons).toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    });

    test("handles text search failure gracefully", async () => {
      vi.mocked(repository.searchKnowledge).mockRejectedValue(new Error("Text search failed"));
      vi.mocked(repository.vectorSearchKnowledge).mockResolvedValue([]);

      const result = await retrieveKnowledge(
        { goal: "test goal" },
        { retrievalMode: "learning_context" }
      );

      expect(result.stats.textFailed).toBe(true);
      expect(result.degradedReasons).toContain("KNOWLEDGE_TEXT_SEARCH_FAILED");
    });
  });

  describe("searchKnowledgeCandidates", () => {
    test("parses raw input and returns results", async () => {
      vi.mocked(repository.searchKnowledge).mockResolvedValue([{ id: "1", score: 1.0 }] as any);
      
      const result = await searchKnowledgeCandidates({
        query: "test query",
        limit: 5,
        status: "active"
      });

      expect(result.items).toHaveLength(1);
      expect(vi.mocked(repository.searchKnowledge)).toHaveBeenCalledWith(
        expect.objectContaining({ query: "test query", limit: 5 }),
        expect.anything()
      );
    });
  });
});
