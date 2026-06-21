import { beforeEach, describe, expect, test, vi } from "vitest";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import {
  createEpisodeCardSqlite,
  getEpisodeCardSqlite,
  getEpisodeCardBySourceSqlite,
  searchEpisodeCardsSqlite,
} from "../src/modules/episodic-memory/episode-card.repository.sqlite.js";

vi.mock("../src/db/sqlite/runtime.js", () => {
  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
  };
  return {
    getRuntimeSqliteCoreDatabase: vi.fn(() =>
      Promise.resolve({
        db: mockDb,
        path: "/dummy/sqlite.db",
      }),
    ),
  };
});

describe("episode-card.repository.sqlite", () => {
  let mockDb: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDb = (await getRuntimeSqliteCoreDatabase()).db;
  });

  const dummyEpisodeRow = {
    id: "test-id",
    title: "Test Episode",
    situation: "Test Situation",
    observations: "Test Observations",
    action: "Test Action",
    outcome: "Test Outcome",
    lesson: "Test Lesson",
    applicability: "{}",
    anti_applicability: "{}",
    domains: '["test-domain"]',
    technologies: '["vitest"]',
    change_types: '["test-change"]',
    tools: '["antigravity"]',
    repo_path: "/repo",
    repo_key: "key",
    source_kind: "compile_run",
    source_key: "key",
    outcome_kind: "success",
    confidence: 90,
    evidence_status: "verified",
    status: "active",
    stale_at: null,
    metadata: "{}",
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
  };

  const dummyRefRow = {
    id: "ref-id",
    episode_card_id: "test-id",
    ref_kind: "compile_run",
    ref_value: "rule-1",
    locator: "L10",
    query_hint: "hint",
    metadata: "{}",
    created_at: "2026-06-20T00:00:00.000Z",
  };

  test("createEpisodeCardSqlite inserts row and refs and returns mapped object", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      return {
        run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 }),
        get: vi.fn().mockImplementation(() => {
          if (sql.includes("last_insert_rowid")) return { rowid: 1 };
          if (sql.includes("select * from episode_cards")) return dummyEpisodeRow;
          return null;
        }),
        all: vi.fn().mockImplementation(() => {
          if (sql.includes("episode_refs")) return [dummyRefRow];
          return [];
        }),
      } as any;
    });

    const result = await createEpisodeCardSqlite({
      title: "Test Episode",
      situation: "Test Situation",
      observations: "Test Observations",
      action: "Test Action",
      outcome: "Test Outcome",
      lesson: "Test Lesson",
      applicability: {},
      antiApplicability: {},
      domains: ["test-domain"],
      technologies: ["vitest"],
      changeTypes: ["test-change"],
      tools: ["antigravity"],
      repoPath: "/repo",
      repoKey: "key",
      sourceKind: "compile_run",
      sourceKey: "key",
      outcomeKind: "success",
      confidence: 90,
      evidenceStatus: "verified",
      status: "active",
      refs: [
        {
          refKind: "compile_run",
          refValue: "rule-1",
          locator: "L10",
          queryHint: "hint",
          metadata: {},
        },
      ],
      metadata: {},
    });

    expect(result.title).toBe("Test Episode");
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].refValue).toBe("rule-1");
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("BEGIN IMMEDIATE"));
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("COMMIT"));
  });

  test("createEpisodeCardSqlite rolls back on insertion error", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("insert into episode_cards")) {
        return {
          run: vi.fn().mockImplementation(() => {
            throw new Error("DB Error");
          }),
        } as any;
      }
      return {
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn(),
      } as any;
    });

    await expect(
      createEpisodeCardSqlite({
        title: "Test Episode",
        situation: "Test Situation",
        observations: "Test Observations",
        action: "Test Action",
        outcome: "Test Outcome",
        lesson: "Test Lesson",
        applicability: {},
        antiApplicability: {},
        domains: [],
        technologies: [],
        changeTypes: [],
        tools: [],
        sourceKind: "compile_run",
        sourceKey: "key",
        outcomeKind: "success",
        confidence: 90,
        evidenceStatus: "verified",
        status: "active",
        refs: [],
        metadata: {},
      }),
    ).rejects.toThrow("DB Error");

    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("ROLLBACK"));
  });

  test("getEpisodeCardSqlite returns card if exists, or null", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      return {
        get: vi.fn().mockReturnValue(dummyEpisodeRow),
        all: vi.fn().mockImplementation(() => {
          if (sql.includes("episode_refs")) return [dummyRefRow];
          return [];
        }),
      } as any;
    });

    const result = await getEpisodeCardSqlite("test-id");
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test Episode");
    expect(result?.refs).toHaveLength(1);

    mockDb.query.mockImplementation(() => ({
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    }) as any);

    const nullResult = await getEpisodeCardSqlite("non-existent");
    expect(nullResult).toBeNull();
  });

  test("getEpisodeCardBySourceSqlite returns card or null", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      return {
        get: vi.fn().mockReturnValue(dummyEpisodeRow),
        all: vi.fn().mockImplementation(() => {
          if (sql.includes("episode_refs")) return [dummyRefRow];
          return [];
        }),
      } as any;
    });

    const result = await getEpisodeCardBySourceSqlite({
      sourceKind: "compile_run",
      sourceKey: "key",
    });
    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test Episode");

    mockDb.query.mockImplementation(() => ({
      get: vi.fn().mockReturnValue(null),
      all: vi.fn().mockReturnValue([]),
    }) as any);

    const nullResult = await getEpisodeCardBySourceSqlite({
      sourceKind: "compile_run",
      sourceKey: "key",
    });
    expect(nullResult).toBeNull();
  });

  test("searchEpisodeCardsSqlite performs filtering and ranking", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      return {
        all: vi.fn().mockImplementation(() => {
          if (sql.includes("episode_refs")) return [dummyRefRow];
          if (sql.includes("from episode_cards")) return [dummyEpisodeRow];
          return [];
        }),
      } as any;
    });

    const results = await searchEpisodeCardsSqlite({
      query: "Test",
      status: "active",
      repoPath: "/repo",
      repoKey: "key",
      outcomeKinds: ["success"],
      evidenceStatuses: ["verified"],
      domains: ["test-domain"],
      technologies: ["vitest"],
      changeTypes: ["test-change"],
      tools: ["antigravity"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Test Episode");
  });
});
