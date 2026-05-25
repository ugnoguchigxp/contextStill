import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  claimFindCandidateTargetStateById,
  claimNextCoverEvidenceTargetState,
  claimNextDistillationTargetState,
  findNextSelectableDistillationTargetState,
  finishDistillationTargetState,
  getDistillationTargetStateById,
  listDistillationTargetStatesForCandidates,
  pauseDistillationTargetState,
  requeueDistillationTargetState,
  updateDistillationTargetSource,
  updateDistillationTargetHeartbeat,
  updateDistillationTargetPhase,
  upsertDistillationTargetState,
} from "../src/modules/selectDistillationTarget/repository.js";

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockExecute = vi.fn();

vi.mock("../src/db/index.js", () => {
  const mockDb = {
    insert: (...args: any[]) => mockInsert(...args),
    select: (...args: any[]) => mockSelect(...args),
    update: (...args: any[]) => mockUpdate(...args),
    execute: (...args: any[]) => mockExecute(...args),
    transaction: vi.fn().mockImplementation((callback) => callback(mockDb)),
  };
  return { db: mockDb };
});

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    distillationTargetClaimed: "DISTILLATION_TARGET_CLAIMED",
    distillationTargetHeartbeat: "DISTILLATION_TARGET_HEARTBEAT",
    distillationTargetStatusChanged: "DISTILLATION_TARGET_STATUS_CHANGED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

const makeChain = (result: any) => {
  const chain = {
    values: vi.fn().mockImplementation(() => chain),
    onConflictDoUpdate: vi.fn().mockImplementation(() => chain),
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    set: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

const flattenSqlChunks = (value: any): string => {
  if (!value || typeof value !== "object") return String(value ?? "");
  if (Array.isArray(value.value)) return value.value.join("");
  if ("value" in value && typeof value.value !== "object") return String(value.value);
  if (Array.isArray(value.queryChunks)) return value.queryChunks.map(flattenSqlChunks).join("");
  return String(value);
};

describe("selectDistillationTarget repository unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockRow = {
    id: "target-1",
    targetKind: "wiki_file" as const,
    targetKey: "test/key.md",
    sourceUri: "/wiki/test/key.md",
    distillationVersion: "select-distillation-target-v1",
    status: "pending" as const,
    phase: "selected" as const,
    priorityGroup: "wiki",
    sortKey: "key",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("upsertDistillationTargetState", () => {
    it("inserts or updates the target state", async () => {
      mockInsert.mockReturnValueOnce(makeChain([mockRow]));

      const result = await upsertDistillationTargetState({
        candidate: {
          targetKind: "wiki_file",
          targetKey: "test/key.md",
          sourceUri: "/wiki/test/key.md",
          sortKey: "key",
        },
      });

      expect(result).toEqual(mockRow);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("redacts target identity fields and metadata before persistence", async () => {
      const chain = makeChain([mockRow]);
      mockInsert.mockReturnValueOnce(chain);

      await upsertDistillationTargetState({
        candidate: {
          targetKind: "web_ingest",
          targetKey: "https://example.com/docs?token=abcdef0123456789",
          sourceUri: "https://example.com/docs?token=abcdef0123456789",
          sortKey: "https://example.com/docs?token=abcdef0123456789",
        },
        metadata: {
          credentials: {
            value: "raw-token-value",
          },
        },
      });

      const serialized = JSON.stringify(chain.values.mock.calls[0]?.[0]);
      expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
      expect(serialized).not.toContain("abcdef0123456789");
      expect(serialized).not.toContain("raw-token-value");
    });
  });

  describe("getDistillationTargetStateById", () => {
    it("returns row by id", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await getDistillationTargetStateById("target-1");
      expect(result).toEqual(mockRow);
    });

    it("returns null if not found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await getDistillationTargetStateById("target-missing");
      expect(result).toBeNull();
    });
  });

  describe("findNextSelectableDistillationTargetState", () => {
    it("returns next selectable state", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await findNextSelectableDistillationTargetState();
      expect(result).toEqual(mockRow);
    });
  });

  describe("listDistillationTargetStatesForCandidates", () => {
    it("returns rows for candidates", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await listDistillationTargetStatesForCandidates({
        candidates: [
          {
            targetKind: "wiki_file",
            targetKey: "test/key.md",
            sourceUri: "/wiki/test/key.md",
            sortKey: "key",
          },
        ],
      });
      expect(result).toEqual([mockRow]);
    });

    it("returns empty if candidates is empty", async () => {
      const result = await listDistillationTargetStatesForCandidates({
        candidates: [],
      });
      expect(result).toEqual([]);
      expect(mockSelect).not.toHaveBeenCalled();
    });
  });

  describe("claimNextDistillationTargetState", () => {
    it("claims and transitions status to running", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [{ id: "target-1" }],
      });
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await claimNextDistillationTargetState({ worker: "test-worker" });
      const selectSql = flattenSqlChunks(mockExecute.mock.calls[1]?.[0]);
      expect(result).toEqual(mockRow);
      expect(flattenSqlChunks(mockExecute.mock.calls[0]?.[0])).toContain(
        "distillation_pipeline_capacity",
      );
      expect(selectSql).toContain("::timestamptz at time zone 'UTC'");
      expect(selectSql).toContain("running_capacity");
      expect(selectSql).toContain("attempt_count <");
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });

    it("can restrict primary claims to targets with prepared candidates", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [{ id: "target-1" }],
      });
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await claimNextDistillationTargetState({
        worker: "test-worker",
        requireCandidateResultsForSourceTargets: true,
      });

      const selectSql = flattenSqlChunks(mockExecute.mock.calls[1]?.[0]);
      expect(result).toEqual(mockRow);
      expect(selectSql).toContain("target_kind = 'knowledge_candidate'");
      expect(selectSql).toContain("find_candidate_results");
    });

    it("returns null if execute returns no rows", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

      const result = await claimNextDistillationTargetState();
      expect(result).toBeNull();
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe("claimFindCandidateTargetStateById", () => {
    it("serializes findCandidate claims with an advisory lock", async () => {
      mockExecute
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "target-1" }] });
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await claimFindCandidateTargetStateById({
        id: "target-1",
        targetKind: "wiki_file",
        worker: "test-worker",
      });

      expect(result).toEqual(mockRow);
      expect(flattenSqlChunks(mockExecute.mock.calls[0]?.[0])).toContain(
        "distillation_pipeline_capacity",
      );
      expect(flattenSqlChunks(mockExecute.mock.calls[1]?.[0])).toContain("pg_advisory_xact_lock");
      expect(flattenSqlChunks(mockExecute.mock.calls[2]?.[0])).toContain("find_candidate_results");
      expect(flattenSqlChunks(mockExecute.mock.calls[2]?.[0])).toContain("running_capacity");
      expect(flattenSqlChunks(mockExecute.mock.calls[2]?.[0])).toContain("attempt_count <");
    });
  });

  describe("claimNextCoverEvidenceTargetState", () => {
    it("claims the oldest target with missing or retryable cover evidence", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
        rows: [{ id: "target-1" }],
      });
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await claimNextCoverEvidenceTargetState({ worker: "test-worker" });

      const selectSql = flattenSqlChunks(mockExecute.mock.calls[1]?.[0]);
      expect(result).toEqual(mockRow);
      expect(flattenSqlChunks(mockExecute.mock.calls[0]?.[0])).toContain(
        "distillation_pipeline_capacity",
      );
      expect(selectSql).toContain("cover_evidence_results");
      expect(selectSql).toContain("find_candidate_results");
      expect(selectSql).toContain("parse_failed");
      expect(selectSql).toContain("min(");
      expect(selectSql).toContain("running_capacity");
      expect(selectSql).toContain("attempt_count <");
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });
  });

  describe("updateDistillationTargetHeartbeat", () => {
    it("updates heartbeat", async () => {
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await updateDistillationTargetHeartbeat("target-1");
      expect(result).toEqual(mockRow);
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });
  });

  describe("updateDistillationTargetPhase", () => {
    it("updates phase", async () => {
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await updateDistillationTargetPhase({ id: "target-1", phase: "stored" });
      expect(result).toEqual(mockRow);
    });

    it("serializes exclusive findCandidate phase transitions", async () => {
      mockExecute.mockResolvedValueOnce({ rows: [] });
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await updateDistillationTargetPhase({
        id: "target-1",
        phase: "finding_candidate",
        distillationVersion: "select-distillation-target-v1",
        requireNoOtherRunningFindCandidate: true,
      });

      expect(result).toEqual(mockRow);
      expect(flattenSqlChunks(mockExecute.mock.calls[0]?.[0])).toContain("pg_advisory_xact_lock");
    });
  });

  describe("finishDistillationTargetState", () => {
    it("updates status to completed", async () => {
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await finishDistillationTargetState({
        id: "target-1",
        status: "completed",
        outcomeKind: "success",
      });
      expect(result).toEqual(mockRow);
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });
  });

  describe("updateDistillationTargetSource", () => {
    it("redacts source uri and metadata before persistence", async () => {
      const chain = makeChain([mockRow]);
      mockUpdate.mockReturnValueOnce(chain);

      const result = await updateDistillationTargetSource({
        id: "target-1",
        sourceUri: "https://example.com/docs?token=abcdef0123456789",
        metadata: {
          credentials: {
            value: "raw-token-value",
          },
        },
      });

      const setValue = chain.set.mock.calls[0]?.[0];
      const serialized = JSON.stringify({
        sourceUri: setValue.sourceUri,
        metadata: flattenSqlChunks(setValue.metadata),
      });
      expect(result).toEqual(mockRow);
      expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
      expect(serialized).not.toContain("abcdef0123456789");
      expect(serialized).not.toContain("raw-token-value");
    });
  });

  describe("pauseDistillationTargetState", () => {
    it("updates status to paused", async () => {
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await pauseDistillationTargetState({
        id: "target-1",
        reason: "throttled",
      });
      expect(result).toEqual(mockRow);
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });
  });

  describe("requeueDistillationTargetState", () => {
    it("requeues the target state", async () => {
      mockUpdate.mockReturnValueOnce(makeChain([mockRow]));

      const result = await requeueDistillationTargetState({
        id: "target-1",
        reason: "retry",
      });
      expect(result).toEqual(mockRow);
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });
  });
});
