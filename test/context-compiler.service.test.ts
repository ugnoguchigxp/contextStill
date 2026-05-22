import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  insertCompileRun,
  insertContextPackItems,
  updateCompileRunSnapshot,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../src/modules/knowledge/knowledge-value.service.js";
import { retrieveKnowledge } from "../src/modules/knowledge/knowledge.service.js";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";

vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/sources/source-retrieval.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/modules/knowledge/knowledge-value.service.js");
vi.mock("../src/modules/context-compiler/pack-renderer.js", () => ({
  renderContextPackMarkdown: vi.fn(() => "# Pack Content"),
}));

describe("Context Compiler Service", () => {
  const originalAgenticCompileEnabled = groupedConfig.agenticCompile.enabled;
  const originalBudget = groupedConfig.compile.defaultTokenBudget;

  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.compile.defaultTokenBudget = 240;
    vi.mocked(insertCompileRun).mockResolvedValue("550e8400-e29b-41d4-a716-446655440000");
    vi.mocked(insertContextPackItems).mockResolvedValue();
    vi.mocked(updateCompileRunSnapshot).mockResolvedValue();
    vi.mocked(recordKnowledgeCompileSelectionSafe).mockResolvedValue();
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
  });

  afterAll(() => {
    groupedConfig.agenticCompile.enabled = originalAgenticCompileEnabled;
    groupedConfig.compile.defaultTokenBudget = originalBudget;
  });

  test("derives retrieval mode from changeTypes", async () => {
    const { pack: debugPack } = await compileContextPack({
      goal: "fix bug",
      changeTypes: ["debug"],
    });
    expect(debugPack.retrievalMode).toBe("debug_context");

    const { pack: reviewPack } = await compileContextPack({
      goal: "review changes",
      changeTypes: ["review"],
    });
    expect(reviewPack.retrievalMode).toBe("review_context");

    const { pack: architecturePack } = await compileContextPack({
      goal: "write migration plan",
      changeTypes: ["plan", "docs"],
    });
    expect(architecturePack.retrievalMode).toBe("architecture_context");
  });

  test("records run source for caller", async () => {
    await compileContextPack({ goal: "source test" }, { source: "mcp" });
    expect(insertCompileRun).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp" }));
  });

  test("applies internal token budget and marks compaction warning", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Long content ".repeat(260),
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k2",
          type: "rule",
          status: "active",
          title: "Rule 2",
          body: "Another long content ".repeat(180),
          score: 0.8,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 2,
        vectorHitCount: 0,
        mergedCount: 2,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "budget test" });
    expect(pack.rules.length).toBeGreaterThan(0);
    expect(pack.status).toBe("ok");
    expect(pack.diagnostics.degradedReasons).toContain("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
    expect(pack.warnings).toEqual([]);
  });

  test("builds fallback source ref when retrieval has no matches", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "no data" });
    expect(pack.sourceRefs[0]).toContain(
      "550e8400-e29b-41d4-a716-446655440000#task_context:NO_ACTIVE_KNOWLEDGE_MATCH",
    );
    expect(pack.status).toBe("degraded");
  });

  test("stores unknown facet candidates in diagnostics", async () => {
    const { pack } = await compileContextPack({
      goal: "domain test",
      technologies: ["unknown-tech"],
      domains: ["unknown-domain"],
      changeTypes: ["unknown-change"],
    });

    const unknown = pack.diagnostics.inputFacets?.unknown;
    expect(Array.isArray(unknown?.technology)).toBe(true);
    expect(Array.isArray(unknown?.domain)).toBe(true);
    expect(Array.isArray(unknown?.change_type)).toBe(true);
  });

  test("does not suggest legacy repo/files retry actions", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {
        hitCount: 0,
        textHitCount: 0,
        vectorHitCount: 0,
        searchFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "suggestions" });
    const calls = (pack.diagnostics.retrievalStats.suggestedNextCalls ?? []) as string[];
    expect(calls).not.toContain("context_compile (retry with explicit repoPath/files)");
    expect(calls).not.toContain("context_compile (retry with larger tokenBudget)");
  });

  test("short-circuits compile when goal contains design document reference", async () => {
    const { pack } = await compileContextPack({
      goal: "docs/context-compile-four-input-redesign-plan.md を実装する",
      changeTypes: ["refactor"],
    });

    expect(pack.status).toBe("degraded");
    expect(pack.rules).toEqual([]);
    expect(pack.procedures).toEqual([]);
    expect(pack.diagnostics.degradedReasons).toContain("GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE");
    expect(retrieveKnowledge).not.toHaveBeenCalled();
    expect(retrieveSources).not.toHaveBeenCalled();
  });

  test("suppresses low-confidence vector-only candidates", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k-vector-only",
          type: "rule",
          status: "active",
          title: "Weak vector-only knowledge",
          body: "not really relevant",
          score: 0.12,
          sourceRefs: [],
          hasSourceLinks: false,
          candidateEvidence: {
            textMatched: false,
            vectorMatched: true,
            vectorScore: 0.12,
            facetMatched: false,
          },
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 0,
        vectorHitCount: 1,
        mergedCount: 1,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    const { pack } = await compileContextPack({ goal: "actual compile behavior improvement" });
    expect(pack.rules).toEqual([]);
    expect(pack.procedures).toEqual([]);
    expect(pack.diagnostics.degradedReasons).toContain("LOW_CONFIDENCE_VECTOR_ONLY_SUPPRESSED");
    expect(pack.diagnostics.degradedReasons).toContain("NO_RELEVANT_CONTEXT");
  });
});
