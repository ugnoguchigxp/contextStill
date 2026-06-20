#!/usr/bin/env bun

import { eq, isNull, sql } from "drizzle-orm";
import { type DatabaseBackendKind, resolveDatabaseBackendConfig } from "../db/backend.js";
import { closeDbPool, db } from "../db/index.js";
import { knowledgeItems } from "../db/schema.js";
import { SqliteCoreRepository, openSqliteCoreDatabase } from "../db/sqlite/index.js";
import { embedOne } from "../modules/embedding/embedding.service.js";

type Options = {
  backend?: DatabaseBackendKind;
  dryRun: boolean;
  json: boolean;
  limit: number;
};

type BackfillItem = {
  id: string;
  type: string;
  status: string;
  scope: string;
  polarity: string;
  intentTags: unknown[];
  title: string;
  body: string;
  appliesTo: unknown;
  confidence: number;
  importance: number;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
};

type BackfillResult = {
  backend: DatabaseBackendKind;
  dryRun: boolean;
  scanned: number;
  embedded: number;
  failed: Array<{ id: string; title: string; error: string }>;
  items: Array<{ id: string; title: string; status: string; type: string }>;
};

function parseArgs(args: string[]): Options {
  const options: Options = { dryRun: false, json: false, limit: 0 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--backend") {
      const value = args[index + 1];
      index += 1;
      if (value !== "sqlite" && value !== "postgres") {
        throw new Error("--backend must be sqlite or postgres");
      }
      options.backend = value;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(args[index + 1]);
      index += 1;
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = Math.floor(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: bun run src/cli/backfill-knowledge-embeddings.ts [--backend sqlite|postgres] [--dry-run] [--limit N] [--json]",
          "",
          "Embeds knowledge rows that do not currently have a stored vector.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function limitSql(limit: number): string {
  return limit > 0 ? `limit ${Math.floor(limit)}` : "";
}

async function backfillSqlite(options: Options): Promise<BackfillResult> {
  const config = resolveDatabaseBackendConfig({ backend: "sqlite" });
  if (!config.sqlitePath) throw new Error("SQLite backend path could not be resolved");

  const sqlite = await openSqliteCoreDatabase({ path: config.sqlitePath });
  const repo = new SqliteCoreRepository(sqlite);
  try {
    const rows = sqlite.db
      .query<{
        id: string;
        type: string;
        status: string;
        scope: string;
        polarity: string;
        intent_tags: string;
        title: string;
        body: string;
        applies_to: string;
        confidence: number;
        importance: number;
        metadata: string;
        created_at: string;
        updated_at: string;
      }>(`
SELECT
  k.id,
  k.type,
  k.status,
  k.scope,
  k.polarity,
  k.intent_tags,
  k.title,
  k.body,
  k.applies_to,
  k.confidence,
  k.importance,
  k.metadata,
  k.created_at,
  k.updated_at
FROM knowledge_items k
LEFT JOIN knowledge_items_vec_fallback v ON v.knowledge_id = k.id
WHERE v.knowledge_id IS NULL
ORDER BY k.created_at ASC
${limitSql(options.limit)};
`)
      .all()
      .map<BackfillItem>((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        scope: row.scope,
        polarity: row.polarity,
        intentTags: asUnknownArray(parseJson(row.intent_tags, [])),
        title: row.title,
        body: row.body,
        appliesTo: parseJson(row.applies_to, {}),
        confidence: row.confidence,
        importance: row.importance,
        metadata: parseJson(row.metadata, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

    const result: BackfillResult = {
      backend: "sqlite",
      dryRun: options.dryRun,
      scanned: rows.length,
      embedded: 0,
      failed: [],
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        type: row.type,
      })),
    };

    if (options.dryRun) return result;

    for (const row of rows) {
      try {
        const embedding = await embedOne(`${row.title}\n${row.body}`, "passage");
        repo.upsertKnowledgeItem({ ...row, embedding });
        result.embedded += 1;
      } catch (error) {
        result.failed.push({
          id: row.id,
          title: row.title,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  } finally {
    repo.close();
  }
}

async function backfillPostgres(options: Options): Promise<BackfillResult> {
  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
    })
    .from(knowledgeItems)
    .where(isNull(knowledgeItems.embedding))
    .orderBy(knowledgeItems.createdAt)
    .limit(options.limit > 0 ? options.limit : 100_000);

  const result: BackfillResult = {
    backend: "postgres",
    dryRun: options.dryRun,
    scanned: rows.length,
    embedded: 0,
    failed: [],
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      type: row.type,
    })),
  };

  if (options.dryRun) return result;

  for (const row of rows) {
    try {
      const embedding = await embedOne(`${row.title}\n${row.body}`, "passage");
      await db.update(knowledgeItems).set({ embedding }).where(eq(knowledgeItems.id, row.id));
      result.embedded += 1;
    } catch (error) {
      result.failed.push({
        id: row.id,
        title: row.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await db.execute(sql`select 1`);
  return result;
}

function printResult(result: BackfillResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    [
      `Knowledge embedding backfill (${result.backend})`,
      `dryRun=${result.dryRun}`,
      `scanned=${result.scanned}`,
      `embedded=${result.embedded}`,
      `failed=${result.failed.length}`,
    ].join("\n"),
  );
  if (result.items.length > 0) {
    console.log("items:");
    for (const item of result.items) {
      console.log(`- ${item.id} [${item.status}/${item.type}] ${item.title}`);
    }
  }
  if (result.failed.length > 0) {
    console.log("failures:");
    for (const item of result.failed) {
      console.log(`- ${item.id} ${item.title}: ${item.error}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const backend = options.backend ?? resolveDatabaseBackendConfig().kind;
  const result =
    backend === "sqlite" ? await backfillSqlite(options) : await backfillPostgres(options);
  printResult(result, options.json);
  if (result.failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool().catch(() => undefined);
  });
