import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  CoverEvidenceReprocessError,
  requestCoverEvidenceReprocess,
} from "../src/modules/coverEvidence/reprocess-candidate.service.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  transaction: vi.fn(),
  txUpdate: vi.fn(),
  recordAuditLogSafe: vi.fn(),
  ensureRuntimeSettingsLoaded: vi.fn(),
  resolveCoverEvidenceRoutes: vi.fn(),
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

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: mocks.ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes: mocks.resolveCoverEvidenceRoutes,
}));

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

function updateChain(returningRows: unknown[]) {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => returningRows),
  };
  return chain;
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    findCandidateResultId: "candidate-1",
    targetStateId: "target-1",
    targetStatus: "completed",
    targetMetadata: {},
    coverStatus: "insufficient",
    coverStage: "final",
    coverReason: "rule_body_not_actionable",
    knowledgeId: null,
    ...overrides,
  };
}

describe("requestCoverEvidenceReprocess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureRuntimeSettingsLoaded.mockResolvedValue(undefined);
    mocks.resolveCoverEvidenceRoutes.mockReturnValue({
      sourceSupport: { provider: "openai", fallback: [] },
      externalEvidence: { provider: "openai", fallback: [] },
      mcpEvidence: { provider: "openai", fallback: [] },
    });
    mocks.select.mockReturnValue(selectChain([baseRow()]));
    mocks.txUpdate.mockImplementation(() => updateChain([{ id: "ok" }]));
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        update: mocks.txUpdate,
      }),
    );
  });

  test("queues cloud_api reprocess request and records audit log", async () => {
    const result = await requestCoverEvidenceReprocess({
      findCandidateResultId: "candidate-1",
      mode: "cloud_api",
    });

    expect(result).toMatchObject({
      findCandidateResultId: "candidate-1",
      coverEvidenceResultId: "candidate-1",
      targetStateId: "target-1",
      status: "queued",
      mode: "cloud_api",
      previousStatus: "insufficient",
      previousReason: "rule_body_not_actionable",
    });
    expect(mocks.txUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_REPROCESS_REQUESTED",
        payload: expect.objectContaining({
          targetStateId: "target-1",
          coverEvidenceResultId: "candidate-1",
          mode: "cloud_api",
        }),
      }),
    );
  });

  test("returns already_queued for repeated cloud_api request", async () => {
    mocks.select.mockReturnValue(
      selectChain([
        baseRow({
          coverStatus: "reprocess_requested",
          coverReason: "reprocess_requested:cloud_api:rule_body_not_actionable",
          targetMetadata: {
            coverEvidenceReprocessRequest: {
              mode: "cloud_api",
              requestedAt: "2026-05-25T00:00:00.000Z",
              status: "requested",
              findCandidateResultIds: ["candidate-1"],
              coverEvidenceResultIds: ["candidate-1"],
            },
          },
        }),
      ]),
    );

    const result = await requestCoverEvidenceReprocess({
      findCandidateResultId: "candidate-1",
      mode: "cloud_api",
    });

    expect(result.status).toBe("already_queued");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAuditLogSafe).not.toHaveBeenCalled();
  });

  test("rejects running target with domain reason", async () => {
    mocks.select.mockReturnValue(selectChain([baseRow({ targetStatus: "running" })]));

    await expect(
      requestCoverEvidenceReprocess({
        findCandidateResultId: "candidate-1",
        mode: "cloud_api",
      }),
    ).rejects.toMatchObject({
      reason: "target_running",
      statusCode: 409,
    });
  });

  test("rejects unsupported cover status", async () => {
    mocks.select.mockReturnValue(selectChain([baseRow({ coverStatus: "duplicate" })]));

    await expect(
      requestCoverEvidenceReprocess({
        findCandidateResultId: "candidate-1",
        mode: "cloud_api",
      }),
    ).rejects.toMatchObject({
      reason: "cover_evidence_status_not_reprocessable",
      statusCode: 409,
    });
  });

  test("rejects when cloud provider route is unavailable", async () => {
    mocks.resolveCoverEvidenceRoutes.mockReturnValue({
      sourceSupport: { provider: "local-llm", fallback: [] },
      externalEvidence: { provider: "local-llm", fallback: [] },
      mcpEvidence: { provider: "local-llm", fallback: [] },
    });

    await expect(
      requestCoverEvidenceReprocess({
        findCandidateResultId: "candidate-1",
        mode: "cloud_api",
      }),
    ).rejects.toMatchObject({
      reason: "cloud_api_provider_unavailable",
      statusCode: 409,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
