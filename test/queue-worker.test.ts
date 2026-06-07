import { beforeEach, describe, expect, test, vi } from "vitest";
import { coveringEvidenceQueue, findingCandidateQueue } from "../src/db/schema.js";
import { enqueueFindingJob, runQueueWorkerOnce } from "../src/modules/queue/core/worker.js";

const mocks = vi.hoisted(() => ({
  appendQueueEvent: vi.fn(),
  claimNextQueueJob: vi.fn(),
  runCoverEvidence: vi.fn(),
  runFindCandidate: vi.fn(),
  runFinalizeDistille: vi.fn(),
  processMergeActivationFinalizeJob: vi.fn(),
  researchWebSourceToMarkdown: vi.fn(),
  isQueuePaused: vi.fn(),
  setQueuePaused: vi.fn(),
  selectRows: [] as unknown[][],
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("../src/db/index.js", () => ({
  db: mocks.db,
}));

vi.mock("../src/modules/queue/core/claim.js", () => ({
  claimNextQueueJob: mocks.claimNextQueueJob,
}));

vi.mock("../src/modules/queue/core/events.js", () => ({
  appendQueueEvent: mocks.appendQueueEvent,
}));

vi.mock("../src/modules/coverEvidence/domain.js", () => ({
  runCoverEvidence: mocks.runCoverEvidence,
}));

vi.mock("../src/modules/findCandidate/domain.js", () => ({
  runFindCandidate: mocks.runFindCandidate,
}));

vi.mock("../src/modules/finalizeDistille/domain.js", () => ({
  runFinalizeDistille: mocks.runFinalizeDistille,
}));

vi.mock("../src/modules/landscape/merge-activation-finalize.worker.js", () => ({
  processMergeActivationFinalizeJob: mocks.processMergeActivationFinalizeJob,
}));

vi.mock("../src/modules/sources/web/source-research.service.js", () => ({
  researchWebSourceToMarkdown: mocks.researchWebSourceToMarkdown,
}));

vi.mock("../src/modules/queue/core/control.js", () => ({
  isQueuePaused: mocks.isQueuePaused,
  setQueuePaused: mocks.setQueuePaused,
}));

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

function insertChain(table: unknown) {
  const chain = {
    values: vi.fn((values: unknown) => {
      mocks.insertCalls.push({ table, values });
      return chain;
    }),
    onConflictDoUpdate: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => [{ id: "evidence-1" }]),
  };
  return chain;
}

function updateChain(table: unknown) {
  const chain = {
    set: vi.fn((values: Record<string, unknown>) => {
      mocks.updateCalls.push({ table, values });
      return chain;
    }),
    where: vi.fn(async () => []),
  };
  return chain;
}

describe("runQueueWorkerOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.insertCalls = [];
    mocks.updateCalls = [];
    mocks.claimNextQueueJob.mockResolvedValue({ id: "cover-job-1" });
    mocks.isQueuePaused.mockResolvedValue(false);
    mocks.setQueuePaused.mockResolvedValue({});
    mocks.db.select.mockImplementation(() => selectChain(mocks.selectRows.shift() ?? []));
    mocks.db.insert.mockImplementation((table: unknown) => insertChain(table));
    mocks.db.update.mockImplementation((table: unknown) => updateChain(table));
    mocks.db.execute.mockResolvedValue({ rows: [] });
  });

  test("completes covering insufficient results", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "insufficient",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "not_actionable",
      },
    });

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: coveringEvidenceQueue,
        values: expect.objectContaining({
          status: "completed",
          attemptCount: 1,
          lastOutcomeKind: "insufficient",
          lastError: "not_actionable",
        }),
      }),
    );
  });

  test("marks covering retryable failures as failed on max attempts", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 1,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "parse_failed",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "external_parse_failed",
      },
    });

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: coveringEvidenceQueue,
        values: expect.objectContaining({
          status: "failed",
          attemptCount: 2,
          lastOutcomeKind: "parse_failed",
          lastError: "external_parse_failed",
        }),
      }),
    );
  });

  test("passes found candidate source summary and metadata read ranges into covering evidence", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {
            sourceKind: "vibe_memory",
            sourceKey: "memory-1",
            sourceUri: "vibe_memory:memory-1",
          },
          type: "rule",
          findingJobId: "finding-job-1",
          sourceSummary: "Summarized source evidence from finding.",
          metadata: {
            sourceKind: "vibe_memory",
            sourceKey: "memory-1",
            sourceUri: "vibe_memory:memory-1",
            readRanges: [{ from: 120, toExclusive: 240 }],
          },
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "insufficient",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "not_actionable",
      },
    });

    await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(mocks.runCoverEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          targetKind: "vibe_memory",
          targetKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          origin: expect.objectContaining({
            sourceSummary: "Summarized source evidence from finding.",
            readRanges: [{ from: 120, toExclusive: 240 }],
          }),
        }),
      }),
    );
  });

  test("does not enqueue missing vibe memory sources", async () => {
    mocks.selectRows = [[]];

    const result = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: "missing-memory",
      sourceUri: "vibe_memory:missing-memory",
    });

    expect(result).toBeNull();
    expect(mocks.insertCalls.map((call) => call.table)).not.toContain(findingCandidateQueue);
  });

  test("enqueues existing vibe memory sources", async () => {
    mocks.selectRows = [[{ id: "memory-1" }]];

    const result = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: "memory-1",
      sourceUri: "vibe_memory:memory-1",
    });

    expect(result).toEqual({ id: "evidence-1" });
    expect(mocks.insertCalls.map((call) => call.table)).toContain(findingCandidateQueue);
  });

  test("returns idle when lane is paused", async () => {
    mocks.isQueuePaused.mockResolvedValue(true);

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.idle).toBe(true);
    expect(result.message).toContain("queue paused");
    expect(mocks.claimNextQueueJob).not.toHaveBeenCalled();
  });

  test("dispatches merge activation finalize jobs to the activation worker", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "merge-finalize-job-1" });
    mocks.processMergeActivationFinalizeJob.mockResolvedValue(undefined);

    const result = await runQueueWorkerOnce({
      queueName: "mergeActivationFinalize",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(result.completedJobId).toBe("merge-finalize-job-1");
    expect(mocks.processMergeActivationFinalizeJob).toHaveBeenCalledWith(
      "merge-finalize-job-1",
      expect.any(AbortSignal),
    );
  });

  test("pauses any queue lane when the worker dependency is unavailable", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockRejectedValue(
      new Error("Unable to connect. Is the computer able to access the url?"),
    );

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("worker_unavailable");
    expect(mocks.setQueuePaused).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "coveringEvidence",
        paused: true,
        updatedBy: "queue-worker",
      }),
    );
    expect(mocks.db.execute).toHaveBeenCalled();
    expect(mocks.updateCalls).not.toContainEqual(
      expect.objectContaining({
        table: coveringEvidenceQueue,
        values: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});
