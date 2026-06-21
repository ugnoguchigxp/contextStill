import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openSqliteCoreDatabase,
  sqliteKnowledgeItems,
  SqliteCoreRepository,
} from "../src/db/sqlite/index.js";

let tempDir = "";

describe("sqlite core repository", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-sqlite-core-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates core schema and rebuilds knowledge/source vector fallback tables", async () => {
    const sqlite = await openSqliteCoreDatabase({
      path: path.join(tempDir, "context-still-core.sqlite"),
      vectorDimension: 3,
    });
    const repo = new SqliteCoreRepository(sqlite);
    try {
      expect(sqlite.vector.available).toBe(false);
      expect(sqlite.vector.reason).toBeTruthy();

      repo.upsertKnowledgeItem({
        id: "k1",
        type: "rule",
        status: "active",
        title: "Prefer SQLite",
        body: "Use local SQLite for desktop storage.",
        embedding: [1, 0, 0],
      });
      repo.upsertKnowledgeItem({
        id: "k2",
        type: "rule",
        status: "active",
        title: "Prefer queue locks",
        body: "Use leases for worker queues.",
        embedding: [0, 1, 0],
      });
      repo.upsertSource({
        id: "s1",
        sourceKind: "wiki",
        uri: "file:///sqlite.md",
        body: "SQLite notes",
      });
      repo.upsertSourceFragment({
        id: "sf1",
        sourceId: "s1",
        locator: "L1",
        content: "SQLite vector content",
        embedding: [1, 0, 0],
      });

      const drizzleRows = sqlite.orm
        .select({
          id: sqliteKnowledgeItems.id,
          title: sqliteKnowledgeItems.title,
        })
        .from(sqliteKnowledgeItems)
        .all();
      expect(drizzleRows).toContainEqual({ id: "k1", title: "Prefer SQLite" });

      const leaseTable = sqlite.db
        .query<{ name: string }, []>(
          "select name from sqlite_master where type = 'table' and name = 'llm_provider_leases'",
        )
        .get();
      const activeLeaseIndex = sqlite.db
        .query<{ name: string }, []>(
          "select name from sqlite_master where type = 'index' and name = 'llm_provider_leases_active_target_unique_idx'",
        )
        .get();
      expect(leaseTable?.name).toBe("llm_provider_leases");
      expect(activeLeaseIndex?.name).toBe("llm_provider_leases_active_target_unique_idx");

      const knowledgeHits = repo.vectorSearchKnowledge([1, 0, 0], 2);
      expect(knowledgeHits.map((hit) => hit.id)).toEqual(["k1", "k2"]);
      expect(knowledgeHits[0].score).toBeGreaterThan(knowledgeHits[1].score);

      const sourceHits = repo.vectorSearchSourceFragments([1, 0, 0], 1);
      expect(sourceHits).toMatchObject([
        {
          id: "sf1",
          sourceId: "s1",
          sourceUri: "file:///sqlite.md",
          locator: "L1",
        },
      ]);
    } finally {
      repo.close();
    }
  });

  test("rebuilds vectors from canonical rows", async () => {
    const sqlite = await openSqliteCoreDatabase({
      path: path.join(tempDir, "context-still-core.sqlite"),
      vectorDimension: 3,
      loadVectorExtension: false,
    });
    const repo = new SqliteCoreRepository(sqlite);
    try {
      repo.upsertKnowledgeItem({
        id: "k1",
        type: "rule",
        status: "active",
        title: "A",
        body: "A body",
      });
      repo.upsertKnowledgeItem({
        id: "k2",
        type: "rule",
        status: "active",
        title: "B",
        body: "B body",
      });
      const count = repo.rebuildKnowledgeVectors([
        { id: "k1", title: "A", body: "A body", embedding: [0, 1, 0] },
        { id: "k2", title: "B", body: "B body", embedding: null },
      ]);
      expect(count).toBe(1);
      expect(repo.vectorSearchKnowledge([0, 1, 0], 5).map((hit) => hit.id)).toEqual(["k1"]);
    } finally {
      repo.close();
    }
  });

  test("backs up sqlite core database through the maintenance cli", async () => {
    const sourcePath = path.join(tempDir, "context-still-core.sqlite");
    const backupPath = path.join(tempDir, "backup", "context-still-core-backup.sqlite");
    const sqlite = await openSqliteCoreDatabase({
      path: sourcePath,
      vectorDimension: 3,
      loadVectorExtension: false,
    });
    const repo = new SqliteCoreRepository(sqlite);
    try {
      repo.upsertKnowledgeItem({
        id: "backup-k1",
        type: "rule",
        status: "active",
        title: "Backup row",
        body: "This row should survive backup.",
      });
    } finally {
      repo.close();
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli/sqlite-backup.ts", "--output", backupPath, "--json"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTEXT_STILL_DB_BACKEND: "sqlite",
        CONTEXT_STILL_SQLITE_CORE_PATH: sourcePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const metadata = JSON.parse(Buffer.from(result.stdout).toString()) as { bytes: number };
    expect(metadata.bytes).toBeGreaterThan(0);
    await expect(stat(backupPath)).resolves.toBeTruthy();

    const backup = await openSqliteCoreDatabase({
      path: backupPath,
      vectorDimension: 3,
      loadVectorExtension: false,
    });
    try {
      const row = backup.db
        .query<{ title: string }>("SELECT title FROM knowledge_items WHERE id = ?;")
        .get("backup-k1");
      expect(row?.title).toBe("Backup row");
    } finally {
      backup.db.close();
    }
  });

  test("sqlite backup fails when the source database path does not exist", () => {
    const missingSourcePath = path.join(tempDir, "missing.sqlite");
    const backupPath = path.join(tempDir, "backup", "missing-backup.sqlite");

    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli/sqlite-backup.ts", "--output", backupPath, "--json"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTEXT_STILL_DB_BACKEND: "sqlite",
        CONTEXT_STILL_SQLITE_CORE_PATH: missingSourcePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(Buffer.from(result.stderr).toString()).toContain("SQLite source database not found");
  });

  test("rebuilds sqlite vectors through the maintenance cli", async () => {
    const sourcePath = path.join(tempDir, "context-still-core.sqlite");
    const sqlite = await openSqliteCoreDatabase({
      path: sourcePath,
      vectorDimension: 3,
      loadVectorExtension: false,
    });
    const repo = new SqliteCoreRepository(sqlite);
    try {
      repo.upsertKnowledgeItem({
        id: "rebuild-k1",
        type: "rule",
        status: "active",
        title: "Rebuild row",
        body: "This row has a vector.",
        embedding: [1, 0, 0],
      });
      repo.upsertSource({
        id: "rebuild-s1",
        sourceKind: "wiki",
        uri: "file:///rebuild.md",
        body: "Rebuild source",
      });
      repo.upsertSourceFragment({
        id: "rebuild-sf1",
        sourceId: "rebuild-s1",
        locator: "L1",
        content: "This fragment has a vector.",
        embedding: [0, 1, 0],
      });
    } finally {
      repo.close();
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", "src/cli/sqlite-rebuild-vectors.ts", "--json"],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTEXT_STILL_DB_BACKEND: "sqlite",
        CONTEXT_STILL_SQLITE_CORE_PATH: sourcePath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const metadata = JSON.parse(Buffer.from(result.stdout).toString()) as {
      knowledgeVectorCount: number;
      sourceFragmentVectorCount: number;
    };
    expect(metadata.knowledgeVectorCount).toBe(1);
    expect(metadata.sourceFragmentVectorCount).toBe(1);
  });
});
