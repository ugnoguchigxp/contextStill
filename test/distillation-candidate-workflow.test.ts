import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  runDistillationCandidateWorkflow,
  type DistillationAcceptedCandidateEntry,
} from "../src/modules/distillation/distillation-candidate-workflow.js";
import {
  distillationToolEventsFromError,
  errorWithDistillationToolEvents,
} from "../src/modules/distillation/distillation-runtime.service.js";
import * as candidateRepo from "../src/modules/distillation/distillation-candidate.repository.js";

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
    confidenceProvided: row.confidence !== undefined && row.confidence !== null,
    importanceProvided: row.importance !== undefined && row.importance !== null,
  })),
  listUnevaluatedDistillationCandidates: vi.fn(),
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

function searchToolEvent(callId = "search-1") {
  return {
    callId,
    name: "search_web",
    ok: true,
    content: "Search evidence",
  };
}

function verificationCompletion(candidates: unknown[], toolEvents = [searchToolEvent()]) {
  return {
    content: JSON.stringify({ candidates }),
    toolEvents,
    messages: [],
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    sourceKind: "vibe_memory",
    vibeMemoryId: "memory-1",
    sourceFragmentId: null,
    candidateIndex: 0,
    type: "rule",
    title: "Stored rule",
    body: "Stored reusable guidance with enough detail for promotion.",
    confidence: 80,
    importance: 70,
    toolEvents: [searchToolEvent()],
    ...overrides,
  };
}

describe("distillation candidate workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(candidateRepo.listUnevaluatedDistillationCandidates).mockResolvedValue([]);
    vi.mocked(candidateRepo.listPromotionReadyDistillationCandidates).mockResolvedValue([]);
    vi.mocked(candidateRepo.claimDistillationCandidateForEvaluation).mockImplementation((id) =>
      Promise.resolve({ id } as any),
    );
  });

  test("prioritizes unevaluated stored candidates over a new extraction call", async () => {
    vi.mocked(candidateRepo.listUnevaluatedDistillationCandidates).mockResolvedValue([
      row({ id: "stored-candidate", candidateIndex: 2 }) as any,
    ]);
    const modelClient = vi.fn(async () =>
      verificationCompletion([
        {
          type: "rule",
          title: "Verified stored rule",
          body: "Verified reusable guidance with enough detail for later coding agents.",
          confidence: 88,
          importance: 77,
        },
      ]),
    );

    const result = await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "vibe_memory", vibeMemoryId: "memory-1" },
      distillationSourceKind: "vibe_memory",
      messages: [{ role: "user", content: "source evidence" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
    });

    expect(result.usedStoredCandidates).toBe(true);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(["Verified stored rule"]);
    expect(modelClient).toHaveBeenCalledTimes(1);
    expect(candidateRepo.upsertExtractedDistillationCandidates).not.toHaveBeenCalled();
    expect(candidateRepo.claimDistillationCandidateForEvaluation).toHaveBeenCalledWith(
      "stored-candidate",
    );
    expect(candidateRepo.updateDistillationCandidateEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "stored-candidate",
        status: "verified",
      }),
    );
  });

  test("saves multiple extracted candidates before running per-candidate verification", async () => {
    const modelClient = vi.fn(async (_request, options) => {
      if (options?.enableTools === false) {
        return JSON.stringify({
          candidates: [
            {
              type: "rule",
              title: "Rule A",
              body: "Rule A reusable extraction body with enough implementation detail.",
              confidence: 82,
              importance: 72,
            },
            {
              type: "procedure",
              title: "Procedure B",
              body: "Procedure B reusable extraction body with enough implementation detail.",
              confidence: 80,
              importance: 74,
            },
          ],
        });
      }
      return verificationCompletion(
        [
          {
            type: "rule",
            title: "Verified",
            body: "Verified reusable guidance with enough detail for later coding agents.",
            confidence: 90,
            importance: 80,
          },
        ],
        [searchToolEvent(`search-${options?.auditContext?.candidateIndex ?? "x"}`)],
      );
    });

    const result = await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
      distillationSourceKind: "wiki",
      messages: [{ role: "user", content: "source evidence" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
    });

    const accepted: DistillationAcceptedCandidateEntry[] = result.acceptedEntries;
    expect(candidateRepo.upsertExtractedDistillationCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ title: "Rule A" }),
          expect.objectContaining({ title: "Procedure B" }),
        ]),
      }),
    );
    expect(modelClient).toHaveBeenCalledTimes(3);
    expect(result.extractionCandidateCount).toBe(2);
    expect(result.verificationCandidateCount).toBe(2);
    expect(result.verificationAttemptCount).toBe(2);
    expect(result.rawCandidateCount).toBe(2);
    expect(result.verificationSessionCount).toBe(2);
    expect(accepted).toHaveLength(2);
  });

  test("passes Agentic Reader tool evidence into the verification session", async () => {
    const verificationEvidence: string[] = [];
    const modelClient = vi.fn(
      async (
        request: { messages: Array<{ content?: string | null }> },
        options?: { toolNames?: readonly string[] },
      ) => {
        if (options?.toolNames?.includes("read_source_segment")) {
          return {
            content: JSON.stringify({
              candidates: [
                {
                  type: "rule",
                  title: "Reader rule",
                  body: "Reader extracted reusable guidance with enough implementation detail.",
                },
              ],
            }),
            toolEvents: [],
            messages: [
              { role: "user" as const, content: "catalog only" },
              { role: "tool" as const, content: "Read segment body for verification" },
            ],
          };
        }
        verificationEvidence.push(
          request.messages.map((message) => message.content ?? "").join("\n"),
        );
        return {
          content: JSON.stringify({
            candidates: [
              {
                type: "rule",
                title: "Verified reader rule",
                body: "Verified reader guidance with enough detail for later coding agents.",
              },
            ],
          }),
          toolEvents: [searchToolEvent()],
          messages: [],
        };
      },
    );

    await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
      distillationSourceKind: "wiki",
      messages: [{ role: "user", content: "source catalog" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
      readerContext: {
        enabled: true,
        apply: true,
        jobId: "job-1",
        source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
        segments: [],
        maxReads: 4,
        maxCharsPerRead: 4000,
        readCount: 0,
        readLocators: ["locator-1"],
      },
    });

    expect(verificationEvidence.join("\n")).toContain("Read segment body for verification");
  });

  test("rebuilds stored candidate evidence from saved reader locators", async () => {
    vi.mocked(candidateRepo.listUnevaluatedDistillationCandidates).mockResolvedValue([
      row({
        id: "stored-reader-candidate",
        sourceKind: "source_fragment",
        sourceFragmentId: "fragment-1",
        vibeMemoryId: null,
        metadata: { readLocators: ["locator-1"] },
      }) as any,
    ]);
    const verificationEvidence: string[] = [];
    const modelClient = vi.fn(async (request: { messages: Array<{ content?: string | null }> }) => {
      verificationEvidence.push(
        request.messages.map((message) => message.content ?? "").join("\n"),
      );
      return verificationCompletion([
        {
          type: "rule",
          title: "Verified stored reader rule",
          body: "Verified stored reader guidance with enough detail for later coding agents.",
        },
      ]);
    });

    await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
      distillationSourceKind: "wiki",
      messages: [{ role: "user", content: "source catalog without body" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
      readerContext: {
        enabled: true,
        apply: true,
        jobId: "job-1",
        source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
        segments: [
          {
            locator: "locator-1",
            label: "Stored segment",
            content: "Stored segment body for verification",
            charCount: 36,
          },
        ],
        maxReads: 4,
        maxCharsPerRead: 4000,
        readCount: 0,
        readLocators: [],
      },
    });

    expect(verificationEvidence.join("\n")).toContain("Stored segment body for verification");
  });

  test("promotes verified candidates without re-running extraction or verification", async () => {
    vi.mocked(candidateRepo.listPromotionReadyDistillationCandidates).mockResolvedValue([
      row({ id: "verified-candidate", status: "verified", title: "Already verified" }) as any,
    ]);
    const modelClient = vi.fn(async () => {
      throw new Error("model should not be called");
    });

    const result = await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "vibe_memory", vibeMemoryId: "memory-1" },
      distillationSourceKind: "vibe_memory",
      messages: [{ role: "user", content: "source evidence" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
    });

    expect(result.usedStoredCandidates).toBe(true);
    expect(result.verificationCandidateCount).toBe(1);
    expect(result.verificationAttemptCount).toBe(0);
    expect(result.verificationSessionCount).toBe(0);
    expect(result.acceptedEntries).toHaveLength(1);
    expect(result.acceptedEntries[0]?.candidateRowId).toBe("verified-candidate");
    expect(modelClient).not.toHaveBeenCalled();
  });

  test("rechecks verified candidates that predate tool evidence before promotion", async () => {
    vi.mocked(candidateRepo.listPromotionReadyDistillationCandidates).mockResolvedValue([
      row({ id: "stale-verified", status: "verified", toolEvents: [] }) as any,
    ]);
    vi.mocked(candidateRepo.listUnevaluatedDistillationCandidates).mockResolvedValue([
      row({ id: "stale-verified", status: "failed", toolEvents: [] }) as any,
    ]);
    const modelClient = vi.fn(async () =>
      verificationCompletion([
        {
          type: "rule",
          title: "Reverified rule",
          body: "Reverified reusable guidance with enough detail for later coding agents.",
          confidence: 88,
          importance: 77,
        },
      ]),
    );

    const result = await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "vibe_memory", vibeMemoryId: "memory-1" },
      distillationSourceKind: "vibe_memory",
      messages: [{ role: "user", content: "source evidence" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
    });

    expect(result.acceptedEntries).toHaveLength(1);
    expect(modelClient).toHaveBeenCalledTimes(1);
    expect(candidateRepo.updateDistillationCandidateEvaluation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: "stale-verified",
        status: "failed",
        rejectionReason: "verification_tool_evidence_missing",
        metadata: expect.objectContaining({
          previousStatus: "verified",
        }),
      }),
    );
    expect(candidateRepo.updateDistillationCandidateEvaluation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "stale-verified",
        status: "verified",
      }),
    );
  });

  test("keeps apply candidates retryable when verification omits required tool evidence", async () => {
    const modelClient = vi.fn(async (_request, options) => {
      if (options?.enableTools === false) {
        return JSON.stringify({
          candidates: [
            {
              type: "rule",
              title: "Rule A",
              body: "Rule A reusable extraction body with enough implementation detail.",
              confidence: 82,
              importance: 72,
            },
          ],
        });
      }
      return verificationCompletion(
        [
          {
            type: "rule",
            title: "Verified without tools",
            body: "Verified body with enough detail but without required tool evidence.",
            confidence: 82,
            importance: 72,
          },
        ],
        [],
      );
    });

    const result = await runDistillationCandidateWorkflow({
      apply: true,
      source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
      distillationSourceKind: "wiki",
      messages: [{ role: "user", content: "source evidence" }],
      modelClient,
      model: "test-model",
      maxTokens: 500,
      promptVersion: "prompt-v1",
    });

    expect(result.acceptedEntries).toHaveLength(0);
    expect(result.failedCandidateCount).toBe(1);
    expect(candidateRepo.updateDistillationCandidateEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "candidate-0",
        status: "failed",
        rejectionReason: "verification_tool_evidence_missing",
        metadata: expect.objectContaining({
          missingVerificationToolEvidence: true,
          failureKind: "verification_tool_evidence",
        }),
      }),
    );
  });

  test("keeps verification tool evidence on failed candidate errors", async () => {
    const toolEvent = searchToolEvent("search-before-timeout");
    const modelClient = vi.fn(async (_request, options) => {
      if (options?.enableTools === false) {
        return JSON.stringify({
          candidates: [
            {
              type: "rule",
              title: "Rule A",
              body: "Rule A reusable extraction body with enough implementation detail.",
            },
          ],
        });
      }
      throw errorWithDistillationToolEvents(
        new Error("distillation LLM request timed out after 300000ms"),
        [toolEvent],
      );
    });

    let thrown: unknown;
    try {
      await runDistillationCandidateWorkflow({
        apply: true,
        source: { sourceKind: "source_fragment", sourceFragmentId: "fragment-1" },
        distillationSourceKind: "wiki",
        messages: [{ role: "user", content: "source evidence" }],
        modelClient,
        model: "test-model",
        maxTokens: 500,
        promptVersion: "prompt-v1",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(distillationToolEventsFromError(thrown)).toEqual([toolEvent]);
    expect(candidateRepo.updateDistillationCandidateEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "candidate-0",
        status: "failed",
        toolEvents: [toolEvent],
        metadata: expect.objectContaining({
          failureKind: "verification",
          toolEventCount: 1,
        }),
      }),
    );
  });

  test("does not evaluate a candidate already claimed by another worker", async () => {
    vi.mocked(candidateRepo.listUnevaluatedDistillationCandidates).mockResolvedValue([
      row({ id: "claimed-candidate" }) as any,
    ]);
    vi.mocked(candidateRepo.claimDistillationCandidateForEvaluation).mockResolvedValue(null);
    const modelClient = vi.fn(async () => JSON.stringify({ candidates: [] }));

    await expect(
      runDistillationCandidateWorkflow({
        apply: true,
        source: { sourceKind: "vibe_memory", vibeMemoryId: "memory-1" },
        distillationSourceKind: "vibe_memory",
        messages: [{ role: "user", content: "source evidence" }],
        modelClient,
        model: "test-model",
        maxTokens: 500,
        promptVersion: "prompt-v1",
      }),
    ).rejects.toThrow("already claimed");

    expect(modelClient).not.toHaveBeenCalled();
  });
});
