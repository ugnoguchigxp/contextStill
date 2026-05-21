import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import * as embedding from "../src/modules/embedding/embedding.service.js";
import * as repo from "../src/modules/knowledge/knowledge.repository.js";
import {
  registerKnowledgeFromMarkdown,
  retrieveKnowledge,
  searchKnowledgeCandidates,
} from "../src/modules/knowledge/knowledge.service.js";

vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
const originalEnableVectorSearch = groupedConfig.compile.enableVectorSearch;

describe("Knowledge Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.compile.enableVectorSearch = true;
  });

  test("retrieveKnowledge uses correct profile based on mode", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);
    const input = { goal: "test", includeDraft: false } as any;

    await retrieveKnowledge(input, { retrievalMode: "review_context" });
    expect(repo.searchKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ types: ["rule", "procedure"], limit: 12 }),
      expect.any(Object),
    );
  });

  test("retrieveKnowledge uses unscoped search in four-input mode", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    vi.mocked(repo.searchKnowledge).mockResolvedValue([{ id: "item1", score: 0.9 }] as any);

    const result = await retrieveKnowledge({ goal: "test" }, { retrievalMode: "learning_context" });

    expect(result.items).toHaveLength(1);
    expect(result.stats.repoScopeFallbackUsed).toBe(false);
    expect(result.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    const call = vi.mocked(repo.searchKnowledge).mock.calls[0];
    expect(call?.[0]?.repoPath).toBeUndefined();
    expect(call?.[1]?.repoPath).toBeUndefined();
  });

  test("marks degraded reason when legacy metadata fallback is used for scoped search candidates", async () => {
    groupedConfig.compile.enableVectorSearch = false;
    let calls = 0;
    vi.mocked(repo.searchKnowledge).mockImplementation(async () => {
      calls += 1;
      if (calls === 2) {
        return [
          {
            id: "legacy-item",
            type: "rule",
            status: "active",
            scope: "repo",
            title: "Legacy Repo Rule",
            body: "legacy scope token",
            confidence: 70,
            importance: 70,
            score: 0.9,
            appliesTo: {},
            metadata: {
              repoPath: "/workspace/repo-a",
              repoKey: "/workspace/repo-a",
            },
            sourceRefs: [],
            hasSourceLinks: false,
          },
        ] as any;
      }
      return [];
    });

    const result = await searchKnowledgeCandidates({
      query: "legacy scope token",
      repoPath: "/workspace/repo-a",
      includeDraft: false,
      limit: 10,
    });

    expect(result.stats.repoScopeFallbackUsed).toBe(false);
    expect(result.degradedReasons).toContain("KNOWLEDGE_APPLIES_TO_FALLBACK");
    expect(result.degradedReasons).not.toContain("KNOWLEDGE_REPO_SCOPE_FALLBACK");
    const legacyCall = vi.mocked(repo.searchKnowledge).mock.calls[1];
    expect(legacyCall?.[1]?.scopeMatchMode).toBe("legacy");
  });

  test("registerKnowledgeFromMarkdown generates embedding if missing", async () => {
    vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(repo.upsertKnowledgeFromSource).mockResolvedValue("new-id");

    const id = await registerKnowledgeFromMarkdown({
      sourceUri: "test.md",
      title: "Title",
      body: "Body",
    });

    expect(id).toBe("new-id");
    expect(embedding.embedOne).toHaveBeenCalledWith("Title\nBody", "passage");
  });

  test("executeKnowledgeSearch performs vector search if enabled", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);
    vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(repo.vectorSearchKnowledge).mockResolvedValue([{ id: "v1", score: 0.8 }] as any);

    const input = { goal: "test", includeDraft: false } as any;
    const result = await retrieveKnowledge(input, { retrievalMode: "learning_context" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("v1");
    expect(repo.vectorSearchKnowledge).toHaveBeenCalled();
  });

  test("searchKnowledgeCandidates parses input and searches", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([{ id: "c1", score: 0.7 }] as any);
    vi.mocked(repo.vectorSearchKnowledge).mockResolvedValue([]);
    const result = await searchKnowledgeCandidates({
      query: "task",
      limit: 5,
      includeDraft: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("c1");
  });

  test("registerKnowledgeFromMarkdown handles embedding failure", async () => {
    vi.mocked(embedding.embedOne).mockRejectedValue(new Error("Failed"));
    vi.mocked(repo.upsertKnowledgeFromSource).mockResolvedValue("no-embed-id");

    const id = await registerKnowledgeFromMarkdown({
      sourceUri: "test.md",
      title: "Title",
      body: "Body",
    });
    expect(id).toBe("no-embed-id");
  });

  test("handles search failures gracefully", async () => {
    vi.mocked(repo.searchKnowledge).mockRejectedValue(new Error("Search failed"));
    const input = { goal: "test", includeDraft: false } as any;
    const result = await retrieveKnowledge(input, { retrievalMode: "review_context" });
    expect(result.degradedReasons).toContain("KNOWLEDGE_TEXT_SEARCH_FAILED");
  });

  test("covers all retrieval profiles", async () => {
    vi.mocked(repo.searchKnowledge).mockResolvedValue([]);
    const modes = [
      "debug_context",
      "architecture_context",
      "procedure_context",
      "unknown",
    ] as any[];
    for (const mode of modes) {
      await retrieveKnowledge({ goal: "test", includeDraft: false } as any, {
        retrievalMode: mode,
      });
    }
    expect(repo.searchKnowledge).toHaveBeenCalled();
  });

  afterAll(() => {
    groupedConfig.compile.enableVectorSearch = originalEnableVectorSearch;
  });
});
