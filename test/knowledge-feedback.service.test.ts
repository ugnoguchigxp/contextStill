import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  CompileRunKnowledgeFeedbackError,
  recordCompileRunKnowledgeFeedback,
} from "../src/modules/knowledge/knowledge-feedback.service.js";
import { recalculateKnowledgeDynamicScoresSafe } from "../src/modules/knowledge/knowledge-value.service.js";

let mockBackendKind = "postgres";
const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();

const mockSqliteGet = vi.fn();
const mockSqliteAll = vi.fn();
const mockSqliteRun = vi.fn();

const mockQueryChain = {
  get: (...args: any[]) => mockSqliteGet(...args),
  all: (...args: any[]) => mockSqliteAll(...args),
  run: (...args: any[]) => mockSqliteRun(...args),
};

const mockSqliteQuery = vi.fn().mockReturnValue(mockQueryChain);

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    update: (...args: any[]) => mockUpdate(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mockBackendKind }),
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: () =>
    Promise.resolve({
      db: {
        query: (...args: any[]) => mockSqliteQuery(...args),
      },
    }),
}));

vi.mock("../src/modules/knowledge/knowledge-value.service.js", () => ({
  recalculateKnowledgeDynamicScoresSafe: vi.fn().mockResolvedValue(undefined),
}));

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    groupBy: vi.fn().mockImplementation(() => chain),
    set: vi.fn().mockImplementation(() => chain),
    values: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockImplementation(() => chain),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("knowledge-feedback.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackendKind = "postgres";
  });

  test("throws CompileRunKnowledgeFeedbackError (404) if compile run does not exist", async () => {
    // assertCompileRunExists returned empty array (run not found)
    mockSelect.mockReturnValueOnce(makeChain([]));

    await expect(
      recordCompileRunKnowledgeFeedback({
        runId: "non-existent-run",
        items: [{ knowledgeId: "k1", verdict: "used" }],
      }),
    ).rejects.toThrow(new CompileRunKnowledgeFeedbackError(404, "Compile run not found."));
  });

  test("throws CompileRunKnowledgeFeedbackError (400) on duplicate knowledgeId in items", async () => {
    // assertCompileRunExists returns a run
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));

    await expect(
      recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [
          { knowledgeId: "k1", verdict: "used" },
          { knowledgeId: "k1", verdict: "off_topic" }, // Duplicate
        ],
      }),
    ).rejects.toThrow(
      new CompileRunKnowledgeFeedbackError(400, "Duplicate knowledgeId in request: k1"),
    );
  });

  test("throws CompileRunKnowledgeFeedbackError (400) if knowledgeId is not selected for the compile run", async () => {
    // assertCompileRunExists returns a run
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    // loadSelectableKnowledgeIds returns selectable items (only k2, k3)
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k2" }, { itemId: "k3" }]));

    await expect(
      recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [{ knowledgeId: "k1", verdict: "used" }], // k1 is invalid
      }),
    ).rejects.toThrow(
      new CompileRunKnowledgeFeedbackError(
        400,
        "Knowledge IDs are not in selected items for this run: k1",
      ),
    );
  });

  test("inserts new feedback successfully when no existing feedback exists", async () => {
    // 1. assertCompileRunExists -> success
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    // 2. loadSelectableKnowledgeIds -> returns k1
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    // 3. loadExistingFeedbackEvents -> empty (no existing feedback)
    mockSelect.mockReturnValueOnce(makeChain([]));

    // db.insert Mock
    const mockInsertedEvent = { id: "event-1" };
    mockInsert.mockReturnValueOnce(makeChain([mockInsertedEvent]));

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "used", reason: "helpful" }],
      actor: "agent",
    });

    expect(result.savedCount).toBe(1);
    expect(result.updatedCount).toBe(0);
    expect(result.queueCreatedCount).toBe(0);
    expect(result.queueDismissedCount).toBe(0);
    expect(result.affectedKnowledgeIds).toContain("k1");

    expect(mockInsert).toHaveBeenCalled();
    expect(recalculateKnowledgeDynamicScoresSafe).toHaveBeenCalledWith(["k1"]);
  });

  test("updates feedback successfully if feedback exists and has changed", async () => {
    // 1. assertCompileRunExists -> success
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    // 2. loadSelectableKnowledgeIds -> returns k1
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    // 3. loadExistingFeedbackEvents -> existing verdict was 'off_topic'
    mockSelect.mockReturnValueOnce(
      makeChain([
        {
          id: "event-1",
          knowledgeId: "k1",
          verdict: "off_topic",
          actor: "user",
          reason: "old-reason",
          metadata: {},
          updatedAt: new Date(),
        },
      ]),
    );

    // db.update Mock
    mockUpdate.mockReturnValueOnce(makeChain([]));

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "used", reason: "now helpful" }], // Changed from off_topic to used
      actor: "user",
    });

    expect(result.savedCount).toBe(1);
    expect(result.updatedCount).toBe(1); // Updated
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("does not update DB if existing feedback matches requested feedback", async () => {
    // 1. assertCompileRunExists -> success
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    // 2. loadSelectableKnowledgeIds -> returns k1
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    // 3. loadExistingFeedbackEvents -> existing verdict is already 'used'
    mockSelect.mockReturnValueOnce(
      makeChain([
        {
          id: "event-1",
          knowledgeId: "k1",
          verdict: "used",
          actor: "user",
          reason: "helpful",
          metadata: {},
          updatedAt: new Date(),
        },
      ]),
    );

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "used", reason: "helpful" }], // No change
    });

    expect(result.savedCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("enqueues into wrong review queue when verdict is 'wrong' and queue doesn't have pending review", async () => {
    // 1. assertCompileRunExists -> success
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    // 2. loadSelectableKnowledgeIds -> returns k1
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    // 3. loadExistingFeedbackEvents -> empty
    mockSelect.mockReturnValueOnce(makeChain([]));

    // 4. db.insert for knowledgeUsageEvents
    mockInsert.mockReturnValueOnce(makeChain([{ id: "event-wrong-1" }]));

    // 5. enqueueWrongReviewQueue: check unresolved queue
    // (select unresolved reviews for k1) -> returns empty (no pending queue)
    mockSelect.mockReturnValueOnce(makeChain([]));

    // 6. enqueueWrongReviewQueue: db.insert for knowledgeReviewQueue
    mockInsert.mockReturnValueOnce(makeChain([]));

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "wrong", reason: "outdated info" }],
    });

    expect(result.savedCount).toBe(1);
    expect(result.queueCreatedCount).toBe(1); // Enqueued
    expect(result.queueDismissedCount).toBe(0);
    expect(mockInsert).toHaveBeenCalledTimes(2); // Events insertion + review queue insertion
  });

  test("does not enqueue into wrong review queue if a pending/reviewing queue already exists for knowledgeId", async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    mockSelect.mockReturnValueOnce(makeChain([]));
    mockInsert.mockReturnValueOnce(makeChain([{ id: "event-wrong-1" }]));

    // enqueueWrongReviewQueue: check unresolved queue -> returns an active review item (already exists)
    mockSelect.mockReturnValueOnce(makeChain([{ id: "existing-queue-item" }]));

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "wrong" }],
    });

    expect(result.savedCount).toBe(1);
    expect(result.queueCreatedCount).toBe(0); // Ignored because of existing queue item
    expect(mockInsert).toHaveBeenCalledTimes(1); // Only for events
  });

  test("dismisses pending wrong review queue if previous verdict was 'wrong' and new verdict is different", async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    // Existing verdict was 'wrong'
    mockSelect.mockReturnValueOnce(
      makeChain([
        {
          id: "event-1",
          knowledgeId: "k1",
          verdict: "wrong",
          actor: "user",
          reason: "flawed",
          metadata: {},
          updatedAt: new Date(),
        },
      ]),
    );

    // db.update for changing knowledgeUsageEvents
    mockUpdate.mockReturnValueOnce(makeChain([]));

    // db.update for dismissing the review queue (dismissPendingQueueByEvent)
    mockUpdate.mockReturnValueOnce(makeChain([{ id: "queue-item-1" }])); // 1 item returned (dismissed)

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "used" }], // Changed from wrong to used
    });

    expect(result.savedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
    expect(result.queueDismissedCount).toBe(1); // Dismissed!
    expect(mockUpdate).toHaveBeenCalledTimes(2); // 1 for event, 1 for queue dismissal
  });

  test("accepts not_used verdict and does not enqueue review queue", async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ id: "run-1" }]));
    mockSelect.mockReturnValueOnce(makeChain([{ itemId: "k1" }]));
    mockSelect.mockReturnValueOnce(makeChain([]));
    mockInsert.mockReturnValueOnce(makeChain([{ id: "event-not-used-1" }]));

    const result = await recordCompileRunKnowledgeFeedback({
      runId: "run-1",
      items: [{ knowledgeId: "k1", verdict: "not_used" }],
    });

    expect(result.savedCount).toBe(1);
    expect(result.queueCreatedCount).toBe(0);
    expect(result.queueDismissedCount).toBe(0);
  });

  describe("SQLite backend", () => {
    beforeEach(() => {
      mockBackendKind = "sqlite";
    });

    test("throws CompileRunKnowledgeFeedbackError (404) if compile run does not exist", async () => {
      mockSqliteGet.mockReturnValueOnce(undefined);

      await expect(
        recordCompileRunKnowledgeFeedback({
          runId: "non-existent-run",
          items: [{ knowledgeId: "k1", verdict: "used" }],
        }),
      ).rejects.toThrow(new CompileRunKnowledgeFeedbackError(404, "Compile run not found."));
    });

    test("throws CompileRunKnowledgeFeedbackError (400) on duplicate knowledgeId in items", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });

      await expect(
        recordCompileRunKnowledgeFeedback({
          runId: "run-1",
          items: [
            { knowledgeId: "k1", verdict: "used" },
            { knowledgeId: "k1", verdict: "off_topic" },
          ],
        }),
      ).rejects.toThrow(
        new CompileRunKnowledgeFeedbackError(400, "Duplicate knowledgeId in request: k1"),
      );
    });

    test("throws CompileRunKnowledgeFeedbackError (400) if knowledgeId is not selected for the compile run", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });
      mockSqliteAll.mockReturnValueOnce([{ item_id: "k2" }, { item_id: "k3" }]);

      await expect(
        recordCompileRunKnowledgeFeedback({
          runId: "run-1",
          items: [{ knowledgeId: "k1", verdict: "used" }],
        }),
      ).rejects.toThrow(
        new CompileRunKnowledgeFeedbackError(
          400,
          "Knowledge IDs are not in selected items for this run: k1",
        ),
      );
    });

    test("inserts new feedback successfully when no existing feedback exists", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });
      mockSqliteAll.mockReturnValueOnce([{ item_id: "k1" }]);
      mockSqliteAll.mockReturnValueOnce([]);

      const result = await recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [{ knowledgeId: "k1", verdict: "used", reason: "helpful" }],
        actor: "agent",
      });

      expect(result.savedCount).toBe(1);
      expect(result.updatedCount).toBe(0);
      expect(result.queueCreatedCount).toBe(0);
      expect(result.queueDismissedCount).toBe(0);
      expect(result.affectedKnowledgeIds).toContain("k1");
      expect(mockSqliteRun).toHaveBeenCalled();
    });

    test("updates feedback successfully if feedback exists and has changed", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });
      mockSqliteAll.mockReturnValueOnce([{ item_id: "k1" }]);
      mockSqliteAll.mockReturnValueOnce([
        {
          id: "event-1",
          knowledge_id: "k1",
          verdict: "off_topic",
          actor: "user",
          reason: "old-reason",
          metadata: "{}",
          updated_at: new Date().toISOString(),
        },
      ]);

      const result = await recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [{ knowledgeId: "k1", verdict: "used", reason: "now helpful" }],
        actor: "user",
      });

      expect(result.savedCount).toBe(1);
      expect(result.updatedCount).toBe(1);
    });

    test("does not update if existing feedback matches requested feedback", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });
      mockSqliteAll.mockReturnValueOnce([{ item_id: "k1" }]);
      mockSqliteAll.mockReturnValueOnce([
        {
          id: "event-1",
          knowledge_id: "k1",
          verdict: "used",
          actor: "user",
          reason: "helpful",
          metadata: "{}",
          updated_at: new Date().toISOString(),
        },
      ]);

      const result = await recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [{ knowledgeId: "k1", verdict: "used", reason: "helpful" }],
      });

      expect(result.savedCount).toBe(0);
      expect(result.updatedCount).toBe(0);
    });

    test("enqueues into wrong review queue when verdict is 'wrong' and queue doesn't have pending review", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });
      mockSqliteAll.mockReturnValueOnce([{ item_id: "k1" }]);
      mockSqliteAll.mockReturnValueOnce([]);
      mockSqliteGet.mockReturnValueOnce(undefined);

      const result = await recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [{ knowledgeId: "k1", verdict: "wrong", reason: "outdated info" }],
      });

      expect(result.savedCount).toBe(1);
      expect(result.queueCreatedCount).toBe(1);
    });

    test("dismisses pending wrong review queue if previous verdict was 'wrong' and new verdict is different", async () => {
      mockSqliteGet.mockReturnValueOnce({ id: "run-1" });
      mockSqliteAll.mockReturnValueOnce([{ item_id: "k1" }]);
      mockSqliteAll.mockReturnValueOnce([
        {
          id: "event-1",
          knowledge_id: "k1",
          verdict: "wrong",
          actor: "user",
          reason: "flawed",
          metadata: "{}",
          updated_at: new Date().toISOString(),
        },
      ]);

      mockSqliteRun.mockReturnValue({ changes: 1 });

      const result = await recordCompileRunKnowledgeFeedback({
        runId: "run-1",
        items: [{ knowledgeId: "k1", verdict: "used" }],
      });

      expect(result.savedCount).toBe(1);
      expect(result.updatedCount).toBe(1);
      expect(result.queueDismissedCount).toBe(1);
    });
  });
});
