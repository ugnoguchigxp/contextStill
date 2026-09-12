import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveDatabaseBackendConfig } from "../src/db/backend.js";
import { db } from "../src/db/index.js";
import { openSqliteCoreDatabase } from "../src/db/sqlite/index.js";
import { runRepositoryIdentityBackfill } from "../src/modules/context-compiler/repository-identity-backfill.service.js";

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: vi.fn(),
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../src/db/sqlite/index.js", () => ({
  openSqliteCoreDatabase: vi.fn(),
}));

const reviewedAt = "2026-08-15T00:00:00.000Z";

function knowledgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "knowledge-1",
    classification_status: "unresolved",
    scope: "repo",
    project_ref: null,
    repo_key: null,
    repo_path: null,
    metadata: {
      projectIdentity: {
        classificationStatus: "classified",
        scope: "repo",
        repoPath: "/work/repo-a/./",
      },
    },
    applies_to: {},
    ...overrides,
  };
}

function conflictRow() {
  return knowledgeRow({
    id: "knowledge-conflict",
    metadata: { repoPath: "/work/a", projectRoot: "/work/b" },
  });
}

function sqliteMock(rowsByTable: Record<string, unknown[]>) {
  const exec = vi.fn();
  const close = vi.fn();
  const query = vi.fn((sql: string) => ({
    all: vi.fn(() => {
      const text = sql.toLowerCase();
      if (text.includes("from knowledge_items")) return rowsByTable.knowledge ?? [];
      if (text.includes("from sources") && !text.includes("knowledge_source")) {
        return rowsByTable.sources ?? [];
      }
      if (text.includes("from episode_cards")) return rowsByTable.episodes ?? [];
      if (text.includes("from project_identity_aliases")) return rowsByTable.aliases ?? [];
      if (text.includes("from knowledge_source_links")) return rowsByTable.linkedSources ?? [];
      if (text.includes("from knowledge_origin_links")) return rowsByTable.linkedMemories ?? [];
      if (text.includes("from distillation_target_states")) return rowsByTable.targets ?? [];
      if (text.includes("from finalize_distille_queue")) return rowsByTable.finalize ?? [];
      if (text.includes("from cover_evidence_results")) return rowsByTable.legacyCover ?? [];
      if (text.includes("from context_compile_runs")) return rowsByTable.runs ?? [];
      return [];
    }),
    run: vi.fn(() => ({ changes: 1 })),
    get: vi.fn(() => null),
  }));
  return { db: { query, exec, close }, path: "/tmp/core.sqlite" };
}

function postgresSelect(aliases: unknown[] = []) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({
      where: vi.fn(async () => aliases),
    })),
  } as never);
}

function postgresExecute(rowsByHint: Record<string, unknown[]>) {
  vi.mocked(db.execute).mockImplementation((async (query: unknown) => {
    const text = JSON.stringify(query).toLowerCase();
    if (text.includes("knowledge_items") && !text.includes("knowledge_source")) {
      return { rows: rowsByHint.knowledge ?? [] } as never;
    }
    if (text.includes("from sources") || text.includes('from\\" sources')) {
      return { rows: rowsByHint.sources ?? [] } as never;
    }
    if (text.includes("episode_cards")) return { rows: rowsByHint.episodes ?? [] } as never;
    if (text.includes("distillation_target_states")) {
      return { rows: rowsByHint.targets ?? [] } as never;
    }
    if (text.includes("cover_evidence_results")) {
      return { rows: rowsByHint.legacyCover ?? [] } as never;
    }
    if (text.includes("finalize_distille_queue")) {
      return { rows: rowsByHint.finalize ?? [] } as never;
    }
    if (text.includes("context_compile_runs")) return { rows: rowsByHint.runs ?? [] } as never;
    if (text.includes("knowledge_source_links")) {
      return { rows: rowsByHint.linkedSources ?? [] } as never;
    }
    if (text.includes("knowledge_origin_links")) {
      return { rows: rowsByHint.linkedMemories ?? [] } as never;
    }
    return Promise.resolve({ rows: [] });
  }) as unknown as typeof db.execute);
}

describe("runRepositoryIdentityBackfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postgresSelect();
    postgresExecute({});
    vi.mocked(db.transaction).mockImplementation(async (cb) => {
      const tx = {
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(async () => undefined),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((payload: unknown) =>
            Object.assign(Promise.resolve({}), {
              onConflictDoNothing: vi.fn(() => ({
                returning: vi.fn(async () => (Array.isArray(payload) ? [] : [{ id: "audit-1" }])),
              })),
            }),
          ),
        })),
      };
      return cb(tx as never);
    });
  });

  test("returns an empty sqlite dry-run without writing", async () => {
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({
      kind: "sqlite",
      url: "",
      sqlitePath: "/tmp/core.sqlite",
    });
    const sqlite = sqliteMock({});
    vi.mocked(openSqliteCoreDatabase).mockResolvedValue(sqlite as never);

    const result = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    expect(result).toMatchObject({
      mode: "dry-run",
      backend: "sqlite",
      updatedCount: 0,
      auditInsertedCount: 0,
      backupReference: null,
      counts: {
        backfilled: 0,
        unresolved: 0,
        conflict: 0,
        malformed: 0,
        global_promoted: 0,
        unchanged: 0,
      },
    });
    expect(sqlite.db.exec).toHaveBeenCalledWith("BEGIN");
    expect(sqlite.db.exec).toHaveBeenCalledWith("ROLLBACK");
    expect(sqlite.db.close).toHaveBeenCalled();
  });

  test("sqlite dry-run classifies, conflicts, and rejects write without backup inputs", async () => {
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({
      kind: "sqlite",
      url: "",
      sqlitePath: "/tmp/core.sqlite",
    });
    const sqlite = sqliteMock({
      knowledge: [
        knowledgeRow(),
        conflictRow(),
        knowledgeRow({ id: "knowledge-empty", metadata: {} }),
      ],
      sources: [],
      episodes: [],
    });
    vi.mocked(openSqliteCoreDatabase).mockResolvedValue(sqlite as never);

    const dryRun = await runRepositoryIdentityBackfill({
      mode: "dry-run",
      sqlitePath: "/tmp/core.sqlite",
    });
    expect(dryRun.decisions.find((item) => item.entityId === "knowledge-1")?.outcome).toBe(
      "backfilled",
    );
    expect(dryRun.decisions.find((item) => item.entityId === "knowledge-conflict")?.outcome).toBe(
      "conflict",
    );
    expect(dryRun.updatedCount).toBe(0);

    await expect(
      runRepositoryIdentityBackfill({ mode: "write", sqlitePath: "/tmp/core.sqlite" }),
    ).rejects.toThrow("backup-reference");
    await expect(
      runRepositoryIdentityBackfill({
        mode: "write",
        sqlitePath: "/tmp/core.sqlite",
        backupReference: "snap",
      }),
    ).rejects.toThrow("checksum from a reviewed dry-run");
    await expect(
      runRepositoryIdentityBackfill({
        mode: "write",
        sqlitePath: "/tmp/core.sqlite",
        backupReference: "snap",
        expectedChecksum: "stale",
      }),
    ).rejects.toThrow("checksum changed");
  });

  test("sqlite write applies changed rows, reviews, and rejects same-path backups", async () => {
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({
      kind: "sqlite",
      url: "",
      sqlitePath: "/tmp/core.sqlite",
    });
    const sqlite = sqliteMock({
      knowledge: [knowledgeRow()],
    });
    vi.mocked(openSqliteCoreDatabase).mockResolvedValue(sqlite as never);

    await expect(
      runRepositoryIdentityBackfill({
        mode: "write",
        expectedChecksum: "x",
        backupReference: "/tmp/core.sqlite",
      }),
    ).rejects.toThrow("must not be the target database path");

    const dryRun = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    const written = await runRepositoryIdentityBackfill({
      mode: "write",
      expectedChecksum: dryRun.checksum,
      backupReference: "offline-snapshot",
      reviewDecisions: [
        {
          entityKind: "knowledge",
          entityId: "knowledge-1",
          decision: "repo",
          reviewer: "reviewer",
          reason: "matches repo provenance",
          reviewedAt,
        },
      ],
    });
    expect(written.mode).toBe("write");
    expect(written.updatedCount).toBe(1);
    expect(written.auditInsertedCount).toBeGreaterThan(0);
    expect(sqlite.db.exec).toHaveBeenCalledWith("BEGIN IMMEDIATE");
    expect(sqlite.db.exec).toHaveBeenCalledWith("COMMIT");
  });

  test("requires matching global reviews and rejects conflicting or duplicate reviews", async () => {
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({
      kind: "sqlite",
      url: "",
      sqlitePath: "/tmp/core.sqlite",
    });
    const sqlite = sqliteMock({
      knowledge: [knowledgeRow({ id: "knowledge-global", metadata: {} })],
    });
    vi.mocked(openSqliteCoreDatabase).mockResolvedValue(sqlite as never);

    await expect(
      runRepositoryIdentityBackfill({
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "knowledge-global",
            decision: "global",
            reviewer: "a",
            reason: "one",
            reviewedAt,
          },
          {
            entityKind: "knowledge",
            entityId: "knowledge-global",
            decision: "global",
            reviewer: "b",
            reason: "two",
            reviewedAt,
          },
        ],
      }),
    ).rejects.toThrow("duplicate review decision");

    await expect(
      runRepositoryIdentityBackfill({
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "missing",
            decision: "global",
            reviewer: "a",
            reason: "unknown",
            reviewedAt,
          },
        ],
      }),
    ).rejects.toThrow("unknown entity");

    const dryRun = await runRepositoryIdentityBackfill({
      mode: "dry-run",
      explicitGlobalPromotions: { knowledge: ["knowledge-global"] },
      reviewDecisions: [
        {
          entityKind: "knowledge",
          entityId: "knowledge-global",
          decision: "global",
          reviewer: "reviewer",
          reason: "shared infra",
          reviewedAt,
        },
      ],
    });
    expect(dryRun.decisions[0]?.outcome).toBe("global_promoted");

    await expect(
      runRepositoryIdentityBackfill({
        mode: "write",
        expectedChecksum: dryRun.checksum,
        backupReference: "snap",
        explicitGlobalPromotions: { knowledge: ["knowledge-global"] },
      }),
    ).rejects.toThrow("matching global review decision");

    await expect(
      runRepositoryIdentityBackfill({
        mode: "dry-run",
        explicitGlobalPromotions: { knowledge: ["knowledge-global"] },
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "knowledge-global",
            decision: "repo",
            reviewer: "reviewer",
            reason: "wrong",
            reviewedAt,
          },
        ],
      }),
    ).rejects.toThrow("conflicts with deterministic plan");
  });

  test("postgres dry-run and write cover empty and changed batches", async () => {
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({
      kind: "postgres",
      url: "postgres://localhost/test",
      sqlitePath: null,
    });
    postgresExecute({});
    const empty = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    expect(empty).toMatchObject({ backend: "postgres", updatedCount: 0, decisions: [] });

    postgresExecute({ knowledge: [knowledgeRow()] });
    const dryRun = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    const written = await runRepositoryIdentityBackfill({
      mode: "write",
      expectedChecksum: dryRun.checksum,
      backupReference: "pg_dump:before",
      batchSize: 1,
    });
    expect(written.backend).toBe("postgres");
    expect(written.updatedCount).toBe(1);
    expect(db.transaction).toHaveBeenCalled();
  });

  test("throws when sqlite path is missing", async () => {
    vi.mocked(resolveDatabaseBackendConfig).mockReturnValue({
      kind: "sqlite",
      url: "",
      sqlitePath: null,
    });
    await expect(runRepositoryIdentityBackfill({ mode: "dry-run" })).rejects.toThrow(
      "SQLite path is required",
    );
  });

  test("rejects invalid review timestamps and blank fields", async () => {
    await expect(
      runRepositoryIdentityBackfill({
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "x",
            decision: "global",
            reviewer: " ",
            reason: "reason",
            reviewedAt,
          },
        ],
      }),
    ).rejects.toThrow("review decision requires entityId, reviewer, and reason");
    await expect(
      runRepositoryIdentityBackfill({
        reviewDecisions: [
          {
            entityKind: "source",
            entityId: "s1",
            decision: "unresolved",
            reviewer: "r",
            reason: "reason",
            reviewedAt: "not-a-date",
          },
        ],
      }),
    ).rejects.toThrow("invalid reviewedAt");
  });
});
