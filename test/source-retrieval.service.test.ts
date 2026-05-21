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

    const result = await retrieveSources({ goal: "test goal" }, { retrievalMode: "task_context" });

    expect(result.items).toHaveLength(2);
    expect(result.stats.textHitCount).toBe(1);
    expect(result.stats.vectorHitCount).toBe(1);
  });

  test("returns no repo fallback markers in four-input mode", async () => {
    vi.mocked(searchSourceContent).mockResolvedValue([]);

    const result = await retrieveSources({ goal: "test goal" }, { retrievalMode: "task_context" });

    expect(result.stats.repoScopeFallbackUsed).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(result.degradedReasons).not.toContain("SOURCE_REPO_SCOPE_FALLBACK");
  });

  test("handles search failure", async () => {
    vi.mocked(searchSourceContent).mockRejectedValue(new Error("Timeout"));

    const result = await retrieveSources({ goal: "test" }, { retrievalMode: "task_context" });

    expect(result.stats.searchFailed).toBe(true);
    expect(result.degradedReasons).toContain("SOURCE_SEARCH_FAILED");
  });
});
