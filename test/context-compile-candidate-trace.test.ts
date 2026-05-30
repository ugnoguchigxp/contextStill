import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
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

const { agenticRefineMock } = vi.hoisted(() => ({
  agenticRefineMock: vi.fn(),
}));

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
  agenticRefine: agenticRefineMock,
}));
vi.mock("../src/modules/context-compiler/context-response-composer.service.js", () => ({
  composeContextResponse: vi.fn(() => ({
    markdown: "# Pack Content",
    agenticUsed: true,
    usedKnowledge: [
      {
        id: "k4",
        confidence: 0.9,
        reason: "selected_by_agentic",
      },
    ],
  })),
}));

describe("context compile candidate trace", () => {
  const originalAgenticCompileEnabled = groupedConfig.agenticCompile.enabled;
  const originalBudget = groupedConfig.compile.defaultTokenBudget;
  const originalTraceLimit = groupedConfig.compile.candidateTraceLimit;

  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.agenticCompile.enabled = false;
    groupedConfig.compile.defaultTokenBudget = 4000;
    groupedConfig.compile.candidateTraceLimit = 1;

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
    vi.mocked(recordAuditLogSafe).mockResolvedValue(undefined);

    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "rule one",
          score: 0.95,
          confidence: 90,
          importance: 90,
          dynamicScore: 0,
          decayFactor: 1,
          sourceRefs: [],
          hasSourceLinks: false,
          applicabilityScore: 0,
          metadata: {},
          candidateEvidence: {
            textMatched: true,
            vectorMatched: false,
            facetMatched: true,
          },
        },
        {
          id: "k2",
          type: "rule",
          status: "active",
          title: "Rule 2",
          body: "rule two",
          score: 0.85,
          confidence: 90,
          importance: 90,
          dynamicScore: 0,
          decayFactor: 1,
          sourceRefs: [],
          hasSourceLinks: false,
          applicabilityScore: 0,
          metadata: {},
          candidateEvidence: {
            textMatched: true,
            vectorMatched: false,
            facetMatched: true,
          },
        },
        {
          id: "k3",
          type: "rule",
          status: "active",
          title: "Rule 3",
          body: "rule three",
          score: 0.75,
          confidence: 90,
          importance: 90,
          dynamicScore: 0,
          decayFactor: 1,
          sourceRefs: [],
          hasSourceLinks: false,
          applicabilityScore: 0,
          metadata: {},
          candidateEvidence: {
            textMatched: false,
            vectorMatched: true,
            vectorScore: 0.75,
            facetMatched: true,
          },
        },
        {
          id: "k4",
          type: "rule",
          status: "active",
          title: "Rule 4",
          body: "rule four",
          score: 0.65,
          confidence: 90,
          importance: 90,
          dynamicScore: 0,
          decayFactor: 1,
          sourceRefs: [],
          hasSourceLinks: false,
          applicabilityScore: 0,
          metadata: {},
          candidateEvidence: {
            textMatched: false,
            vectorMatched: true,
            vectorScore: 0.65,
            facetMatched: true,
          },
        },
      ],
      degradedReasons: [],
      trace: {
        text: [
          { id: "k1", rank: 1, score: 0.95 },
          { id: "k2", rank: 2, score: 0.85 },
        ],
        vector: [
          { id: "k3", rank: 1, score: 0.75 },
          { id: "k4", rank: 2, score: 0.65 },
        ],
        merged: [
          { id: "k1", rank: 1, score: 0.95 },
          { id: "k2", rank: 2, score: 0.85 },
          { id: "k3", rank: 3, score: 0.75 },
          { id: "k4", rank: 4, score: 0.65 },
        ],
      },
      stats: {
        textHitCount: 2,
        vectorHitCount: 2,
        mergedCount: 4,
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
    agenticRefineMock.mockResolvedValue({
      items: [
        {
          id: "k4",
          type: "rule",
          status: "active",
          title: "Rule 4",
          content: "rule four",
          score: 0.65,
          sourceRefs: [],
        },
      ],
      agenticUsed: true,
      reasoning: "selected one risky candidate",
    });
  });

  afterEach(() => {
    groupedConfig.agenticCompile.enabled = originalAgenticCompileEnabled;
    groupedConfig.compile.defaultTokenBudget = originalBudget;
    groupedConfig.compile.candidateTraceLimit = originalTraceLimit;
  });

  test("keeps selected item in trace even when limit truncates candidates", async () => {
    const { pack } = await compileContextPack({ goal: "trace cap test" });

    expect(insertContextCompileCandidateTraces).toHaveBeenCalledTimes(1);
    const [, rows] = vi.mocked(insertContextCompileCandidateTraces).mock.calls[0] ?? [];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        itemId: "k4",
        selected: true,
      }),
    );

    const retrievalStats = pack.diagnostics.retrievalStats as Record<string, unknown>;
    expect(retrievalStats.candidateTraceSavedCount).toBe(1);
    expect(retrievalStats.candidateTraceTruncated).toBe(true);
    expect(retrievalStats.candidateTraceLimit).toBe(1);
    expect(retrievalStats.candidateTraceSkippedReason).toBeNull();
  });
});
