import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  insertCompileRun,
  insertContextCompileCandidateTraces,
  insertContextPackItems,
  updateCompileRunSnapshot,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { recordCompileRunKnowledgeUsageSignals } from "../src/modules/knowledge/knowledge-feedback.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../src/modules/knowledge/knowledge-value.service.js";
import { retrieveKnowledge } from "../src/modules/knowledge/knowledge.service.js";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";

vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/sources/source-retrieval.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/modules/knowledge/knowledge-feedback.service.js");
vi.mock("../src/modules/knowledge/knowledge-value.service.js");
vi.mock("../src/modules/audit/audit-log.service.js");
vi.mock("../src/modules/context-compiler/pack-renderer.js", () => ({
  renderContextPackMarkdown: vi.fn(() => "# Pack Content"),
}));
vi.mock("../src/modules/context-compiler/agentic-refine.service.js", () => ({
  agenticRefine: vi.fn(async (items) => ({ items, agenticUsed: false })),
}));
vi.mock("../src/modules/context-compiler/context-response-composer.service.js", () => ({
  composeContextResponse: vi.fn(({ rules, procedures }) => {
    const items = [...rules, ...procedures];
    return {
      markdown: "# Pack Content",
      agenticUsed: false,
      usedKnowledge: items.slice(0, 3).map((item) => ({
        id: item.itemId,
        confidence: 0.35,
        reason: "test_compose_reference",
      })),
    };
  }),
}));

describe("Context Compiler Service", () => {
  const originalAgenticCompileEnabled = groupedConfig.agenticCompile.enabled;
  const originalBudget = groupedConfig.compile.defaultTokenBudget;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(recordAuditLogSafe).mockResolvedValue(undefined);
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.compile.defaultTokenBudget = 240;
    vi.mocked(insertCompileRun).mockResolvedValue("550e8400-e29b-41d4-a716-446655440000");
    vi.mocked(insertContextPackItems).mockResolvedValue();
    vi.mocked(insertContextCompileCandidateTraces).mockResolvedValue();
    vi.mocked(updateCompileRunSnapshot).mockResolvedValue();
    vi.mocked(recordCompileRunKnowledgeUsageSignals).mockResolvedValue({
      savedCount: 0,
      updatedCount: 0,
      queueCreatedCount: 0,
      queueDismissedCount: 0,
      affectedKnowledgeIds: [],
    });
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

  test("keeps source-only misses non-blocking when knowledge context is usable", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Useful rule",
          body: "Use the existing doctor signal categories.",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 1,
        vectorHitCount: 0,
        mergedCount: 1,
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

    const { pack } = await compileContextPack({ goal: "source miss with useful knowledge" });
    const reasonBuckets = pack.diagnostics.retrievalStats.reasonBuckets as {
      blocking: string[];
      maintenanceWarnings: string[];
    };
    expect(pack.status).toBe("ok");
    expect(pack.diagnostics.degradedReasons).toContain("NO_SOURCE_MATCH");
    expect(reasonBuckets.blocking).not.toContain("NO_SOURCE_MATCH");
    expect(reasonBuckets.maintenanceWarnings).toContain("NO_SOURCE_MATCH");
  });

  test("records compile usage signals from composed response", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Keep API validation",
          score: 0.91,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k2",
          type: "rule",
          status: "active",
          title: "Rule 2",
          body: "Keep repository boundaries",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k3",
          type: "rule",
          status: "active",
          title: "Rule 3",
          body: "Add targeted tests",
          score: 0.89,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k4",
          type: "rule",
          status: "active",
          title: "Rule 4",
          body: "Report verification output",
          score: 0.88,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 4,
        vectorHitCount: 0,
        mergedCount: 4,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);

    await compileContextPack({ goal: "usage signal capture" });

    expect(insertContextCompileCandidateTraces).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(recordCompileRunKnowledgeUsageSignals).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "550e8400-e29b-41d4-a716-446655440000",
          items: expect.arrayContaining([
            expect.objectContaining({ knowledgeId: "k1", verdict: "used" }),
            expect.objectContaining({ knowledgeId: "k4", verdict: "not_used" }),
          ]),
        }),
      );
    });
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

  test("records compile usage signals error handling and records audit log", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Body 1",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {} as any,
    } as any);

    // Force error in recordCompileRunKnowledgeUsageSignals
    vi.mocked(recordCompileRunKnowledgeUsageSignals).mockRejectedValue(
      new Error("Database write error"),
    );

    await compileContextPack({ goal: "trigger signal save error" });

    await vi.waitFor(() => {
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_USAGE_SIGNAL_SAVE_FAILED",
        }),
      );
    });
  });

  test("escalates status to failed when multiple hard failures occur", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["QUERY_EMBEDDING_UNAVAILABLE", "AGENTIC_REFINE_FAILED"],
      stats: {} as any,
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["SOURCE_QUERY_EMBEDDING_UNAVAILABLE", "SOURCE_RETRIEVAL_FAILED"],
      stats: {} as any,
    } as any);

    const { pack } = await compileContextPack({ goal: "failed status test" });
    expect(pack.status).toBe("failed");
    expect(pack.diagnostics.retrievalStats.suggestedNextCalls).toContain("doctor");
  });

  test("recommends next calls based on degraded reasons", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {} as any,
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: {} as any,
    } as any);

    const { pack } = await compileContextPack({ goal: "recommends next calls test" });
    expect(pack.diagnostics.retrievalStats.suggestedNextCalls).toContain("search_knowledge");
    expect(pack.diagnostics.retrievalStats.suggestedNextCalls).toContain("search_memory");
  });

  test("uses legacy intent mapping correctly", async () => {
    const { pack: learningPack } = await compileContextPack({
      goal: "learn python",
      changeTypes: ["learning"],
    });
    expect(learningPack.retrievalMode).toBe("learning_context");
  });
});
