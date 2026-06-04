import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  buildGraphSnapshotMock,
  buildLandscapeSnapshotMock,
  listDeadZoneKnowledgeEvidenceRowsMock,
  listDeadZoneKnowledgeRowsMock,
  listDeadZoneReviewItemLinksMock,
  listSimilarKnowledgeRowsMock,
} = vi.hoisted(() => ({
  buildGraphSnapshotMock: vi.fn(),
  buildLandscapeSnapshotMock: vi.fn(),
  listDeadZoneKnowledgeEvidenceRowsMock: vi.fn(),
  listDeadZoneKnowledgeRowsMock: vi.fn(),
  listDeadZoneReviewItemLinksMock: vi.fn(),
  listSimilarKnowledgeRowsMock: vi.fn(),
}));

vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: buildGraphSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: buildLandscapeSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-deadzone-review.repository.js", () => ({
  listDeadZoneKnowledgeEvidenceRows: listDeadZoneKnowledgeEvidenceRowsMock,
  listDeadZoneKnowledgeRows: listDeadZoneKnowledgeRowsMock,
  listDeadZoneReviewItemLinks: listDeadZoneReviewItemLinksMock,
  listSimilarKnowledgeRows: listSimilarKnowledgeRowsMock,
}));

import { buildDeadZoneKnowledgeReview } from "../src/modules/landscape/landscape-deadzone-review.service.js";

const communityKey = "a".repeat(64);

function activeKnowledge(overrides: Record<string, unknown> = {}) {
  return {
    id: "k-dead",
    title: "DeadZone Procedure",
    body: "Use when:\n- DeadZone review is needed.\n\nWorkflow:\n1. Review evidence.\n\nVerification:\n- Confirm.",
    type: "procedure",
    status: "active",
    scope: "repo",
    appliesTo: { domains: ["landscape"], technologies: ["typescript"] },
    metadata: {},
    confidence: 80,
    importance: 75,
    dynamicScore: 0,
    compileSelectCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    embedded: true,
    ...overrides,
  };
}

describe("buildDeadZoneKnowledgeReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildLandscapeSnapshotMock.mockResolvedValue({
      generatedAt: "2026-05-24T00:00:00.000Z",
      windowDays: 30,
      basis: { unit: "community", relationAxes: ["session"], status: "active" },
      thresholds: {},
      stats: {},
      communities: [
        {
          communityId: "community-1",
          communityKey,
          communityLabel: "DeadZone community",
          communityRank: 1,
          size: 2,
          memberCounts: {
            active: 2,
            draft: 0,
            deprecated: 0,
            rule: 1,
            procedure: 1,
            embedded: 2,
          },
          selection: {
            selectedItemCountWindow: 0,
            selectedRunCountWindow: 0,
            cumulativeCompileSelectCount: 0,
            zeroUseActiveCount: 2,
            zeroUseActiveRatio: 1,
          },
          feedback: {
            usedCountWindow: 0,
            notUsedCountWindow: 0,
            offTopicCountWindow: 0,
            wrongCountWindow: 0,
            feedbackCountWindow: 0,
            usedRate: 0,
            notUsedRate: 0,
            offTopicRate: 0,
            wrongRate: 0,
            feedbackConfidence: "insufficient",
          },
          quality: {
            avgImportance: 75,
            avgConfidence: 80,
            avgDynamicScore: 0,
            sourceRefCount: 0,
            sourceRefDensity: 0,
            avgFreshnessFactor: 0.4,
            avgStalenessFactor: 0.6,
          },
          scores: {
            activity: 0,
            attractorScore: 0,
            negativeScore: 0,
            reachabilityRiskScore: 0.4,
          },
          classification: {
            primary: "dead_zone_stale",
            flags: [],
            confidence: "medium",
            reason: "unused and thin evidence",
          },
          recommendedActions: ["review"],
          representativeKnowledgeIds: ["k-dead"],
        },
      ],
      risks: [],
    });
    buildGraphSnapshotMock.mockResolvedValue({
      nodes: [
        {
          id: "knowledge:k-dead",
          label: "DeadZone Procedure",
          kind: "knowledge",
          group: "procedure",
          weight: 1,
          status: "active",
          embedded: true,
          communityKey,
          communityLabel: "DeadZone community",
        },
      ],
      edges: [],
      communities: [],
      supernodes: [],
      superedges: [],
      stats: {},
    });
    listDeadZoneKnowledgeRowsMock.mockResolvedValue([activeKnowledge()]);
    listSimilarKnowledgeRowsMock.mockResolvedValue([
      activeKnowledge({
        id: "k-active",
        sourceKnowledgeId: "k-dead",
        similarity: 0.94,
        title: "Active Canonical Knowledge",
        compileSelectCount: 4,
        body: "Use when:\n- DeadZone review is needed.\n\nWorkflow:\n1. Use canonical guidance.\n\nVerification:\n- Confirm.",
      }),
    ]);
    listDeadZoneKnowledgeEvidenceRowsMock.mockResolvedValue([
      { knowledgeId: "k-dead", sourceRefCount: 0, originRefCount: 0 },
      { knowledgeId: "k-active", sourceRefCount: 2, originRefCount: 1 },
    ]);
    listDeadZoneReviewItemLinksMock.mockResolvedValue([]);
  });

  test("maps dead-zone communities to knowledge-level review items with similar knowledge", async () => {
    const result = await buildDeadZoneKnowledgeReview({
      windowDays: 30,
      limit: 50,
      status: "active",
      reason: "all",
      minSimilarity: 0.9,
      similarTopK: 5,
      relationAxes: ["session", "project", "source"],
      badge: "all",
    });

    expect(result.itemCount).toBe(1);
    expect(result.items[0]?.knowledge.id).toBe("k-dead");
    expect(result.items[0]?.similarKnowledge[0]?.id).toBe("k-active");
    expect(result.items[0]?.similarKnowledge[0]?.suggestedAction).toBe("merge_into_similar");
    expect(result.items[0]?.indicators.badges).toContain("Strong merge candidate");
    expect(listSimilarKnowledgeRowsMock).toHaveBeenCalledWith({
      knowledgeIds: ["k-dead"],
      minSimilarity: 0.9,
      topK: 5,
      status: "active",
    });
  });

  test("keeps missing-embedding knowledge visible but marks similarity unavailable", async () => {
    listDeadZoneKnowledgeRowsMock.mockResolvedValue([activeKnowledge({ embedded: false })]);
    listSimilarKnowledgeRowsMock.mockResolvedValue([]);

    const result = await buildDeadZoneKnowledgeReview({
      windowDays: 30,
      limit: 50,
      status: "active",
      reason: "dead_zone_stale",
      minSimilarity: 0.9,
      similarTopK: 5,
      relationAxes: ["session", "project", "source"],
      badge: "all",
    });

    expect(result.items[0]?.knowledge.id).toBe("k-dead");
    expect(result.items[0]?.similarKnowledge).toEqual([]);
    expect(result.items[0]?.indicators.badges).toContain("Needs embedding");
    expect(result.items[0]?.indicators.badges).toContain("Similarity unavailable");
  });

  test("orders review items by DeadZone score descending", async () => {
    buildLandscapeSnapshotMock.mockResolvedValue({
      generatedAt: "2026-05-24T00:00:00.000Z",
      windowDays: 30,
      basis: { unit: "community", relationAxes: ["session"], status: "active" },
      thresholds: {},
      stats: {},
      communities: [
        {
          communityId: "community-1",
          communityKey,
          communityLabel: "DeadZone community",
          communityRank: 1,
          size: 2,
          memberCounts: {
            active: 2,
            draft: 0,
            deprecated: 0,
            rule: 1,
            procedure: 1,
            embedded: 2,
          },
          selection: {
            selectedItemCountWindow: 0,
            selectedRunCountWindow: 0,
            cumulativeCompileSelectCount: 0,
            zeroUseActiveCount: 2,
            zeroUseActiveRatio: 1,
          },
          feedback: {
            usedCountWindow: 0,
            notUsedCountWindow: 0,
            offTopicCountWindow: 0,
            wrongCountWindow: 0,
            feedbackCountWindow: 0,
            usedRate: 0,
            notUsedRate: 0,
            offTopicRate: 0,
            wrongRate: 0,
            feedbackConfidence: "insufficient",
          },
          quality: {
            avgImportance: 75,
            avgConfidence: 80,
            avgDynamicScore: 0,
            sourceRefCount: 0,
            sourceRefDensity: 0,
            avgFreshnessFactor: 0.4,
            avgStalenessFactor: 0.6,
          },
          scores: {
            activity: 0,
            attractorScore: 0,
            negativeScore: 0,
            reachabilityRiskScore: 0.5,
          },
          classification: {
            primary: "dead_zone_reachability_risk",
            flags: [],
            confidence: "high",
            reason: "unused and unreachable",
          },
          recommendedActions: ["review"],
          representativeKnowledgeIds: ["k-used", "k-unused"],
        },
      ],
      risks: [],
    });
    buildGraphSnapshotMock.mockResolvedValue({
      nodes: [
        {
          id: "knowledge:k-used",
          label: "Used Knowledge",
          kind: "knowledge",
          group: "procedure",
          weight: 1,
          status: "active",
          embedded: true,
          communityKey,
          communityLabel: "DeadZone community",
        },
        {
          id: "knowledge:k-unused",
          label: "Unused Knowledge",
          kind: "knowledge",
          group: "procedure",
          weight: 1,
          status: "active",
          embedded: true,
          communityKey,
          communityLabel: "DeadZone community",
        },
      ],
      edges: [],
      communities: [],
      supernodes: [],
      superedges: [],
      stats: {},
    });
    listDeadZoneKnowledgeRowsMock.mockResolvedValue([
      activeKnowledge({
        id: "k-used",
        title: "Used Knowledge",
        body: "Use when:\n- Used knowledge is needed.\n\nWorkflow:\n1. Apply it.\n\nVerification:\n- Confirm the outcome.\n\nAvoid:\n- Guessing.",
        compileSelectCount: 5,
      }),
      activeKnowledge({
        id: "k-unused",
        title: "Unused Knowledge",
        body: "Short body",
        compileSelectCount: 0,
      }),
    ]);
    listSimilarKnowledgeRowsMock.mockResolvedValue([]);
    listDeadZoneKnowledgeEvidenceRowsMock.mockResolvedValue([
      { knowledgeId: "k-used", sourceRefCount: 3, originRefCount: 1 },
      { knowledgeId: "k-unused", sourceRefCount: 0, originRefCount: 0 },
    ]);

    const result = await buildDeadZoneKnowledgeReview({
      windowDays: 30,
      limit: 50,
      status: "active",
      reason: "all",
      minSimilarity: 0.9,
      similarTopK: 5,
      relationAxes: ["session", "project", "source"],
      badge: "all",
    });

    expect(result.items.map((item) => item.knowledge.id)).toEqual(["k-unused", "k-used"]);
    expect(result.items[0]?.indicators.deadZoneScore).toBeGreaterThan(
      result.items[1]?.indicators.deadZoneScore ?? 0,
    );
  });
});
