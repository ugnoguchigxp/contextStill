import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { db } from "../../../src/db/client.js";
import { agentDiffEntries } from "../../../src/db/schema.js";

export const agentDiffsRouter = new Hono();

type SqliteAgentDiffEntryRow = {
  id: string;
  vibe_memory_id: string;
  file_path: string;
  diff_hunk: string;
  change_type: string | null;
  language: string | null;
  symbol_name: string | null;
  symbol_kind: string | null;
  signature: string | null;
  start_line: number | null;
  end_line: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function listAgentDiffEntriesSqlite(params: {
  limit: number;
  id?: string;
  vibeMemoryId?: string;
  vibeMemoryIds?: string[];
}) {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (params.id) {
    where.push("id = ?");
    values.push(params.id);
  }
  if (params.vibeMemoryId) {
    where.push("vibe_memory_id = ?");
    values.push(params.vibeMemoryId);
  }
  if (params.vibeMemoryIds?.length) {
    where.push(`vibe_memory_id IN (${params.vibeMemoryIds.map(() => "?").join(", ")})`);
    values.push(...params.vibeMemoryIds);
  }
  values.push(params.limit);
  const rows = sqlite.db
    .query<SqliteAgentDiffEntryRow, Array<string | number>>(
      `SELECT *
       FROM agent_diff_entries
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT ?`,
    )
    .all(...values);
  return rows.map((row) => ({
    id: row.id,
    vibeMemoryId: row.vibe_memory_id,
    filePath: row.file_path,
    diffHunk: row.diff_hunk,
    changeType: row.change_type,
    language: row.language,
    symbolName: row.symbol_name,
    symbolKind: row.symbol_kind,
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

agentDiffsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 120);
  const id = c.req.query("id");
  const vibeMemoryId = c.req.query("vibeMemoryId");
  const vibeMemoryIds = c.req
    .query("vibeMemoryIds")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const entries = await listAgentDiffEntriesSqlite({
      limit,
      id,
      vibeMemoryId,
      vibeMemoryIds,
    });
    return c.json({ entries });
  }
  const filters = [
    id ? eq(agentDiffEntries.id, id) : undefined,
    vibeMemoryId ? eq(agentDiffEntries.vibeMemoryId, vibeMemoryId) : undefined,
    vibeMemoryIds?.length ? inArray(agentDiffEntries.vibeMemoryId, vibeMemoryIds) : undefined,
  ].filter((filter) => filter !== undefined);
  const entries = await db
    .select()
    .from(agentDiffEntries)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(agentDiffEntries.updatedAt))
    .limit(limit);
  return c.json({ entries });
});
