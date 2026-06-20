import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Database as NativeBunSqliteDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { groupedConfig } from "../../config.js";
import { createSqliteCoreSchemaSql } from "./core-schema.js";
import * as schema from "./schema.js";

type BunSqliteDatabase = {
  filename: string;
  exec(sql: string): void;
  serialize(name?: string): Buffer;
  query<T = unknown, P extends unknown[] = unknown[]>(
    sql: string,
  ): {
    all(...params: P): T[];
    get(...params: P): T | null;
    run(...params: P): { changes: number; lastInsertRowid: number | bigint };
  };
  loadExtension?(file: string, entrypoint?: string): void;
  close(): void;
};

export type SqliteVectorCapability = {
  available: boolean;
  extensionPath: string | null;
  reason: string | null;
};

export type SqliteCoreDatabase = {
  db: BunSqliteDatabase;
  orm: ReturnType<typeof createSqliteDrizzle>;
  path: string;
  vector: SqliteVectorCapability;
};

function createSqliteDrizzle(db: BunSqliteDatabase) {
  return drizzle(db as unknown as NativeBunSqliteDatabase, { schema });
}

export async function openSqliteCoreDatabase(input: {
  path: string;
  vectorDimension?: number;
  loadVectorExtension?: boolean;
}): Promise<SqliteCoreDatabase> {
  await mkdir(path.dirname(input.path), { recursive: true });
  const sqlite = await import("bun:sqlite");
  const db = new sqlite.Database(input.path, { create: true }) as BunSqliteDatabase;
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  const vector =
    input.loadVectorExtension === false ? disabledVectorCapability() : await loadVec(db);
  db.exec(
    createSqliteCoreSchemaSql({
      vectorDimension: input.vectorDimension ?? groupedConfig.embedding.dimension,
    }),
  );
  if (vector.available) {
    createVecVirtualTables(db, input.vectorDimension ?? groupedConfig.embedding.dimension);
  }

  return { db, orm: createSqliteDrizzle(db), path: input.path, vector };
}

function disabledVectorCapability(): SqliteVectorCapability {
  return {
    available: false,
    extensionPath: null,
    reason: "sqlite-vec loading disabled by caller",
  };
}

async function loadVec(db: BunSqliteDatabase): Promise<SqliteVectorCapability> {
  let extensionPath: string | null = null;
  try {
    const sqliteVec = await import("sqlite-vec");
    extensionPath = sqliteVec.getLoadablePath();
    if (typeof db.loadExtension !== "function") {
      return {
        available: false,
        extensionPath,
        reason: "SQLite binding does not expose loadExtension",
      };
    }
    db.loadExtension(extensionPath);
    return { available: true, extensionPath, reason: null };
  } catch (error) {
    return {
      available: false,
      extensionPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function createVecVirtualTables(db: BunSqliteDatabase, vectorDimension: number): void {
  const dimension = Math.max(1, Math.trunc(vectorDimension));
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_vec USING vec0(
  embedding float[${dimension}]
);
CREATE VIRTUAL TABLE IF NOT EXISTS source_fragments_vec USING vec0(
  embedding float[${dimension}]
);
`);
}
