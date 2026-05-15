import { describe, expect, test, vi, beforeEach } from "vitest";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";
import * as repository from "../src/modules/sources/source.repository.js";
import * as embedding from "../src/modules/embedding/embedding.service.js";
import { config } from "../src/config.js";

vi.mock("../src/modules/sources/source.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/config.js", () => ({
  config: {
    enableVectorSearch: true,
    embeddingProvider: "test-provider",
  },
}));

describe("source retrieval service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("retrieveSources", () => {
    test("returns merged hits from text and vector search", async () => {
      const mockTextHits = [{ id: "s1", score: 0.7, title: "Source Hit 1" }];
      const mockVectorHits = [{ id: "s2", score: 0.9, title: "Source Vector Hit 1" }];

      vi.mocked(repository.searchSourceContent).mockResolvedValue(mockTextHits as unknown as never);
      vi.mocked(repository.vectorSearchSourceContent).mockResolvedValue(
        mockVectorHits as unknown as never,
      );
      vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);

      const result = await retrieveSources(
        { goal: "test source goal", intent: "edit", includeDraft: false, repoPath: "/test/repo" },
        { retrievalMode: "learning_context" },
      );

      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("s2");
      expect(result.stats.textHitCount).toBe(1);
      expect(result.stats.vectorHitCount).toBe(1);
      expect(result.stats.embeddingStatus).toBe("generated");
    });

    test("handles search failure gracefully", async () => {
      vi.mocked(repository.searchSourceContent).mockRejectedValue(new Error("Search failed"));

      const result = await retrieveSources(
        { goal: "test goal", intent: "edit", includeDraft: false },
        { retrievalMode: "learning_context" },
      );

      expect(result.stats.searchFailed).toBe(true);
      expect(result.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
    });

    test("uses provided query embedding if available", async () => {
      vi.mocked(repository.searchSourceContent).mockResolvedValue([]);
      vi.mocked(repository.vectorSearchSourceContent).mockResolvedValue([]);

      const result = await retrieveSources(
        { goal: "test goal", intent: "edit", includeDraft: false, queryEmbedding: [0.5, 0.6] },
        { retrievalMode: "learning_context" },
      );

      expect(result.stats.embeddingStatus).toBe("provided");
      expect(vi.mocked(embedding.embedOne)).not.toHaveBeenCalled();
    });

    test("falls back to global scope if scoped search returns no results", async () => {
      vi.mocked(repository.searchSourceContent)
        .mockResolvedValueOnce([]) // Scoped primary
        .mockResolvedValueOnce([]) // Scoped expanded
        .mockResolvedValueOnce([
          { id: "global-1", score: 0.5, title: "Global Hit" },
        ] as unknown as never); // Global primary

      vi.mocked(repository.vectorSearchSourceContent).mockResolvedValue([]);

      const result = await retrieveSources(
        { goal: "test goal", intent: "edit", includeDraft: false, repoPath: "/test/repo" },
        { retrievalMode: "learning_context" },
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("global-1");
      expect(result.stats.repoScopeFallbackUsed).toBe(true);
      expect(result.degradedReasons).toContain("SOURCE_REPO_SCOPE_FALLBACK");
    });

    test("uses path hints to enrich results", async () => {
      vi.mocked(repository.searchSourceContent).mockResolvedValue([
        { id: "s-hint", score: 0.9 } as unknown as never,
      ]);
      const result = await retrieveSources(
        { goal: "test", intent: "edit", includeDraft: false, files: ["hint.ts"] },
        { retrievalMode: "task_context" },
      );
      expect(vi.mocked(repository.searchSourceContent)).toHaveBeenCalledWith(
        expect.stringContaining("hint.ts"),
        expect.any(Number),
        undefined,
        expect.any(Object),
      );
      expect(result.items[0].id).toBe("s-hint");
    });

    test("handles embedding failure gracefully", async () => {
      vi.mocked(embedding.embedOne).mockRejectedValue(new Error("Embedding failed"));
      const result = await retrieveSources(
        { goal: "test", intent: "edit", includeDraft: false },
        { retrievalMode: "task_context" },
      );
      expect(result.degradedReasons).toContain("SOURCE_QUERY_EMBEDDING_UNAVAILABLE");
    });
  });
});
