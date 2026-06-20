import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openSqliteCoreDatabase, type SqliteCoreDatabase } from "../src/db/sqlite/index.js";
import {
  migratePostgresToSqlite,
  type PostgresMigrationClient,
} from "../src/modules/sqlite-migration/postgres-to-sqlite.service.js";

type Row = Record<string, unknown>;

class FakePostgresClient implements PostgresMigrationClient {
  constructor(private readonly rowsByTable: Map<string, Row[]>) {}

  async query<T extends Row = Row>(queryText: string, values?: unknown[]): Promise<{ rows: T[] }> {
    if (queryText.includes("information_schema.tables")) {
      const table = String(values?.[0] ?? "");
      return { rows: [{ exists: this.rowsByTable.has(table) } as unknown as T] };
    }
    if (queryText.includes("information_schema.columns")) {
      const table = String(values?.[0] ?? "");
      const columns = Object.keys(this.rowsByTable.get(table)?.[0] ?? {});
      return { rows: columns.map((column_name) => ({ column_name }) as unknown as T) };
    }
    const table = tableFromQuery(queryText);
    const rows = this.rowsByTable.get(table) ?? [];
    if (/count\(\*\)/i.test(queryText)) {
      return { rows: [{ count: String(rows.length) } as unknown as T] };
    }
    const selectedColumns = selectedColumnsFromQuery(queryText);
    return {
      rows: rows.map((row) => {
        const projected: Row = {};
        for (const column of selectedColumns) {
          projected[column] = row[column];
        }
        return projected as T;
      }),
    };
  }
}

function tableFromQuery(queryText: string): string {
  const match = /from\s+"?([a-z_][a-z0-9_]*)"?/i.exec(queryText);
  if (!match?.[1]) throw new Error(`Could not parse table from query: ${queryText}`);
  return match[1];
}

function selectedColumnsFromQuery(queryText: string): string[] {
  const normalized = queryText.replace(/\s+/g, " ");
  if (normalized.includes("select id::text, title, body, embedding, updated_at")) {
    return ["id", "title", "body", "embedding", "updated_at"];
  }
  if (normalized.includes("select id::text, content, embedding, created_at")) {
    return ["id", "content", "embedding", "created_at"];
  }
  const match = /select\s+(.+?)\s+from/i.exec(normalized);
  if (!match?.[1]) throw new Error(`Could not parse columns from query: ${queryText}`);
  return match[1].split(",").map((column) => column.trim().replace(/^"|"$/g, ""));
}

let tempDir = "";
let sqlite: SqliteCoreDatabase | null = null;

describe("postgres to sqlite migration", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-sqlite-migration-"));
  });

  afterEach(async () => {
    if (sqlite) {
      sqlite.db.close();
      sqlite = null;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("dry-runs and applies active PostgreSQL rows into sqlite", async () => {
    const now = new Date("2026-06-20T00:00:00.000Z");
    const rowsByTable = new Map<string, Row[]>([
      [
        "knowledge_items",
        [
          {
            id: "11111111-1111-4111-8111-111111111111",
            type: "rule",
            status: "active",
            scope: "repo",
            polarity: "positive",
            intent_tags: ["verification"],
            title: "Keep evidence",
            body: "Evidence must migrate.",
            applies_to: { repoPath: "/tmp/repo" },
            confidence: 80,
            importance: 85,
            compile_select_count: 2,
            last_compiled_at: now,
            agentic_accept_count: 1,
            explicit_upvote_count: 0,
            explicit_downvote_count: 0,
            dynamic_score: 0.5,
            embedding: "[1,0,0]",
            metadata: { sourceRefs: ["sqlite://migration-test"] },
            created_at: now,
            updated_at: now,
            last_verified_at: now,
          },
        ],
      ],
      [
        "sources",
        [
          {
            id: "22222222-2222-4222-8222-222222222222",
            source_kind: "wiki",
            uri: "file:///migration.md",
            title: "Migration source",
            body: "Source body",
            metadata: { kind: "test" },
            created_at: now,
            updated_at: now,
            last_indexed_at: now,
          },
        ],
      ],
      [
        "source_fragments",
        [
          {
            id: "33333333-3333-4333-8333-333333333333",
            source_id: "22222222-2222-4222-8222-222222222222",
            locator: "L1",
            heading: "Heading",
            content: "Fragment content",
            embedding: "[0,1,0]",
            metadata: { index: 1 },
            created_at: now,
          },
        ],
      ],
      [
        "knowledge_source_links",
        [
          {
            id: "44444444-4444-4444-8444-444444444444",
            knowledge_id: "11111111-1111-4111-8111-111111111111",
            source_fragment_id: "33333333-3333-4333-8333-333333333333",
            link_type: "derived_from",
            confidence: 0.9,
            metadata: { reason: "test" },
            created_at: now,
          },
        ],
      ],
      [
        "context_compile_runs",
        [
          {
            id: "77777777-7777-4777-8777-777777777777",
            goal: "Migration run",
            intent: "implementation",
            session_id: "session-1",
            repo_path: "/tmp/repo",
            input: {},
            retrieval_mode: "hybrid",
            status: "ok",
            degraded_reasons: [],
            token_budget: 1000,
            duration_ms: 10,
            source: "cli",
            pack_snapshot: {},
            created_at: now,
          },
        ],
      ],
      [
        "context_pack_items",
        [
          {
            id: "88888888-8888-4888-8888-888888888888",
            run_id: "77777777-7777-4777-8777-777777777777",
            item_kind: "rule",
            item_id: "11111111-1111-4111-8111-111111111111",
            section: "rules",
            score: 0.9,
            ranking_reason: "migration test",
            source_refs: ["sqlite://migration-test"],
            created_at: now,
          },
        ],
      ],
      [
        "context_decision_runs",
        [
          {
            id: "55555555-5555-4555-8555-555555555555",
            session_id: "session-1",
            premise: "Premise",
            decision_point: "Migrate?",
            proposed_action: "Apply",
            options: [],
            retrieval_hints: {},
            decision: "proceed",
            selected_action: "Apply",
            rejected_actions: [],
            mandate: "Do it",
            agent_message: "Proceeding",
            confidence: 80,
            confidence_trace: {},
            autonomy_level: "high",
            risk_budget: "medium",
            knowledge_policy: "optional",
            available_rollback: "restore backup",
            verification_plan: "run tests",
            guardrails: {},
            unsupported_alternatives: [],
            status: "completed",
            metadata: { kind: "test" },
            created_at: now,
            updated_at: now,
          },
        ],
      ],
      [
        "llm_usage_logs",
        [
          {
            id: "66666666-6666-4666-8666-666666666666",
            provider: "test",
            model: "model",
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
            reasoning_tokens: 0,
            cost_jpy: 0.1,
            usage_mode: "estimated",
            source: "migration-test",
            created_at: now,
          },
        ],
      ],
    ]);
    const client = new FakePostgresClient(rowsByTable);
    const sqlitePath = path.join(tempDir, "context-still-core.sqlite");
    sqlite = await openSqliteCoreDatabase({
      path: sqlitePath,
      vectorDimension: 3,
      loadVectorExtension: false,
    });

    const dryRun = await migratePostgresToSqlite({
      mode: "dry-run",
      databaseUrl: "postgres://user:secret@example/db",
      sqlitePath,
      client,
      sqlite,
    });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.postgresUrl).toBe("postgres://REDACTED:REDACTED@example/db");
    expect(dryRun.tables.find((table) => table.table === "knowledge_items")?.sourceRows).toBe(1);
    expect(dryRun.tables.find((table) => table.table === "context_pack_items")).toMatchObject({
      skippedColumns: [],
      transformedColumns: ["id -> postgres_id"],
    });

    const applied = await migratePostgresToSqlite({
      mode: "insert-only",
      databaseUrl: "postgres://user:secret@example/db",
      sqlitePath,
      client,
      sqlite,
    });
    expect(applied.ok).toBe(true);
    expect(applied.vectorRows).toEqual({ knowledgeItems: 1, sourceFragments: 1 });
    expect(
      sqlite.db.query<{ count: number }>("select count(*) as count from knowledge_items").get()
        ?.count,
    ).toBe(1);
    expect(
      sqlite.db
        .query<{ count: number }>("select count(*) as count from knowledge_source_links")
        .get()?.count,
    ).toBe(1);
    expect(
      sqlite.db
        .query<{ count: number }>("select count(*) as count from context_decision_runs")
        .get()?.count,
    ).toBe(1);
    expect(
      sqlite.db
        .query<{ postgres_id: string }>("select postgres_id from context_pack_items limit 1")
        .get()?.postgres_id,
    ).toBe("88888888-8888-4888-8888-888888888888");
    expect(
      sqlite.db.query<{ count: number }>("select count(*) as count from llm_usage_logs").get()
        ?.count,
    ).toBe(1);
    expect(
      sqlite.db
        .query<{ count: number }>("select count(*) as count from knowledge_items_vec_fallback")
        .get()?.count,
    ).toBe(1);
    expect(
      sqlite.db
        .query<{ count: number }>("select count(*) as count from source_fragments_vec_fallback")
        .get()?.count,
    ).toBe(1);
  });
});
