import { describe, expect, test, vi, beforeEach } from "vitest";
import { distillSources } from "../src/modules/sources/distillation.service.js";
import {
  listSourceFragmentsForDistillation,
  upsertSourceDistillationRun,
  recordSourceDistillationState,
} from "../src/modules/sources/distillation.repository.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import {
  distillationToolEventsFromError,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";
import { checkKnowledgeDuplicate } from "../src/lib/knowledge-dedup.js";

vi.mock("../src/modules/sources/distillation.repository.js");
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

describe("Source Distillation Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSourceFragmentsForDistillation).mockResolvedValue([
      {
        id: "f1",
        sourceId: "s1",
        sourceKind: "wiki",
        sourceUri: "wiki/test",
        sourceContentHash: "hash1",
        content: "Fragment content",
        locator: "L1",
        sourceMetadata: {},
      } as any,
    ]);
    vi.mocked(upsertSourceDistillationRun).mockResolvedValue({ id: "run1" } as any);
    vi.mocked(checkKnowledgeDuplicate).mockResolvedValue({ isDuplicate: false });
    vi.mocked(distillationToolEventsFromError).mockReturnValue([]);
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

    const summary = await distillSources({ apply: false });

    expect(summary.processed).toBe(1);
    expect(summary.knowledgeCount).toBe(0);
    expect(summary.results[0].status).toBe("dry_run");
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

    const summary = await distillSources({ apply: true });

    expect(summary.knowledgeCount).toBe(1);
    expect(summary.results[0].status).toBe("ok");
    expect(upsertKnowledgeFromSource).toHaveBeenCalled();
  });

  test("handles error during distillation", async () => {
    vi.mocked(runDistillationCompletion).mockRejectedValue(new Error("LLM Down"));

    const summary = await distillSources({ apply: true });

    expect(summary.failed).toBe(1);
    expect(summary.results[0].status).toBe("failed");
    expect(summary.results[0].error).toBe("LLM Down");
  });
});
