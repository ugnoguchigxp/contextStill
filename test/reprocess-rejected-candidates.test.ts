import { beforeEach, describe, expect, test, vi } from "vitest";
import { reprocessRejectedCandidates } from "../src/modules/coverEvidence/reprocess-rejected.service.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  txUpdate: vi.fn(),
  transaction: vi.fn(),
  recordAuditLogSafe: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    select: mocks.select,
    transaction: mocks.transaction,
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    coverEvidenceReprocessRequested: "COVER_EVIDENCE_REPROCESS_REQUESTED",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

function rejectedRow(overrides: Record<string, unknown> = {}) {
  return {
    targetStateId: "target-1",
    findCandidateResultId: "find-1",
    title: "Test behavior, not implementation",
    originalType: "rule",
    targetStatus: "skipped",
    targetPhase: "stored",
    currentStatus: "insufficient",
    currentStage: "final",
    currentReason: "procedure_body_not_actionable",
    updatedAt: new Date("2026-05-24T00:00:00.000Z"),
    knowledgeId: null,
    ...overrides,
  };
}

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

function updateChain(returningRows: unknown[] = [{ id: "find-1" }]) {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => returningRows),
  };
  return chain;
}

describe("reprocessRejectedCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockReturnValue(selectChain([rejectedRow()]));
    mocks.txUpdate.mockImplementation(() => updateChain());
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        update: mocks.txUpdate,
      }),
    );
  });

  test("dry-run lists eligible rejected candidates without mutating", async () => {
    const result = await reprocessRejectedCandidates({
      reason: "procedure_body_not_actionable",
      apply: false,
    });

    expect(result.apply).toBe(false);
    expect(result.matched).toBe(1);
    expect(result.items[0]).toMatchObject({
      coverEvidenceResultId: "find-1",
      originalType: "rule",
      proposedAction: "requeue_target",
      applied: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("apply marks cover evidence for reprocess and requeues targets", async () => {
    const result = await reprocessRejectedCandidates({
      reason: "procedure_body_not_actionable",
      apply: true,
    });

    expect(result.apply).toBe(true);
    expect(result.updated).toBe(1);
    expect(mocks.txUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_REPROCESS_REQUESTED",
        payload: expect.objectContaining({
          coverEvidenceResultId: "find-1",
          targetStateId: "target-1",
        }),
      }),
    );
  });

  test("does not reprocess completed targets unless explicitly allowed", async () => {
    mocks.select.mockReturnValue(selectChain([rejectedRow({ targetStatus: "completed" })]));

    const result = await reprocessRejectedCandidates({
      reason: "procedure_body_not_actionable",
      apply: true,
    });

    expect(result.apply).toBe(true);
    expect(result.updated).toBe(0);
    expect(result.items[0]).toMatchObject({
      proposedAction: "skip_completed",
      applied: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  test("does not requeue target when cover evidence row changed before apply", async () => {
    mocks.txUpdate.mockImplementationOnce(() => updateChain([]));

    const result = await reprocessRejectedCandidates({
      reason: "procedure_body_not_actionable",
      apply: true,
    });

    expect(result.apply).toBe(true);
    expect(result.updated).toBe(0);
    expect(result.items[0]).toMatchObject({
      proposedAction: "requeue_target",
      applied: false,
    });
    expect(mocks.txUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.recordAuditLogSafe).not.toHaveBeenCalled();
  });
});
