import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildLandscapeTrajectory } from "../src/modules/landscape/landscape-trajectory.service.js";

const { loadLandscapeTrajectoryMock } = vi.hoisted(() => ({
  loadLandscapeTrajectoryMock: vi.fn(),
}));

const { findContextCompileTaskTraceByRunIdMock, listRecentContextCompileTaskTracesMock } =
  vi.hoisted(() => ({
    findContextCompileTaskTraceByRunIdMock: vi.fn(),
    listRecentContextCompileTaskTracesMock: vi.fn(),
  }));

vi.mock("../src/modules/landscape/landscape-trajectory.repository.js", () => ({
  loadLandscapeTrajectory: loadLandscapeTrajectoryMock,
}));

vi.mock("../src/modules/context-compiler/context-compile-task-trace.repository.js", () => ({
  findContextCompileTaskTraceByRunId: findContextCompileTaskTraceByRunIdMock,
  listRecentContextCompileTaskTraces: listRecentContextCompileTaskTracesMock,
}));

describe("landscape trajectory service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findContextCompileTaskTraceByRunIdMock.mockResolvedValue(null);
    listRecentContextCompileTaskTracesMock.mockResolvedValue([]);
  });

  test("returns trajectory payload with diagnostics and limit warning", async () => {
    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-1",
        goal: "trace me",
        retrievalMode: "task_context",
        status: "ok",
        source: "mcp",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {
          diagnostics: {
            retrievalStats: {
              candidateTraceSavedCount: 200,
              candidateTraceTruncated: true,
              candidateTraceLimit: 200,
              candidateTraceSkippedReason: null,
            },
          },
        },
      },
      selectedKnowledgeIds: ["k1"],
      stageCounts: {
        totalCandidates: 3,
        textHit: 2,
        vectorHit: 1,
        merged: 3,
        finalRanked: 2,
        selected: 1,
        suppressed: 2,
      },
      candidates: [
        {
          itemKind: "rule",
          itemId: "k1",
          textRank: 1,
          textScore: 0.9,
          vectorRank: null,
          vectorScore: null,
          mergedRank: 1,
          mergedScore: 0.9,
          finalRank: 1,
          finalScore: 0.9,
          selected: true,
          suppressed: false,
          suppressionReason: null,
          agenticDecision: "accepted",
          rankingReason: "selected",
          communityKey: null,
        },
      ],
      communitySummary: [],
    });

    const result = await buildLandscapeTrajectory({
      runId: "run-1",
      includeCandidates: true,
      limit: 1,
    });

    expect(result).not.toBeNull();
    expect(result?.traceAvailable).toBe(true);
    expect(result?.warnings).toContain("candidate trace was truncated at compile time");
    expect(result?.warnings).toContain("candidate list truncated by query limit");
    expect(result?.diagnostics.candidateTraceSavedCount).toBe(200);
    expect(result?.stageCounts.totalCandidates).toBe(3);
  });

  test("reports trace unavailable when candidate trace rows are missing", async () => {
    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-2",
        goal: "missing trace",
        retrievalMode: "task_context",
        status: "degraded",
        source: "cli",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {},
      },
      selectedKnowledgeIds: [],
      stageCounts: {
        totalCandidates: 0,
        textHit: 0,
        vectorHit: 0,
        merged: 0,
        finalRanked: 0,
        selected: 0,
        suppressed: 0,
      },
      candidates: [],
      communitySummary: [],
    });

    const result = await buildLandscapeTrajectory({
      runId: "run-2",
      includeCandidates: true,
      limit: 50,
    });

    expect(result).not.toBeNull();
    expect(result?.traceAvailable).toBe(false);
    expect(result?.warnings).toEqual(["trace unavailable"]);
    expect(result?.diagnostics.candidateTraceSavedCount).toBeNull();
  });

  test("covers error handling for safeFindTaskTrace and safeListRecentTaskTraces", async () => {
    // 42P01 error (missing relation)
    const dbError = new Error('relation "context_compile_task_traces" does not exist');
    (dbError as any).code = "42P01";
    findContextCompileTaskTraceByRunIdMock.mockRejectedValue(dbError);
    listRecentContextCompileTaskTracesMock.mockRejectedValue(dbError);

    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-error",
        goal: "test errors",
        retrievalMode: "task_context",
        status: "ok",
        source: "mcp",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {},
      },
      selectedKnowledgeIds: [],
      stageCounts: {
        totalCandidates: 0,
        textHit: 0,
        vectorHit: 0,
        merged: 0,
        finalRanked: 0,
        selected: 0,
        suppressed: 0,
      },
      candidates: [],
      communitySummary: [],
    });

    const result = await buildLandscapeTrajectory({
      runId: "run-error",
      includeCandidates: true,
      limit: 10,
    });

    expect(result).not.toBeNull();
    expect(result?.taskTrace).toBeNull();
    expect(result?.taskSimilarity).toEqual([]);
  });

  test("covers other non-42P01 errors in safeFindTaskTrace", async () => {
    const genericError = new Error("Some other db error");
    findContextCompileTaskTraceByRunIdMock.mockRejectedValue(genericError);

    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-error",
        goal: "test errors",
        retrievalMode: "task_context",
        status: "ok",
        source: "mcp",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {},
      },
      selectedKnowledgeIds: [],
      stageCounts: {
        totalCandidates: 0,
        textHit: 0,
        vectorHit: 0,
        merged: 0,
        finalRanked: 0,
        selected: 0,
        suppressed: 0,
      },
      candidates: [],
      communitySummary: [],
    });

    await expect(
      buildLandscapeTrajectory({
        runId: "run-error",
        includeCandidates: true,
        limit: 10,
      }),
    ).rejects.toThrow("Some other db error");
  });

  test("covers isMissingTaskTraceRelationError with shaped error object and string", async () => {
    findContextCompileTaskTraceByRunIdMock.mockRejectedValue({
      code: "42P01",
      cause: { code: "42P01" },
      originalError: "undefined_table error occurred",
    });

    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-error",
        goal: "test errors",
        retrievalMode: "task_context",
        status: "ok",
        source: "mcp",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {},
      },
      selectedKnowledgeIds: [],
      stageCounts: {
        totalCandidates: 0,
        textHit: 0,
        vectorHit: 0,
        merged: 0,
        finalRanked: 0,
        selected: 0,
        suppressed: 0,
      },
      candidates: [],
      communitySummary: [],
    });

    // This should resolve to null since code "42P01" and "undefined_table" string match missing table relation error
    const result = await buildLandscapeTrajectory({
      runId: "run-error",
      includeCandidates: true,
      limit: 10,
    });
    expect(result?.taskTrace).toBeNull();
  });

  test("calculates task similarity via cosine similarity and facet similarity", async () => {
    const baseTrace = {
      runId: "run-base",
      retrievalMode: "task_context",
      repoPath: "path/a",
      repoKey: "key-a",
      technologies: ["ts", "node"],
      changeTypes: ["feat"],
      domains: ["web"],
      embedding: [0.1, 0.2, 0.3],
      embeddingStatus: "embedding_available",
      embeddingProvider: "openai",
      embeddingModel: "text-emb",
      embeddingDimensions: 3,
      goalHash: "hash-base",
      createdAt: new Date("2026-05-24T00:00:00.000Z"),
    };

    findContextCompileTaskTraceByRunIdMock.mockResolvedValue(baseTrace);

    listRecentContextCompileTaskTracesMock.mockResolvedValue([
      // Candidate 1: perfect embedding match
      {
        runId: "run-cand-1",
        retrievalMode: "task_context",
        repoPath: "path/a",
        repoKey: "key-a",
        technologies: ["ts", "node"],
        changeTypes: ["feat"],
        domains: ["web"],
        embedding: [0.1, 0.2, 0.3],
        embeddingStatus: "embedding_available",
        embeddingProvider: "openai",
        embeddingModel: "text-emb",
        embeddingDimensions: 3,
        goalHash: "hash-1",
        createdAt: new Date("2026-05-24T01:00:00.000Z"),
      },
      // Candidate 2: no embedding, falls back to facet similarity
      {
        runId: "run-cand-2",
        retrievalMode: "task_context",
        repoPath: "path/a",
        repoKey: "key-a",
        technologies: ["ts"], // jaccard = 1/2 = 0.5
        changeTypes: [], // jaccard = 0
        domains: ["web"], // jaccard = 1
        embedding: null,
        embeddingStatus: "embedding_unavailable",
        embeddingProvider: "openai",
        embeddingModel: "text-emb",
        embeddingDimensions: 3,
        goalHash: "hash-2",
        createdAt: new Date("2026-05-24T02:00:00.000Z"),
      },
      // Candidate 3: empty arrays / no match
      {
        runId: "run-cand-3",
        retrievalMode: "other",
        repoPath: "path/b",
        repoKey: "key-b",
        technologies: [],
        changeTypes: [],
        domains: [],
        embedding: null,
        embeddingStatus: "embedding_unavailable",
        embeddingProvider: "openai",
        embeddingModel: "text-emb",
        embeddingDimensions: 3,
        goalHash: "hash-3",
        createdAt: new Date("2026-05-24T03:00:00.000Z"),
      },
    ]);

    loadLandscapeTrajectoryMock.mockResolvedValue({
      run: {
        id: "run-base",
        goal: "test similarity",
        retrievalMode: "task_context",
        status: "ok",
        source: "mcp",
        createdAt: new Date("2026-05-24T00:00:00.000Z"),
        packSnapshot: {},
      },
      selectedKnowledgeIds: [],
      stageCounts: {
        totalCandidates: 0,
        textHit: 0,
        vectorHit: 0,
        merged: 0,
        finalRanked: 0,
        selected: 0,
        suppressed: 0,
      },
      candidates: [],
      communitySummary: [],
    });

    const result = await buildLandscapeTrajectory({
      runId: "run-base",
      includeCandidates: true,
      limit: 10,
    });

    expect(result).not.toBeNull();
    expect(result?.taskTrace).not.toBeNull();
    expect(result?.taskSimilarity.length).toBeGreaterThan(0);

    const sim1 = result?.taskSimilarity.find((t) => t.runId === "run-cand-1");
    expect(sim1?.mode).toBe("embedding");
    expect(sim1?.similarity).toBeCloseTo(1.0, 4);

    const sim2 = result?.taskSimilarity.find((t) => t.runId === "run-cand-2");
    expect(sim2?.mode).toBe("facets");
    expect(sim2?.similarity).toBeGreaterThan(0);
  });
});
