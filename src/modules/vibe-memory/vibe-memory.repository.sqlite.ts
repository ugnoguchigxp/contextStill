import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import type { VibeMemorySeed } from "./vibe-memory.repository.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

export type SqliteVibeMemoryRow = {
  id: string;
  sessionId: string;
  content: string;
  memoryType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  score?: number;
};

type RawVibeMemoryRow = {
  id: string;
  session_id: string;
  content: string;
  memory_type: string;
  metadata: string;
  created_at: string;
  score?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function mapMemory(row: RawVibeMemoryRow): SqliteVibeMemoryRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    memoryType: row.memory_type,
    metadata: parseRecord(row.metadata),
    createdAt: toDate(row.created_at),
    score: row.score,
  };
}

function tokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,，、。;；:：()（）[\]{}「」『』/|]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ].slice(0, 12);
}

function scoreText(value: string, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const text = value.toLowerCase();
  let score = text.includes(normalized) ? 4 : 0;
  for (const token of tokens(query)) {
    if (text.includes(token)) score += 1;
  }
  return score;
}

export async function insertVibeMemorySqlite(seed: VibeMemorySeed): Promise<SqliteVibeMemoryRow> {
  const sqlite = await getSqliteCoreDatabase();
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const content = redactSecrets(seed.content);
  const memoryType = seed.memoryType ?? "chat";
  const metadata = JSON.stringify(redactSecretRecord(seed.metadata ?? {}));
  sqlite.db
    .query(
      `
      insert into vibe_memories (
        id, session_id, content, memory_type, metadata, created_at
      ) values (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(id, seed.sessionId, content, memoryType, metadata, createdAt);
  sqlite.db
    .query("insert into vibe_memories_fts(rowid, id, content) values (?, ?, ?)")
    .run(
      sqlite.db.query<{ rowid: number }, []>("select last_insert_rowid() as rowid").get()?.rowid ??
        0,
      id,
      content,
    );
  return {
    id,
    sessionId: seed.sessionId,
    content,
    memoryType,
    metadata: parseRecord(metadata),
    createdAt: toDate(createdAt),
  };
}

export async function searchVibeMemoriesSqlite(params: {
  query: string;
  limit: number;
  sessionId?: string;
}): Promise<SqliteVibeMemoryRow[]> {
  const query = params.query.trim();
  if (!query) return [];
  const sqlite = await getSqliteCoreDatabase();
  const rows = sqlite.db
    .query<RawVibeMemoryRow, []>(
      `
      select
        vm.id,
        vm.session_id,
        vm.content,
        vm.memory_type,
        vm.metadata,
        vm.created_at
      from vibe_memories vm
      order by vm.created_at desc
      limit 500
    `,
    )
    .all()
    .filter((row) => !params.sessionId || row.session_id === params.sessionId)
    .map((row) => ({
      ...row,
      score:
        scoreText(row.content, query) +
        (sqlite.db
          .query<{ count: number }, [string, string, string, string, string, string]>(
            `
            select count(*) as count
            from agent_diff_entries
            where vibe_memory_id = ?
              and (
                lower(file_path) like ?
                or lower(diff_hunk) like ?
                or lower(coalesce(symbol_name, '')) like ?
                or lower(coalesce(symbol_kind, '')) like ?
                or lower(coalesce(signature, '')) like ?
              )
          `,
          )
          .get(
            row.id,
            `%${query.toLowerCase()}%`,
            `%${query.toLowerCase()}%`,
            `%${query.toLowerCase()}%`,
            `%${query.toLowerCase()}%`,
            `%${query.toLowerCase()}%`,
          )?.count ?? 0),
    }))
    .filter((row) => (row.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.created_at.localeCompare(a.created_at))
    .slice(0, params.limit);
  return rows.map(mapMemory);
}
