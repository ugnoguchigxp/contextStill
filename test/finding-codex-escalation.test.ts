import { afterEach, describe, expect, test, vi } from "vitest";
import { maybeRunFindingCodexEscalation } from "../src/modules/findCandidate/codex-escalation.service.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function noCandidateResult() {
  return {
    targetStateId: null,
    targetKind: "vibe_memory" as const,
    targetKey: "memory-1",
    callerMode: "cli_text" as const,
    candidates: [],
    readRanges: [{ from: 0, toExclusive: 80 }],
    parseDiagnostics: {
      rawWasEmptyArray: true,
      rawCandidateLikeCount: 0,
      droppedMissingType: 0,
      droppedMissingPolarity: 0,
      droppedNeutral: 0,
      droppedNegativeProcedure: 0,
      droppedInvalidProcedureShape: 0,
      plainTextFallbackUsed: false,
    },
  };
}

function findingJob(distillationVersion: string) {
  return {
    id: `finding-${distillationVersion}`,
    inputKind: "source_target",
    sourceKind: "vibe_memory",
    sourceKey: "memory-1",
    sourceUri: "vibe_memory:memory-1",
    distillationVersion,
    status: "running",
    priority: 50,
    attemptCount: 0,
    payload: {},
    metadata: {},
    providerPolicy: null,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    nextRunAt: null,
    completedAt: null,
    lastError: null,
    lastOutcomeKind: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("maybeRunFindingCodexEscalation", () => {
  test("keys escalation starts by distillationVersion and keeps trace mode non-mutating", async () => {
    process.env.FINDING_CODEX_ESCALATION = "trace";
    process.env.FINDING_CODEX_ESCALATION_MODEL = "codex-test";
    process.env.FINDING_CODEX_ESCALATION_MIN_SCORE = "0";

    const insertStart = vi
      .fn()
      .mockImplementation(async (params: { distillationVersion: string }) => ({
        id: `escalation-${params.distillationVersion}`,
        inserted: true,
      }));
    const updateStatus = vi.fn().mockResolvedValue(undefined);
    const deps = {
      readMetadata: vi.fn().mockResolvedValue({
        metadata: { sourceId: "codex_logs", roles: ["user", "assistant"] },
        dedupeKey: "dedupe-1",
        agentDiffCount: 1,
      }),
      readVibeMemory: vi.fn().mockResolvedValue({
        content: [
          "USER: provider failure と source_missing を分けてください。",
          "ASSISTANT: queue worker を修正し、bun run verify が通りました。",
          "ASSISTANT: sqlite と distillation_queue_events で outcome を確認しました。",
        ].join("\n\n"),
        totalTokens: 120,
        from: 0,
        toExclusive: 120,
        returnedTokens: 120,
        stats: {
          originalChars: 240,
          filteredChars: 240,
          droppedMessages: 0,
          droppedToolOutputs: 0,
          includedDiffHunks: 1,
          truncatedDiffHunks: 0,
        },
      }),
      runCompletion: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          candidates: [
            {
              type: "rule",
              polarity: "negative",
              title: "Separate provider failures from missing sources",
              content:
                "When findingCandidate work fails, classify provider failures separately from source_missing before deciding whether to requeue.",
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      }),
      insertStart,
      updateStatus,
      countToday: vi.fn().mockResolvedValue(1),
    };

    const first = await maybeRunFindingCodexEscalation(
      {
        findingJob: findingJob("v1"),
        findResult: noCandidateResult(),
      },
      deps,
    );
    const second = await maybeRunFindingCodexEscalation(
      {
        findingJob: findingJob("v2"),
        findResult: noCandidateResult(),
      },
      deps,
    );

    expect(first).toMatchObject({
      mode: "trace",
      status: "trace_candidate",
      escalationId: "escalation-v1",
    });
    expect(second).toMatchObject({
      mode: "trace",
      status: "trace_candidate",
      escalationId: "escalation-v2",
    });
    expect(insertStart.mock.calls.map(([params]) => params.distillationVersion)).toEqual([
      "v1",
      "v2",
    ]);
    expect(updateStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "escalation-v1",
        status: "trace_candidate",
        candidateCount: 1,
      }),
    );
  });
});
