import { beforeEach, describe, expect, test, vi } from "vitest";
import * as knowledgeDedup from "../src/lib/knowledge-dedup.js";
import * as embeddingService from "../src/modules/embedding/embedding.service.js";
import * as knowledgeRepo from "../src/modules/knowledge/knowledge.repository.js";
import * as distillationRepo from "../src/modules/sources/distillation.repository.js";
import type { SourceFragmentForDistillation } from "../src/modules/sources/distillation.repository.js";
import {
  buildSourceDistillationInputHash,
  buildSourceDistillationMessages,
  distillSources,
} from "../src/modules/sources/distillation.service.js";

vi.mock("../src/modules/sources/distillation.repository.js", () => ({
  listSourceFragmentsForDistillation: vi.fn(),
  linkKnowledgeToSourceFragment: vi.fn().mockResolvedValue(undefined),
  recordSourceDistillationEvidence: vi.fn().mockResolvedValue(undefined),
  recordSourceDistillationState: vi.fn().mockResolvedValue(undefined),
  upsertSourceDistillationRun: vi.fn().mockResolvedValue({ id: "run-1" }),
}));

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

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  upsertKnowledgeFromSource: vi.fn(),
}));

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn(),
}));

vi.mock("../src/lib/knowledge-dedup.js", () => ({
  checkKnowledgeDuplicate: vi.fn().mockResolvedValue({ isDuplicate: false }),
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    sourceDistillationRunStarted: "STARTED",
    sourceDistillationRunFinished: "FINISHED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/modules/distillation/distillation-job.service.js", () => ({
  beginDistillationJob: vi.fn().mockResolvedValue({ id: "job-1" }),
  checkDistillationCircuitBreaker: vi.fn().mockResolvedValue({ allowed: true }),
  pauseJobForCircuitBreaker: vi.fn().mockResolvedValue(undefined),
  shouldPauseDistillationPromotion: vi.fn().mockResolvedValue({
    paused: false,
    draftCount: 0,
    threshold: 50,
  }),
}));

vi.mock("../src/modules/distillation/distillation-job.repository.js", () => ({
  finishDistillationJob: vi.fn().mockResolvedValue(undefined),
  updateDistillationJobPhase: vi.fn().mockResolvedValue(undefined),
}));

function fragment(
  overrides: Partial<SourceFragmentForDistillation> = {},
): SourceFragmentForDistillation {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    sourceId: "00000000-0000-4000-8000-000000000200",
    sourceKind: "wiki",
    sourceUri: "/tmp/wiki/rules.md",
    sourceTitle: "Rules",
    sourceContentHash: "hash-a",
    locator: "chunk:0001",
    heading: "Rules",
    content: "# Rules\nUse repository-local verify before committing.",
    metadata: {},
    sourceMetadata: {},
    createdAt: new Date("2026-05-15T00:00:00.000Z"),
    ...overrides,
  };
}

function searchToolEvent() {
  return {
    callId: "search-1",
    name: "search_web",
    ok: true,
    content: "Search evidence",
  };
}

describe("source distillation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("builds wiki prompt with confidence, importance, and tool constraints", () => {
    const messages = buildSourceDistillationMessages({
      fragment: fragment(),
      maxInputChars: 4000,
    });
    const prompt = messages.map((message) => message.content).join("\n");

    expect(prompt).toContain("知識タイプは rule と procedure のみ");
    expect(prompt).toContain("SOURCE_FRAGMENT_CONTENT");
  });

  test("input hash changes when source fragment content changes", () => {
    const base = buildSourceDistillationInputHash(fragment());
    const changed = buildSourceDistillationInputHash(
      fragment({ content: "# Rules\nUse a narrower focused verify command first." }),
    );

    expect(changed).not.toBe(base);
  });

  test("distillSources orchestrates the full flow with tolerant non-JSON parsing", async () => {
    (distillationRepo.listSourceFragmentsForDistillation as any).mockResolvedValue([fragment()]);
    (knowledgeRepo.upsertKnowledgeFromSource as any).mockResolvedValue("k-1");
    (embeddingService.embedOne as any).mockResolvedValue([0.1]);

    let callCount = 0;
    const modelClient = async (_request: unknown, options?: { enableTools?: boolean }) => {
      callCount++;
      const content =
        "TYPE: rule\nTITLE: Test\nBODY: Test body with reusable implementation guidance\nCONFIDENCE: 90\nIMPORTANCE: 82";
      if (options?.enableTools === false) return content;
      return {
        content,
        toolEvents: [searchToolEvent()],
        messages: [],
      };
    };

    const result = await distillSources({
      apply: true,
      modelClient: modelClient as any,
    });

    expect(result.knowledgeCount).toBe(1);
    expect(result.results[0].jsonRepaired).toBe(false);
    expect(callCount).toBe(2);
    expect(distillationRepo.upsertSourceDistillationRun).toHaveBeenCalled();
    expect(knowledgeDedup.checkKnowledgeDuplicate).toHaveBeenCalled();
  });

  test("skips knowledge creation if duplicate found", async () => {
    (distillationRepo.listSourceFragmentsForDistillation as any).mockResolvedValue([fragment()]);
    (knowledgeDedup.checkKnowledgeDuplicate as any).mockResolvedValue({
      isDuplicate: true,
      existingId: "existing-k",
      reason: "high similarity",
    });

    const modelClient = async (_request: unknown, options?: { enableTools?: boolean }) => {
      const content = JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Dup",
            body: "Duplicate candidate body with enough durable guidance.",
            confidence: 91,
            importance: 83,
          },
        ],
      });
      if (options?.enableTools === false) return content;
      return {
        content,
        toolEvents: [searchToolEvent()],
        messages: [],
      };
    };

    const result = await distillSources({
      apply: true,
      modelClient: modelClient as any,
    });

    expect(result.knowledgeCount).toBe(1);
    expect(knowledgeRepo.upsertKnowledgeFromSource).not.toHaveBeenCalled();
    expect(distillationRepo.linkKnowledgeToSourceFragment).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeId: "existing-k",
      }),
    );
  });

  test("handles fragment failure and continues", async () => {
    (distillationRepo.listSourceFragmentsForDistillation as any).mockResolvedValue([fragment()]);
    const modelClient = async () => {
      throw new Error("LLM Error");
    };

    const result = await distillSources({ apply: true, modelClient: modelClient as any });

    expect(result.failed).toBe(1);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].error).toBe("LLM Error");
  });

  test("handles global failure in distillSources", async () => {
    (distillationRepo.listSourceFragmentsForDistillation as any).mockRejectedValue(
      new Error("Global DB Error"),
    );

    await expect(distillSources({ apply: true })).rejects.toThrow("Global DB Error");
  });
});
