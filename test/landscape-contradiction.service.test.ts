import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  buildGraphSnapshotMock,
  loadContradictionKnowledgeRowsMock,
  loadRecentSelectionCountByKnowledgeIdMock,
  loadSemanticNeighborPairsMock,
} = vi.hoisted(() => ({
  buildGraphSnapshotMock: vi.fn(),
  loadContradictionKnowledgeRowsMock: vi.fn(),
  loadRecentSelectionCountByKnowledgeIdMock: vi.fn(),
  loadSemanticNeighborPairsMock: vi.fn(),
}));

vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: buildGraphSnapshotMock,
}));

vi.mock("../src/modules/landscape/landscape-contradiction.repository.js", async () => {
  const actual = await vi.importActual(
    "../src/modules/landscape/landscape-contradiction.repository.js",
  );
  return {
    ...actual,
    loadContradictionKnowledgeRows: loadContradictionKnowledgeRowsMock,
    loadRecentSelectionCountByKnowledgeId: loadRecentSelectionCountByKnowledgeIdMock,
    loadSemanticNeighborPairs: loadSemanticNeighborPairsMock,
  };
});

import { buildLandscapeContradictionCandidates } from "../src/modules/landscape/landscape-contradiction.service.js";

describe("landscape contradiction service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadRecentSelectionCountByKnowledgeIdMock.mockResolvedValue(new Map());
    loadSemanticNeighborPairsMock.mockResolvedValue(new Map());
    buildGraphSnapshotMock.mockResolvedValue({
      nodes: [
        {
          id: "knowledge:k-left",
          kind: "knowledge",
          communityKey: "a".repeat(64),
          communityLabel: "Core",
        },
        {
          id: "knowledge:k-right",
          kind: "knowledge",
          communityKey: "a".repeat(64),
          communityLabel: "Core",
        },
      ],
    });
  });

  test("detects scoped must/avoid contradiction", async () => {
    loadContradictionKnowledgeRowsMock.mockResolvedValue([
      {
        id: "k-left",
        type: "rule",
        status: "active",
        title: "Retry policy must include timeout",
        body: "For network mutation, we must enforce timeout and retry budget.",
        appliesTo: {
          repoKey: "memoryrouter",
          technologies: ["typescript"],
          changeTypes: ["implementation"],
          domains: ["graph-ui"],
        },
        compileSelectCount: 10,
        dynamicScore: 90,
        lastCompiledAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
      {
        id: "k-right",
        type: "procedure",
        status: "active",
        title: "Avoid timeout retries on mutation",
        body: "Do not retry timeout mutation path in critical section.",
        appliesTo: {
          repoKey: "memoryrouter",
          technologies: ["typescript"],
          changeTypes: ["implementation"],
          domains: ["graph-ui"],
        },
        compileSelectCount: 9,
        dynamicScore: 88,
        lastCompiledAt: new Date("2026-05-24T00:00:00.000Z"),
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    ]);

    const result = await buildLandscapeContradictionCandidates({
      windowDays: 30,
      knowledgeLimit: 100,
      candidateLimit: 20,
      landscapeStatus: "all",
      relationAxes: ["session", "project", "source"],
      semanticMinSimilarity: 0.82,
      confidenceThreshold: 0.62,
      recentSelectionMin: 2,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        leftKnowledgeId: "k-left",
        rightKnowledgeId: "k-right",
        relationNeighbor: true,
      }),
    );
    expect(["medium", "high"]).toContain(result[0]?.confidenceLabel);
  });

  test("ignores unrelated appliesTo scopes", async () => {
    loadContradictionKnowledgeRowsMock.mockResolvedValue([
      {
        id: "k-left",
        type: "rule",
        status: "active",
        title: "must use timeout",
        body: "must timeout",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 10,
        dynamicScore: 90,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
      {
        id: "k-right",
        type: "rule",
        status: "active",
        title: "avoid timeout",
        body: "avoid timeout",
        appliesTo: { repoKey: "another-repo", technologies: ["go"] },
        compileSelectCount: 9,
        dynamicScore: 88,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    ]);

    const result = await buildLandscapeContradictionCandidates({
      windowDays: 30,
      knowledgeLimit: 100,
      candidateLimit: 20,
      landscapeStatus: "all",
      relationAxes: ["session", "project", "source"],
      semanticMinSimilarity: 0.82,
      confidenceThreshold: 0.62,
      recentSelectionMin: 2,
    });

    expect(result).toHaveLength(0);
  });

  test("ignores low confidence pairs without neighborhood", async () => {
    loadContradictionKnowledgeRowsMock.mockResolvedValue([
      {
        id: "k-left",
        type: "rule",
        status: "active",
        title: "must include timeout",
        body: "must include timeout",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 10,
        dynamicScore: 90,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
      {
        id: "k-right",
        type: "procedure",
        status: "active",
        title: "avoid timeout",
        body: "avoid timeout",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 10,
        dynamicScore: 90,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    ]);
    buildGraphSnapshotMock.mockResolvedValue({ nodes: [] });
    loadSemanticNeighborPairsMock.mockResolvedValue(new Map());

    const result = await buildLandscapeContradictionCandidates({
      windowDays: 30,
      knowledgeLimit: 100,
      candidateLimit: 20,
      landscapeStatus: "all",
      relationAxes: ["session", "project", "source"],
      semanticMinSimilarity: 0.82,
      confidenceThreshold: 0.62,
      recentSelectionMin: 2,
    });

    expect(result).toHaveLength(0);
  });

  test("pair key is stable across runs", async () => {
    loadContradictionKnowledgeRowsMock.mockResolvedValue([
      {
        id: "k-left",
        type: "rule",
        status: "active",
        title: "must include timeout",
        body: "must include timeout",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 10,
        dynamicScore: 90,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
      {
        id: "k-right",
        type: "procedure",
        status: "active",
        title: "avoid timeout",
        body: "avoid timeout",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 9,
        dynamicScore: 88,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    ]);

    const first = await buildLandscapeContradictionCandidates({
      windowDays: 30,
      knowledgeLimit: 100,
      candidateLimit: 20,
      landscapeStatus: "all",
      relationAxes: ["session", "project", "source"],
      semanticMinSimilarity: 0.82,
      confidenceThreshold: 0.62,
      recentSelectionMin: 2,
    });
    const second = await buildLandscapeContradictionCandidates({
      windowDays: 30,
      knowledgeLimit: 100,
      candidateLimit: 20,
      landscapeStatus: "all",
      relationAxes: ["session", "project", "source"],
      semanticMinSimilarity: 0.82,
      confidenceThreshold: 0.62,
      recentSelectionMin: 2,
    });

    expect(first[0]?.pairKey).toBe(second[0]?.pairKey);
  });

  test("does not treat substring marker text as polarity marker", async () => {
    loadContradictionKnowledgeRowsMock.mockResolvedValue([
      {
        id: "k-left",
        type: "rule",
        status: "active",
        title: "Mustache style guideline",
        body: "Use mustache renderer style settings for templates.",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 4,
        dynamicScore: 72,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
      {
        id: "k-right",
        type: "procedure",
        status: "active",
        title: "avoid style regressions",
        body: "avoid style drift in renderer templates",
        appliesTo: { repoKey: "memoryrouter", technologies: ["typescript"] },
        compileSelectCount: 5,
        dynamicScore: 75,
        lastCompiledAt: null,
        updatedAt: new Date("2026-05-24T00:00:00.000Z"),
      },
    ]);

    const result = await buildLandscapeContradictionCandidates({
      windowDays: 30,
      knowledgeLimit: 100,
      candidateLimit: 20,
      landscapeStatus: "all",
      relationAxes: ["session", "project", "source"],
      semanticMinSimilarity: 0.82,
      confidenceThreshold: 0.62,
      recentSelectionMin: 2,
    });

    expect(result).toHaveLength(0);
  });
});
