import { describe, expect, test, vi, beforeEach } from "vitest";
import { distillVibeMemories } from "../src/modules/vibe-memory/distillation.service.js";
import {
  listVibeMemoriesForDistillation,
  listAgentDiffEntriesForVibeMemories,
  upsertVibeMemoryDistillationRun,
  recordVibeMemoryDistillationState,
} from "../src/modules/vibe-memory/distillation.repository.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import { runDistillationCompletion } from "../src/modules/distillation/distillation-runtime.service.js";
import { checkKnowledgeDuplicate } from "../src/lib/knowledge-dedup.js";

vi.mock("../src/modules/vibe-memory/distillation.repository.js");
vi.mock("../src/modules/distillation/distillation-candidate.repository.js", () => ({
  attachDistillationCandidateRun: vi.fn().mockResolvedValue(undefined),
  claimDistillationCandidateForEvaluation: vi.fn((id: string) => Promise.resolve({ id })),
  listPromotionReadyDistillationCandidates: vi.fn().mockResolvedValue([]),
  distillationCandidateRowToCandidate: vi.fn((row: any) => ({
    type: row.type,
    title: row.title,
    body: row.body,
    confidence: row.confidence ?? 65,
    importance: row.importance ?? 55,
    score: row.score,
  })),
  listUnevaluatedDistillationCandidates: vi.fn().mockResolvedValue([]),
  markDistillationCandidateEvaluating: vi.fn().mockResolvedValue(undefined),
  updateDistillationCandidateEvaluation: vi.fn().mockResolvedValue(undefined),
  upsertExtractedDistillationCandidates: vi.fn((params: any) =>
    Promise.resolve(
      params.candidates.map((candidate: any, index: number) => ({
        id: `candidate-${index}`,
        sourceKind: params.source.sourceKind,
        sourceFragmentId: params.source.sourceFragmentId ?? null,
        vibeMemoryId: params.source.vibeMemoryId ?? null,
        candidateIndex: index,
        ...candidate,
      })),
    ),
  ),
}));
vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/distillation/distillation-runtime.service.js");
vi.mock("../src/lib/knowledge-dedup.js");

function searchToolEvent() {
  return {
    callId: "search-1",
    name: "search_web",
    ok: true,
    content: "Search evidence",
  };
}

describe("Vibe Memory Distillation Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listVibeMemoriesForDistillation).mockResolvedValue([
      {
        id: "v1",
        sessionId: "s1",
        content: "Memory 1",
        memoryType: "manual",
        createdAt: new Date(),
        metadata: {},
        dedupeKey: null,
        embedding: null,
      },
    ]);
    vi.mocked(listAgentDiffEntriesForVibeMemories).mockResolvedValue([]);
    vi.mocked(upsertVibeMemoryDistillationRun).mockResolvedValue({ id: "run1" } as any);
    vi.mocked(checkKnowledgeDuplicate).mockResolvedValue({ isDuplicate: false });
  });

  test("runs distillation in dry run mode", async () => {
    vi.mocked(runDistillationCompletion).mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Rule 1",
            body: "Use durable implementation guidance when preserving a rule.",
            confidence: 90,
            importance: 90,
            score: 0.9,
            sourceRefs: ["ref1"],
          },
        ],
      }),
      toolEvents: [searchToolEvent()],
      messages: [],
    });

    const summary = await distillVibeMemories({ apply: false });

    expect(summary.processed).toBe(1);
    expect(summary.knowledgeCount).toBe(0); // Dry run doesn't insert
    expect(summary.results[0].status).toBe("dry_run");
    expect(upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("applies distillation and inserts knowledge", async () => {
    vi.mocked(runDistillationCompletion).mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Rule 1",
            body: "Use durable implementation guidance when preserving a rule.",
            confidence: 90,
            importance: 90,
            score: 0.9,
            sourceRefs: ["ref1"],
          },
        ],
      }),
      toolEvents: [searchToolEvent()],
      messages: [],
    });
    vi.mocked(embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(upsertKnowledgeFromSource).mockResolvedValue("k1");

    const summary = await distillVibeMemories({ apply: true });

    expect(summary.knowledgeCount).toBe(1);
    expect(summary.results[0].status).toBe("ok");
    expect(upsertKnowledgeFromSource).toHaveBeenCalled();
    expect(recordVibeMemoryDistillationState).toHaveBeenCalled();
  });

  test("handles low score by skipping", async () => {
    vi.mocked(runDistillationCompletion).mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Low Score",
            body: "...",
            confidence: 30,
            importance: 30,
            score: 0.1,
            sourceRefs: ["ref1"],
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const summary = await distillVibeMemories({ apply: true });

    expect(summary.skipped).toBe(1);
    expect(summary.knowledgeCount).toBe(0);
    expect(summary.skipReasonCounts).toEqual({ all_candidates_missing_external_evidence: 1 });
    expect(summary.results[0].status).toBe("skipped");
  });

  test("accepts non-JSON labeled text", async () => {
    vi.mocked(runDistillationCompletion)
      .mockResolvedValueOnce({
        content:
          "TYPE: rule\nTITLE: Fixed\nBODY: Reusable guidance should include enough detail for a later coding agent.\nSCORE: 0.8",
        toolEvents: [],
        messages: [],
      })
      .mockResolvedValueOnce({
        content:
          "TYPE: rule\nTITLE: Fixed\nBODY: Reusable guidance should include enough detail for a later coding agent.\nSCORE: 0.8",
        toolEvents: [],
        messages: [],
      });

    const summary = await distillVibeMemories({ apply: false });

    expect(summary.results[0].candidates[0].title).toBe("Fixed");
  });
});
