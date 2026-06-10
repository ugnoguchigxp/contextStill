import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/client.js";
import {
  clearSessionMemos,
  deleteSessionMemo,
  getSessionMemo,
  listSessionMemoEvents,
  listSessionMemoSessions,
  listSessionMemos,
  putManySessionMemos,
  putSessionMemo,
} from "../src/modules/session-memo/session-memo.service.js";

// クエリ解決データ用のキュー
let mockDataQueue: any[] = [];

// client.js からの db をモック（巻き上げ対応、キュー方式）
vi.mock("../src/db/client.js", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    having: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    transaction: vi.fn(),
    // then を持たせることで await 時にキューからデータを解決する
    then: vi.fn((resolve) => {
      const data = mockDataQueue.shift();
      resolve(data);
    }),
  };
  mockDb.transaction.mockImplementation((callback: any) => callback(mockDb));
  return {
    db: mockDb,
  };
});

// context-compiler.repository.js のモック
const mockListCompileRunOutputsByIds = vi.fn();
vi.mock("../src/modules/context-compiler/context-compiler.repository.js", () => ({
  listCompileRunOutputsByIds: (...args: any[]) => mockListCompileRunOutputsByIds(...args),
}));

describe("session-memo.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListCompileRunOutputsByIds.mockResolvedValue(new Map());
    mockDataQueue = [];
  });

  test("putSessionMemo creates a memo when slot is empty", async () => {
    const savedMemo = {
      id: "memo-id-1",
      sessionId: "session-abc",
      slot: 0,
      kind: "scratch",
      label: "my-label",
      body: "Hello world memo",
      metadata: { kind: "scratch" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDataQueue = [
      [], // 1. expireRows 用 (update)
      [], // 2. ラベル重複チェック (select limit 1)
      [], // 3. nextEmptySlotIn 用 (select)
      [savedMemo], // 4. putSessionMemoIn 内の insert (returning)
      [], // 5. putSessionMemoIn 内の event insert
    ];

    const result = await putSessionMemo({
      sessionId: "session-abc",
      body: "Hello world memo",
      label: "my-label",
    });

    expect(result).toEqual(savedMemo);
    expect(db.insert).toHaveBeenCalled();
  });

  test("putManySessionMemos saves multiple memos", async () => {
    const savedMemo1 = {
      id: "m1",
      slot: 0,
      kind: "scratch",
      label: "l1",
      body: "b1",
      metadata: {},
    };
    const savedMemo2 = {
      id: "m2",
      slot: 1,
      kind: "scratch",
      label: "l2",
      body: "b2",
      metadata: {},
    };

    mockDataQueue = [
      [], // 1. expireRows 用 (update)
      [], // 2. memo1 ラベル重複チェック (select limit 1)
      [], // 3. memo1 用 nextEmptySlotIn (select)
      [savedMemo1], // 4. memo1 insert (returning)
      [], // 5. memo1 event insert
      [], // 6. memo2 ラベル重複チェック (select limit 1)
      [], // 7. memo2 用 nextEmptySlotIn (select)
      [savedMemo2], // 8. memo2 insert (returning)
      [], // 9. memo2 event insert
    ];

    const result = await putManySessionMemos("session-abc", [
      { body: "b1", label: "l1" },
      { body: "b2", label: "l2" },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(savedMemo1);
    expect(result[1]).toEqual(savedMemo2);
  });

  test("listSessionMemos returns a list of memos with linked compile outputs if applicable", async () => {
    const mockMemos = [
      {
        id: "memo-1",
        sessionId: "session-abc",
        slot: 0,
        kind: "compile_result",
        label: "compile_result:run-1",
        body: "output body",
        metadata: { contextCompileRunId: "run-1" },
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresAt: null,
      },
    ];

    mockDataQueue = [
      [], // 1. expireRows
      mockMemos, // 2. listSessionMemos 内の select (orderBy)
    ];

    const mockCompileRuns = new Map([
      ["run-1", { goal: "Build test suite", outputMarkdown: "# Test output" }],
    ]);
    mockListCompileRunOutputsByIds.mockResolvedValue(mockCompileRuns);

    const result = await listSessionMemos({
      sessionId: "session-abc",
      includeEmpty: true,
    });

    expect(result).toHaveLength(40); // sessionMemoSlotLimit は 40
    const activeMemo = result.find((item: any) => !item.empty) as any;
    expect(activeMemo).toBeDefined();
    expect(activeMemo.linkedGoal).toBe("Build test suite");
    expect(activeMemo.linkedOutputMarkdown).toBe("# Test output");
  });

  test("getSessionMemo retrieves specific memo by slot or label", async () => {
    const mockMemo = {
      id: "memo-1",
      sessionId: "session-abc",
      slot: 2,
      kind: "scratch",
      label: "test-label",
      body: "body content",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
    };

    mockDataQueue = [
      [], // 1. expireRows
      [mockMemo], // 2. getSessionMemo select (limit 1)
    ];

    const result = await getSessionMemo({
      sessionId: "session-abc",
      slot: 2,
    });

    expect(result).toBeDefined();
    expect(result?.id).toBe("memo-1");
  });

  test("deleteSessionMemo soft deletes a memo", async () => {
    const mockMemo = {
      id: "memo-1",
      sessionId: "session-abc",
      slot: 2,
      kind: "scratch",
      label: "test-label",
      body: "body content",
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresAt: null,
    };

    mockDataQueue = [
      [], // 1. expireRows (deleteSessionMemo の最初)
      [], // 2. getSessionMemo 内の expireRows
      [mockMemo], // 3. getSessionMemo 内の select
      [], // 4. deleteSessionMemo 内の update
      [], // 5. deleteSessionMemo 内の event insert
    ];

    const result = await deleteSessionMemo({
      sessionId: "session-abc",
      slot: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(true);
    expect(db.update).toHaveBeenCalled();
  });

  test("clearSessionMemos soft deletes all memos of a session", async () => {
    mockDataQueue = [
      [], // 1. expireRows
      [{ slot: 0, label: "l1" }], // 2. clearSessionMemos 内の update
      [], // 3. event insert
    ];

    const result = await clearSessionMemos("session-abc");

    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(1);
    expect(db.update).toHaveBeenCalled();
  });

  test("listSessionMemoEvents returns events for a session", async () => {
    const mockEvents = [
      { id: "event-1", sessionId: "session-abc", action: "put", createdAt: new Date() },
    ];

    mockDataQueue = [
      mockEvents, // select events
    ];

    const result = await listSessionMemoEvents("session-abc");

    expect(result).toEqual(mockEvents);
  });

  test("listSessionMemoSessions aggregates session stats", async () => {
    const mockSessions = [
      {
        sessionId: "session-abc",
        memoCount: 3,
        nonCompileResultMemoCount: 2,
        lastUpdatedAt: new Date(),
      },
    ];

    mockDataQueue = [
      mockSessions, // select stats
    ];

    const result = await listSessionMemoSessions();

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-abc");
    expect(result[0].compileResultMemoCount).toBe(1); // 3 - 2 = 1
  });
});
