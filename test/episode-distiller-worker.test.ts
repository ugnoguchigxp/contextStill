import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { parseLlmJsonLike } from "../src/lib/llm-output-parser.js";
import { resolveAuditedStoredProjectScopedWriteIdentity } from "../src/modules/context-compiler/project-scoped-write.js";
import {
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";
import {
  getEpisodeDistillerJobById,
  markEpisodeDistillerCompleted,
  markEpisodeDistillerFailed,
} from "../src/modules/episodeDistiller/repository.js";
import type { EpisodeDistillerJob } from "../src/modules/episodeDistiller/repository.js";
import { readEpisodeSourceDocument } from "../src/modules/episodeDistiller/source-reader.js";
import {
  failEpisodeDistillerJob,
  processEpisodeDistillerJob,
  setEpisodeDistillerTestHooksForTests,
} from "../src/modules/episodeDistiller/worker.js";
import {
  createEpisodeCard,
  getEpisodeCardBySource,
  searchEpisodeCards,
} from "../src/modules/episodic-memory/episode-card.repository.js";
import { appendQueueEvent } from "../src/modules/queue/core/events.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveEpisodeDistillerRoute,
} from "../src/modules/settings/settings.service.js";
import {
  promptMessage,
  renderPrompt,
} from "../src/modules/system-context/system-context.service.js";
import type { EpisodeCard } from "../src/shared/schemas/episode-card.schema.js";

vi.mock("../src/modules/episodeDistiller/repository.js", () => ({
  getEpisodeDistillerJobById: vi.fn(),
  markEpisodeDistillerCompleted: vi.fn(),
  markEpisodeDistillerFailed: vi.fn(),
}));

vi.mock("../src/modules/episodeDistiller/source-reader.js", () => ({
  readEpisodeSourceDocument: vi.fn(),
}));

vi.mock("../src/modules/episodic-memory/episode-card.repository.js", () => ({
  createEpisodeCard: vi.fn(),
  getEpisodeCardBySource: vi.fn(),
  searchEpisodeCards: vi.fn(),
}));

vi.mock("../src/modules/queue/core/events.js", () => ({
  appendQueueEvent: vi.fn(),
}));

vi.mock("../src/modules/context-compiler/project-scoped-write.js", () => ({
  resolveAuditedStoredProjectScopedWriteIdentity: vi.fn(),
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: vi.fn(),
  resolveEpisodeDistillerRoute: vi.fn(),
}));

vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  resolveRouteModelForProvider: vi.fn(),
  runDistillationCompletion: vi.fn(),
}));

vi.mock("../src/modules/system-context/system-context.service.js", () => ({
  renderPrompt: vi.fn(),
  promptMessage: vi.fn(),
}));

vi.mock("../src/lib/llm-output-parser.js", () => ({
  parseLlmJsonLike: vi.fn(),
}));

function job(overrides: Partial<EpisodeDistillerJob> = {}): EpisodeDistillerJob {
  return {
    id: "job-1",
    sourceKind: "vibe_memory",
    sourceKey: "mem-1",
    sourceUri: "vibe://mem-1",
    distillationVersion: "episode-distiller-v1",
    payload: {},
    status: "running",
    priority: 50,
    attemptCount: 1,
    maxAttempts: 2,
    providerPolicy: "default",
    nextRunAt: null,
    lockedBy: "worker",
    lockedAt: new Date("2026-05-21T08:00:00.000Z"),
    heartbeatAt: new Date("2026-05-21T08:00:00.000Z"),
    lastError: null,
    lastOutcomeKind: null,
    metadata: {},
    createdAt: new Date("2026-05-21T08:00:00.000Z"),
    updatedAt: new Date("2026-05-21T08:00:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

function document(overrides: Record<string, unknown> = {}) {
  const content = "Episode source document with enough tokens for distillation. ".repeat(4);
  return {
    vibeMemoryId: "mem-1",
    sessionId: "session-1",
    content,
    metadata: {},
    events: [
      {
        id: "e1",
        kind: "memory" as const,
        createdAt: "2026-05-21T08:00:00.000Z",
        filePath: "src/worker.ts",
        startOffset: 0,
        endOffset: Buffer.byteLength(content, "utf8"),
      },
    ],
    ...overrides,
  };
}

function canonical(overrides: Record<string, unknown> = {}) {
  return {
    title: "Split episode distillation",
    context: "Episode generation moved to a dedicated queue.",
    intent: "Keep candidate extraction independent.",
    keyDecisions: ["Use episodeDistiller queue."],
    actionTaken: "Implemented worker persistence and source-span refs.",
    outcome: "Episodes are generated independently of findCandidate.",
    failedApproach: "",
    reusableLesson: "Keep EpisodeCard creation idempotent.",
    usefulFutureTriggers: ["episode queue"],
    openLoops: [],
    generationKind: "task_episode",
    outcomeKind: "success",
    domains: ["episodic-memory"],
    technologies: ["typescript"],
    changeTypes: ["queue"],
    tools: ["vitest"],
    scores: {
      importance: 88,
      confidence: 82,
      reusability: 85,
      decision_density: 80,
      failure_value: 70,
      causal_clarity: 90,
      project_specificity: 60,
      evidence_quality: 85,
      compression_quality: 80,
      staleness_risk: 20,
    },
    ...overrides,
  };
}

function card(overrides: Partial<EpisodeCard> = {}): EpisodeCard {
  return {
    id: "episode-1",
    scope: "global",
    staleAt: null,
    classificationStatus: "classified",
    title: "Split episode distillation",
    situation: "Episode generation moved to a dedicated queue.",
    observations: "- Use episodeDistiller queue.",
    action: "Implemented worker persistence and source-span refs.",
    outcome: "Episodes are generated independently of findCandidate.",
    lesson: "Keep EpisodeCard creation idempotent.",
    applicability: { generationKind: "task_episode" },
    antiApplicability: {},
    domains: ["episodic-memory"],
    technologies: ["typescript"],
    changeTypes: ["queue"],
    tools: ["vitest"],
    sourceKind: "vibe_memory",
    sourceKey: "source-key",
    outcomeKind: "success",
    importance: 80,
    confidence: 80,
    compileUseCount: 0,
    decisionUseCount: 0,
    status: "active",
    metadata: {
      episodeDistillation: {
        parentVibeMemoryId: "mem-1",
        sourceStartOffset: 0,
        sourceEndOffset: 80,
      },
    },
    createdAt: new Date("2026-05-21T08:00:00.000Z"),
    updatedAt: new Date("2026-05-21T08:00:00.000Z"),
    refs: [],
    ...overrides,
  };
}

const identity = {
  contractVersion: 1 as const,
  classificationStatus: "classified" as const,
  scope: "global" as const,
  scopeMode: "global_only" as const,
  projectRef: null,
  repoKey: null,
  repoPath: null,
  matchBasis: "none" as const,
  identityFingerprint: null,
  bindingStatus: "not_applicable" as const,
};

describe("episode distiller worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.distillation.internalChunkedDistillationEnabled = false;
    setEpisodeDistillerTestHooksForTests({});
    vi.mocked(resolveAuditedStoredProjectScopedWriteIdentity).mockResolvedValue(identity);
    vi.mocked(getEpisodeDistillerJobById).mockResolvedValue(job());
    vi.mocked(readEpisodeSourceDocument).mockResolvedValue(document());
    vi.mocked(getEpisodeCardBySource).mockResolvedValue(null);
    vi.mocked(searchEpisodeCards).mockResolvedValue([]);
    vi.mocked(createEpisodeCard).mockResolvedValue(card());
    vi.mocked(markEpisodeDistillerCompleted).mockResolvedValue(undefined);
    vi.mocked(markEpisodeDistillerFailed).mockResolvedValue(undefined);
    vi.mocked(appendQueueEvent).mockResolvedValue(undefined);
    vi.mocked(ensureRuntimeSettingsLoaded).mockResolvedValue(undefined);
    vi.mocked(resolveEpisodeDistillerRoute).mockReturnValue({
      provider: "openai",
      model: "gpt-test",
      fallback: [],
      azureDeploymentSlots: [],
      localLlmModel: undefined,
    } as never);
    vi.mocked(resolveRouteModelForProvider).mockReturnValue("gpt-test");
    vi.mocked(renderPrompt).mockReturnValue({
      manifest: { id: "prompt" },
      text: "system",
    } as never);
    vi.mocked(promptMessage).mockReturnValue({ role: "system", content: "system" } as never);
  });

  afterEach(() => {
    setEpisodeDistillerTestHooksForTests({});
    groupedConfig.distillation.internalChunkedDistillationEnabled = false;
  });

  test("failEpisodeDistillerJob records the failure outcome", async () => {
    await failEpisodeDistillerJob("job-1", "provider down");
    expect(markEpisodeDistillerFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        error: "provider down",
        outcome: "failed",
      }),
    );
  });

  test("rejects missing jobs and unsupported source kinds", async () => {
    vi.mocked(getEpisodeDistillerJobById).mockResolvedValue(null);
    await expect(processEpisodeDistillerJob("missing")).rejects.toThrow(
      "episode distiller queue job not found",
    );

    vi.mocked(getEpisodeDistillerJobById).mockResolvedValue(
      job({ sourceKind: "wiki_file" as never }),
    );
    await expect(processEpisodeDistillerJob("job-1")).rejects.toThrow(
      "unsupported episode source kind",
    );
  });

  test("skips short segments and records no_episode", async () => {
    vi.mocked(readEpisodeSourceDocument).mockResolvedValue(
      document({ content: "tiny", events: [] }),
    );
    const result = await processEpisodeDistillerJob("job-1");
    expect(result).toMatchObject({
      generated: 0,
      skipped: 1,
      episodeIds: [],
    });
    expect(markEpisodeDistillerCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        outcome: "no_episode",
      }),
    );
  });

  test("throws when every segment fails to distill", async () => {
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => {
        throw new Error("parse failed");
      },
    });
    await expect(processEpisodeDistillerJob("job-1")).rejects.toThrow(
      "episode distiller failed all segments",
    );
  });

  test("aborts when the signal is already aborted", async () => {
    const signal = AbortSignal.abort();
    await expect(processEpisodeDistillerJob("job-1", signal)).rejects.toThrow(
      "episode distiller aborted",
    );
  });

  test("skips empty output, duplicate generation kinds, and low-value episodes", async () => {
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [
        canonical({ generationKind: "task_episode" }),
        canonical({ title: "Duplicate kind", generationKind: "task_episode" }),
        canonical({
          title: "Low value",
          generationKind: "failure_episode",
          scores: {
            importance: 10,
            confidence: 10,
            reusability: 10,
            decision_density: 10,
            failure_value: 10,
            causal_clarity: 10,
            project_specificity: 10,
            evidence_quality: 10,
            compression_quality: 10,
            staleness_risk: 10,
          },
        }),
      ],
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(result.generated).toBe(1);
    expect(result.duplicateGenerationKindSkipped).toBe(1);
    expect(result.valueSkipped).toBe(1);
    expect(createEpisodeCard).toHaveBeenCalledTimes(1);
  });

  test("dedupes existing cards and concurrent inserts", async () => {
    const existing = card({ id: "existing" });
    vi.mocked(getEpisodeCardBySource)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(card({ id: "concurrent" }));
    vi.mocked(createEpisodeCard).mockRejectedValueOnce(new Error("unique violation"));
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [canonical()],
    });

    const first = await processEpisodeDistillerJob("job-1");
    expect(first.deduped).toBe(1);
    expect(first.generated).toBe(0);

    const second = await processEpisodeDistillerJob("job-1");
    expect(second.deduped).toBe(1);
    expect(second.episodeIds).toEqual(["concurrent"]);
  });

  test("rethrows create errors when no concurrent episode exists", async () => {
    vi.mocked(createEpisodeCard).mockRejectedValue(new Error("db down"));
    vi.mocked(getEpisodeCardBySource).mockResolvedValue(null);
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [canonical()],
    });
    await expect(processEpisodeDistillerJob("job-1")).rejects.toThrow("db down");
  });

  test("skips near duplicates when the review is confident", async () => {
    const existing = card({
      id: "near-1",
      sourceKey: "other-key",
      domains: ["episodic-memory"],
      technologies: ["typescript"],
      changeTypes: ["queue"],
      metadata: {
        episodeDistillation: {
          parentVibeMemoryId: "mem-1",
          sourceStartOffset: 0,
          sourceEndOffset: 40,
        },
      },
    });
    vi.mocked(searchEpisodeCards).mockResolvedValue([existing]);
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [canonical()],
      reviewNearDuplicate: async () => ({
        publish: false,
        duplicateOfEpisodeId: "near-1",
        confidence: 90,
        reason: "same file and lesson",
      }),
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(result.nearDuplicateSkipped).toBe(1);
    expect(createEpisodeCard).not.toHaveBeenCalled();
    expect(markEpisodeDistillerCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "no_episode" }),
    );
  });

  test("still publishes when near-duplicate confidence is low", async () => {
    const existing = card({
      id: "near-1",
      sourceKey: "other-key",
      domains: ["episodic-memory"],
      technologies: ["typescript"],
      changeTypes: ["queue"],
      metadata: {
        episodeDistillation: {
          parentVibeMemoryId: "mem-1",
          sourceStartOffset: 0,
          sourceEndOffset: 40,
        },
      },
    });
    vi.mocked(searchEpisodeCards).mockResolvedValue([existing]);
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [canonical()],
      reviewNearDuplicate: async () => ({
        publish: false,
        duplicateOfEpisodeId: "near-1",
        confidence: 40,
        reason: "uncertain",
      }),
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(result.generated).toBe(1);
    expect(result.nearDuplicateSkipped).toBe(0);
  });

  test("uses LLM distillation when test hooks are unset", async () => {
    vi.mocked(runDistillationCompletion).mockResolvedValue({ content: "[]" } as never);
    vi.mocked(parseLlmJsonLike).mockReturnValue({
      value: [canonical()],
      strategy: "json",
      repaired: false,
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(ensureRuntimeSettingsLoaded).toHaveBeenCalled();
    expect(runDistillationCompletion).toHaveBeenCalled();
    expect(result.generated).toBe(1);
  });

  test("retries a failed distill parse then succeeds", async () => {
    vi.mocked(runDistillationCompletion)
      .mockRejectedValueOnce(new Error("blank"))
      .mockResolvedValueOnce({ content: "[ok]" } as never);
    vi.mocked(parseLlmJsonLike).mockReturnValue({
      value: [canonical()],
      strategy: "json",
      repaired: false,
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(runDistillationCompletion).toHaveBeenCalledTimes(2);
    expect(result.generated).toBe(1);
  });

  test("builds chunked segments from semantic chunk hooks", async () => {
    groupedConfig.distillation.internalChunkedDistillationEnabled = true;
    setEpisodeDistillerTestHooksForTests({
      semanticChunks: async ({ windows }) =>
        windows.map((window, index) => ({
          chunkIndex: index,
          sourceStartOffset: window.sourceStartOffset,
          sourceEndOffset: window.sourceEndOffset,
          eventIds: window.eventIds,
          taskBoundaryKind: "implementation",
          title: `chunk ${index}`,
          boundaryReason: "hook",
          expectedOutputs: ["episode"],
          openBoundary: false,
        })),
      distillSegment: async () => [canonical()],
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(result.generated).toBe(1);
    expect(markEpisodeDistillerCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          episodeDistiller: expect.objectContaining({
            pipelineVersion: "internal-chunked-v1",
          }),
        }),
      }),
    );
  });

  test("falls back to deterministic chunks when semantic output is invalid", async () => {
    groupedConfig.distillation.internalChunkedDistillationEnabled = true;
    setEpisodeDistillerTestHooksForTests({
      semanticChunks: async () => ({ not: "chunks" }),
      distillSegment: async () => [canonical()],
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(result.generated).toBe(1);
  });

  test("splits large event-less documents and event gaps into multiple segments", async () => {
    const huge = "abcdefghij".repeat(2000);
    vi.mocked(readEpisodeSourceDocument).mockResolvedValue(
      document({
        content: huge,
        events: [
          {
            id: "e1",
            kind: "memory",
            createdAt: "2026-05-21T08:00:00.000Z",
            filePath: "a.ts",
            startOffset: 0,
            endOffset: 100,
          },
          {
            id: "e2",
            kind: "agent_diff",
            createdAt: "2026-05-21T09:00:00.000Z",
            filePath: "b.ts",
            startOffset: 100,
            endOffset: Buffer.byteLength(huge, "utf8"),
          },
        ],
      }),
    );
    setEpisodeDistillerTestHooksForTests({
      distillSegment: async () => [],
    });
    const result = await processEpisodeDistillerJob("job-1");
    expect(result.skipped).toBeGreaterThan(1);
    expect(result.generated).toBe(0);
  });
});
