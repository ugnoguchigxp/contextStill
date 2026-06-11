import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildLandscapeCommunityComparison,
  buildSemanticCommunityAssignments,
  classifyLandscapeCommunityComparison,
} from "../src/modules/landscape/landscape-community-comparison.js";

// モック定義 (巻き上げ用)
const dbMocks = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
}));

const mockBuildCommunityAssignments = vi.hoisted(() => vi.fn());

vi.mock("../src/db/index.js", () => ({
  db: dbMocks,
}));

vi.mock("../src/modules/graph/community-builder.js", () => ({
  buildCommunityAssignments: (...args: any[]) => mockBuildCommunityAssignments(...args),
}));

describe("landscape community comparison", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // loadSemanticNodes 向けのデフォルト select
    dbMocks.select.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ id: "kb-1" }, { id: "kb-2" }, { id: "kb-3" }]),
      }),
    });

    // loadSemanticEdges 向けのデフォルト execute
    dbMocks.execute.mockResolvedValue({
      rows: [
        { source_id: "kb-1", target_id: "kb-2", similarity: 0.8 },
        { source_id: "kb-2", target_id: "kb-3", similarity: 0.75 },
      ],
    });

    // buildCommunityAssignments のデフォルト戻り値
    mockBuildCommunityAssignments.mockReturnValue({
      assignments: new Map([
        ["knowledge:kb-1", { communityKey: "sem-1", communitySize: 2 }],
        ["knowledge:kb-2", { communityKey: "sem-1", communitySize: 2 }],
      ]),
    });
  });

  test("classifies semantic reachable dead zones ahead of generic orphan/split labels", () => {
    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "dead_zone_reachability_risk",
        semanticKeyCount: 1,
        bestJaccardOverlap: 0.2,
        bestSemanticCommunitySize: 4,
        selectedNeighborCountWindow: 3,
      }),
    ).toBe("semantic_reachable_dead_zone");
  });

  test("classifies relation/semantic shape drift", () => {
    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "neutral",
        semanticKeyCount: 0,
        bestJaccardOverlap: 0,
        bestSemanticCommunitySize: 0,
        selectedNeighborCountWindow: 0,
      }),
    ).toBe("relation_orphan");

    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "neutral",
        semanticKeyCount: 2,
        bestJaccardOverlap: 0.6,
        bestSemanticCommunitySize: 2,
        selectedNeighborCountWindow: 0,
      }),
    ).toBe("semantic_split");

    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "neutral",
        semanticKeyCount: 1,
        bestJaccardOverlap: 0.5,
        bestSemanticCommunitySize: 6,
        selectedNeighborCountWindow: 0,
      }),
    ).toBe("semantic_merge");
  });

  test("buildSemanticCommunityAssignments returns semantic assignments map", async () => {
    const result = await buildSemanticCommunityAssignments({
      knowledgeIds: ["kb-1", "kb-2", "kb-3"],
      minSimilarity: 0.7,
      semanticTopK: 5,
    });

    expect(result.size).toBe(2);
    expect(result.get("kb-1")).toEqual({
      knowledgeId: "kb-1",
      communityKey: "sem-1",
      communitySize: 2,
    });
    expect(dbMocks.select).toHaveBeenCalled();
    expect(dbMocks.execute).toHaveBeenCalled();
    expect(mockBuildCommunityAssignments).toHaveBeenCalled();
  });

  test("buildSemanticCommunityAssignments returns empty map when no nodes found", async () => {
    dbMocks.select.mockReturnValueOnce({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    });

    const result = await buildSemanticCommunityAssignments({
      knowledgeIds: ["kb-1"],
      minSimilarity: 0.7,
      semanticTopK: 5,
    });

    expect(result.size).toBe(0);
  });

  test("buildLandscapeCommunityComparison correctly maps aligned communities", async () => {
    const relationAssignments = new Map([
      [
        "kb-1",
        {
          knowledgeId: "kb-1",
          communityKey: "rel-1",
          communityLabel: "Relation Comm 1",
          communityRank: 1,
          communitySize: 2,
          classificationAtAnalysis: "neutral" as const,
        },
      ],
      [
        "kb-2",
        {
          knowledgeId: "kb-2",
          communityKey: "rel-1",
          communityLabel: "Relation Comm 1",
          communityRank: 1,
          communitySize: 2,
          classificationAtAnalysis: "neutral" as const,
        },
      ],
    ]);

    const selectedItemCounts = new Map([
      ["kb-1", 1],
      ["kb-2", 0],
    ]);

    const summary = await buildLandscapeCommunityComparison({
      knowledgeIds: ["kb-1", "kb-2", "kb-3"],
      relationAssignmentsByKnowledgeId: relationAssignments,
      selectedItemCountByKnowledgeId: selectedItemCounts,
      minSimilarity: 0.7,
      semanticTopK: 5,
    });

    expect(summary.universeKnowledgeCount).toBe(3);
    expect(summary.comparedKnowledgeCount).toBe(2);
    expect(summary.missingRelationAssignmentCount).toBe(1); // kb-3 has no relation
    expect(summary.missingSemanticAssignmentCount).toBe(1);
    expect(summary.alignedCount).toBe(1);
    expect(summary.communities).toHaveLength(1);
    expect(summary.communities[0]).toMatchObject({
      relationCommunityKey: "rel-1",
      relationCommunityLabel: "Relation Comm 1",
      comparison: "aligned",
    });
  });

  test("buildLandscapeCommunityComparison handles various classification branches (split, merge, dead-zone)", async () => {
    // 1. semantic_split
    mockBuildCommunityAssignments.mockReturnValueOnce({
      assignments: new Map([
        ["knowledge:kb-1", { communityKey: "sem-1", communitySize: 1 }],
        ["knowledge:kb-2", { communityKey: "sem-2", communitySize: 1 }],
      ]),
    });

    const relationAssignments = new Map([
      [
        "kb-1",
        {
          knowledgeId: "kb-1",
          communityKey: "rel-1",
          communityLabel: "Rel Split",
          communityRank: 1,
          communitySize: 2,
          classificationAtAnalysis: "neutral" as const,
        },
      ],
      [
        "kb-2",
        {
          knowledgeId: "kb-2",
          communityKey: "rel-1",
          communityLabel: "Rel Split",
          communityRank: 1,
          communitySize: 2,
          classificationAtAnalysis: "neutral" as const,
        },
      ],
    ]);

    const summary = await buildLandscapeCommunityComparison({
      knowledgeIds: ["kb-1", "kb-2"],
      relationAssignmentsByKnowledgeId: relationAssignments,
      selectedItemCountByKnowledgeId: new Map(),
      minSimilarity: 0.7,
      semanticTopK: 5,
    });

    expect(summary.semanticSplitCount).toBe(1);

    // 2. semantic_reachable_dead_zone
    mockBuildCommunityAssignments.mockReturnValueOnce({
      assignments: new Map([
        ["knowledge:kb-1", { communityKey: "sem-dead", communitySize: 2 }],
        ["knowledge:kb-2", { communityKey: "sem-dead", communitySize: 2 }], // neighbor
      ]),
    });

    const relationAssignmentsDeadZone = new Map([
      [
        "kb-1",
        {
          knowledgeId: "kb-1",
          communityKey: "rel-dead",
          communityLabel: "Dead Zone Comm",
          communityRank: 2,
          communitySize: 1,
          classificationAtAnalysis: "dead_zone_stale" as const,
        },
      ],
    ]);

    const selectedItemCountsDeadZone = new Map([
      ["kb-1", 0],
      ["kb-2", 5],
    ]);

    const summary2 = await buildLandscapeCommunityComparison({
      knowledgeIds: ["kb-1", "kb-2"],
      relationAssignmentsByKnowledgeId: relationAssignmentsDeadZone,
      selectedItemCountByKnowledgeId: selectedItemCountsDeadZone,
      minSimilarity: 0.7,
      semanticTopK: 5,
    });

    expect(summary2.communities).toHaveLength(1);
    expect(summary2.communities[0].comparison).toBe("semantic_reachable_dead_zone");
    expect(summary2.communities[0].deadZoneSemanticReachabilityScore).toBeGreaterThan(0);
  });
});
