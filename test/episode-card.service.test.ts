import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  backfillEpisodeFromCompileRun,
  buildEpisodeInputFromCompileRun,
} from "../src/modules/episodic-memory/episode-card.service.js";
import { getCompileRunDetail } from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  createEpisodeCard,
  getEpisodeCardBySource,
} from "../src/modules/episodic-memory/episode-card.repository.js";

vi.mock("../src/modules/context-compiler/context-compiler.repository.js", () => ({
  getCompileRunDetail: vi.fn(),
}));

vi.mock("../src/modules/episodic-memory/episode-card.repository.js", () => ({
  createEpisodeCard: vi.fn(),
  getEpisodeCard: vi.fn(),
  getEpisodeCardBySource: vi.fn(),
  searchEpisodeCards: vi.fn(),
}));

const compileDetail = {
  run: {
    id: "550e8400-e29b-41d4-a716-446655440000",
    goal: "Wire EpisodeCard backfill into compile history",
    retrievalMode: "task_context",
    status: "ok",
    degradedReasons: [],
    durationMs: 123,
    source: "mcp",
    evalSummary: {
      count: 1,
      latestAvg: 93,
      averageAvg: 93,
      latestOutcome: "useful",
      latestEvaluatedAt: "2026-06-20T00:00:00.000Z",
    },
    createdAt: "2026-06-20T00:00:00.000Z",
    tokenBudget: 1200,
    input: {
      technologies: ["typescript"],
      changeTypes: ["feature"],
      domains: ["episodic-memory"],
      repoPath: "/repo/contextStill",
      repoKey: "contextStill",
    },
  },
  pack: {
    runId: "550e8400-e29b-41d4-a716-446655440000",
    goal: "Wire EpisodeCard backfill into compile history",
    retrievalMode: "task_context",
    status: "ok",
    minimalTasks: [],
    rules: [
      {
        id: "knowledge:k1",
        itemKind: "rule",
        itemId: "k1",
        section: "rules",
        title: "Keep source refs",
        content: "Use sourceRefs consistently.",
        score: 0.9,
        rankingReason: "test",
        sourceRefs: ["src/modules/episodic-memory/episode-card.service.ts"],
      },
    ],
    procedures: [],
    guardrails: [],
    warnings: [],
    sourceRefs: ["context-still://packs/run/550e8400-e29b-41d4-a716-446655440000#full"],
    diagnostics: { degradedReasons: [], retrievalStats: {} },
  },
  outputMarkdown: "Use sourceRefs consistently when creating EpisodeCards.",
  selectedItems: [
    {
      itemKind: "rule",
      itemId: "k1",
      section: "rules",
      score: 0.9,
      rankingReason: "test",
      sourceRefs: ["src/modules/episodic-memory/episode-card.service.ts"],
    },
  ],
  knowledgeFeedback: [],
  knowledgeSignals: [],
  evaluations: [],
  snapshotAvailable: true,
};

describe("episode-card service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCompileRunDetail).mockResolvedValue(compileDetail as never);
    vi.mocked(getEpisodeCardBySource).mockResolvedValue(null);
    vi.mocked(createEpisodeCard).mockImplementation(
      async (input) =>
        ({
          ...input,
          id: "episode-created",
          staleAt: null,
          createdAt: new Date("2026-06-20T00:00:00.000Z"),
          updatedAt: new Date("2026-06-20T00:00:00.000Z"),
          refs: [],
        }) as never,
    );
  });

  test("builds an EpisodeCard input from a compile run", async () => {
    const input = await buildEpisodeInputFromCompileRun("550e8400-e29b-41d4-a716-446655440000");
    expect(input).toEqual(
      expect.objectContaining({
        sourceKind: "compile_run",
        sourceKey: "550e8400-e29b-41d4-a716-446655440000",
        outcomeKind: "success",
        evidenceStatus: "verified",
        confidence: 93,
        technologies: ["typescript"],
        changeTypes: ["feature"],
        domains: ["episodic-memory"],
      }),
    );
    expect(input?.refs?.map((ref) => ref.refKind)).toContain("compile_run");
  });

  test("writes a compile run backfill when requested", async () => {
    const result = await backfillEpisodeFromCompileRun({
      runId: "550e8400-e29b-41d4-a716-446655440000",
      write: true,
    });
    expect(result.status).toBe("created");
    expect(getEpisodeCardBySource).toHaveBeenCalledWith({
      sourceKind: "compile_run",
      sourceKey: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(createEpisodeCard).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "compile_run",
        sourceKey: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );
  });
});
