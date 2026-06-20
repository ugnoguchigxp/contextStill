#!/usr/bin/env bun

import { resolveDatabaseBackendConfig } from "../db/backend.js";
import { openSqliteCoreDatabase, SqliteCoreRepository } from "../db/sqlite/index.js";

type Options = {
  json: boolean;
};

function parseArgs(args: string[]): Options {
  const options: Options = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run src/cli/sqlite-rebuild-vectors.ts [--json]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function parseVectorJson(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.map((entry) => Number(entry));
    return vector.length > 0 && vector.every(Number.isFinite) ? vector : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveDatabaseBackendConfig({ backend: "sqlite" });
  if (!config.sqlitePath) {
    throw new Error("SQLite backend path could not be resolved");
  }

  const sqlite = await openSqliteCoreDatabase({ path: config.sqlitePath });
  const repo = new SqliteCoreRepository(sqlite);
  try {
    const knowledgeRows = sqlite.db
      .query<{
        id: string;
        title: string;
        body: string;
        embedding_json: string;
      }>(`
SELECT k.id, k.title, k.body, v.embedding_json
FROM knowledge_items k
JOIN knowledge_items_vec_fallback v ON v.knowledge_id = k.id;
`)
      .all()
      .map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        embedding: parseVectorJson(row.embedding_json),
      }));
    const sourceRows = sqlite.db
      .query<{
        id: string;
        content: string;
        embedding_json: string;
      }>(`
SELECT f.id, f.content, v.embedding_json
FROM source_fragments f
JOIN source_fragments_vec_fallback v ON v.source_fragment_id = f.id;
`)
      .all()
      .map((row) => ({
        id: row.id,
        content: row.content,
        embedding: parseVectorJson(row.embedding_json),
      }));

    const knowledgeVectorCount = repo.rebuildKnowledgeVectors(knowledgeRows);
    const sourceFragmentVectorCount = repo.rebuildSourceFragmentVectors(sourceRows);
    const result = {
      path: config.sqlitePath,
      sqliteVecAvailable: sqlite.vector.available,
      sqliteVecReason: sqlite.vector.reason,
      knowledgeVectorCount,
      sourceFragmentVectorCount,
      rebuiltAt: new Date().toISOString(),
    };
    console.log(
      options.json
        ? JSON.stringify(result, null, 2)
        : `Rebuilt SQLite vectors: knowledge=${knowledgeVectorCount}, sourceFragments=${sourceFragmentVectorCount}`,
    );
  } finally {
    repo.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
