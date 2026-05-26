import { beforeEach, describe, expect, test, vi } from "vitest";
import { coveringEvidenceQueue, premiumCoveringEvidenceQueue } from "../src/db/schema.js";
import { runQueueWorkerOnce } from "../src/modules/queue/core/worker.js";

const mocks = vi.hoisted(() => ({
  appendQueueEvent: vi.fn(),
  claimNextQueueJob: vi.fn(),
  runCoverEvidence: vi.fn(),
  runFindCandidate: vi.fn(),
  runFinalizeDistille: vi.fn(),
  researchWebSourceToMarkdown: vi.fn(),
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

vi.mock("../src/modules/sources/web/source-research.service.js", () => ({
  researchWebSourceToMarkdown: mocks.researchWebSourceToMarkdown,
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
    mocks.db.select.mockImplementation(() => selectChain(mocks.selectRows.shift() ?? []));
    mocks.db.insert.mockImplementation((table: unknown) => insertChain(table));
    mocks.db.update.mockImplementation((table: unknown) => updateChain(table));
    mocks.db.execute.mockResolvedValue({ rows: [] });
  });

  test("completes covering insufficient results without enqueueing premium", async () => {
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
    expect(mocks.db.insert).not.toHaveBeenCalledWith(premiumCoveringEvidenceQueue);
    expect(mocks.insertCalls.map((call) => call.table)).not.toContain(premiumCoveringEvidenceQueue);
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

  test("marks covering retryable failures as failed on max attempts without premium escalation", async () => {
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
    expect(mocks.db.insert).not.toHaveBeenCalledWith(premiumCoveringEvidenceQueue);
    expect(mocks.insertCalls.map((call) => call.table)).not.toContain(premiumCoveringEvidenceQueue);
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
});
