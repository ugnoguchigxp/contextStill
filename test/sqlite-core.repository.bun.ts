import { mkdtemp, rm } from "node:fs/promises";
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
});
