import { describe, expect, test, vi, beforeEach } from "vitest";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";
import {
  searchSourceContent,
  vectorSearchSourceContent,
} from "../src/modules/sources/source.repository.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";

vi.mock("../src/modules/sources/source.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/context-compiler/query-context.js", () => ({
  buildRetrievalQueryText: vi.fn((input) => input.goal),
  fileHintsFromInput: vi.fn(() => []),
  normalizeRepoKey: vi.fn((path) => path),
  normalizeRepoPath: vi.fn((path) => path),
}));

describe("Source Retrieval Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(searchSourceContent).mockResolvedValue([]);
    vi.mocked(vectorSearchSourceContent).mockResolvedValue([]);
  });

  test("combines text and vector search results", async () => {
    vi.mocked(searchSourceContent).mockResolvedValue([
      { id: "s1", score: 0.8, sourceUri: "test.ts" } as any,
    ]);
    vi.mocked(vectorSearchSourceContent).mockResolvedValue([
      { id: "s2", score: 0.9, sourceUri: "other.ts" } as any,
    ]);
    vi.mocked(embedOne).mockResolvedValue(new Array(384).fill(0.1));

    const result = await retrieveSources(
      { goal: "test goal", intent: "edit", includeDraft: false },
      { retrievalMode: "task_context" },
    );

    expect(result.items).toHaveLength(2);
    expect(result.stats.textHitCount).toBe(1);
    expect(result.stats.vectorHitCount).toBe(1);
  });

  test("falls back to global search when scoped search returns no results", async () => {
    vi.mocked(searchSourceContent).mockResolvedValueOnce([]);
    vi.mocked(searchSourceContent).mockResolvedValueOnce([
      { id: "s1", score: 0.8, sourceUri: "global.ts" } as any,
    ]);

    const result = await retrieveSources(
      {
        goal: "test goal",
        intent: "edit",
        includeDraft: false,
        repoPath: "/path/to/repo",
      },
      { retrievalMode: "task_context" },
    );

    expect(result.stats.repoScopeFallbackUsed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.degradedReasons).toContain("SOURCE_REPO_SCOPE_FALLBACK");
  });

  test("handles search failure", async () => {
    vi.mocked(searchSourceContent).mockRejectedValue(new Error("Timeout"));

    const result = await retrieveSources(
      { goal: "test", intent: "edit", includeDraft: false },
      { retrievalMode: "task_context" },
    );

    expect(result.stats.searchFailed).toBe(true);
    expect(result.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
  });
});
