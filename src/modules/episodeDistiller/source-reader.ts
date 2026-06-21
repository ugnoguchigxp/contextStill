import { asc, eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";

type SourceBlockKind = "memory" | "agent_diff";

export type EpisodeSourceEvent = {
  id: string;
  kind: SourceBlockKind;
  createdAt: string;
  filePath?: string | null;
  startOffset: number;
  endOffset: number;
};

export type EpisodeSourceDocument = {
  vibeMemoryId: string;
  sessionId: string;
  content: string;
  metadata: Record<string, unknown>;
  events: EpisodeSourceEvent[];
};

type MemoryRow = {
  id: string;
  session_id: string;
  content: string;
  metadata: unknown;
  created_at: string | Date;
};

type DiffRow = {
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
  metadata: unknown;
  created_at: string | Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function appendBlock(params: {
  parts: string[];
  events: EpisodeSourceEvent[];
  kind: SourceBlockKind;
  eventId: string;
  createdAt: string;
  filePath?: string | null;
  body: string;
}): void {
  const startOffset = byteLength(params.parts.join(""));
  params.parts.push(params.body);
  const endOffset = byteLength(params.parts.join(""));
  params.events.push({
    id: params.eventId,
    kind: params.kind,
    createdAt: params.createdAt,
    filePath: params.filePath,
    startOffset,
    endOffset,
  });
}

function formatMemoryBlock(memory: MemoryRow): string {
  return [
    `[event:memory:${memory.id}]`,
    `created_at: ${toIso(memory.created_at)}`,
    `session_id: ${memory.session_id}`,
    "",
    memory.content.trim(),
    "",
  ].join("\n");
}

function formatDiffBlock(entry: DiffRow): string {
  return [
    `[event:agent_diff:${entry.id}]`,
    `created_at: ${toIso(entry.created_at)}`,
    `file_path: ${entry.file_path}`,
    entry.change_type ? `change_type: ${entry.change_type}` : undefined,
    entry.language ? `language: ${entry.language}` : undefined,
    entry.symbol_name ? `symbol_name: ${entry.symbol_name}` : undefined,
    entry.symbol_kind ? `symbol_kind: ${entry.symbol_kind}` : undefined,
    entry.signature ? `signature: ${entry.signature}` : undefined,
    entry.start_line || entry.end_line
      ? `line_range: ${entry.start_line ?? "?"}-${entry.end_line ?? "?"}`
      : undefined,
    "",
    entry.diff_hunk.trim(),
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

async function readSqliteRows(vibeMemoryId: string): Promise<{
  memory: MemoryRow | null;
  diffs: DiffRow[];
}> {
  const sqlite = await getSqliteCoreDatabase();
  const memory =
    sqlite.db
      .query<MemoryRow, [string]>(
        `
        select id, session_id, content, metadata, created_at
        from vibe_memories
        where id = ?
        limit 1
      `,
      )
      .get(vibeMemoryId) ?? null;
  const diffs = sqlite.db
    .query<DiffRow, [string]>(
      `
      select
        id,
        vibe_memory_id,
        file_path,
        diff_hunk,
        change_type,
        language,
        symbol_name,
        symbol_kind,
        signature,
        start_line,
        end_line,
        metadata,
        created_at
      from agent_diff_entries
      where vibe_memory_id = ?
      order by created_at asc, file_path asc, id asc
    `,
    )
    .all(vibeMemoryId);
  return { memory, diffs };
}

async function readPostgresRows(vibeMemoryId: string): Promise<{
  memory: MemoryRow | null;
  diffs: DiffRow[];
}> {
  const [memoryRow] = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.id, vibeMemoryId))
    .limit(1);
  const diffs = await db
    .select()
    .from(agentDiffEntries)
    .where(eq(agentDiffEntries.vibeMemoryId, vibeMemoryId))
    .orderBy(
      asc(agentDiffEntries.createdAt),
      asc(agentDiffEntries.filePath),
      asc(agentDiffEntries.id),
    );
  return {
    memory: memoryRow
      ? {
          id: memoryRow.id,
          session_id: memoryRow.sessionId,
          content: memoryRow.content,
          metadata: memoryRow.metadata,
          created_at: memoryRow.createdAt,
        }
      : null,
    diffs: diffs.map((entry) => ({
      id: entry.id,
      vibe_memory_id: entry.vibeMemoryId,
      file_path: entry.filePath,
      diff_hunk: entry.diffHunk,
      change_type: entry.changeType,
      language: entry.language,
      symbol_name: entry.symbolName,
      symbol_kind: entry.symbolKind,
      signature: entry.signature,
      start_line: entry.startLine,
      end_line: entry.endLine,
      metadata: entry.metadata,
      created_at: entry.createdAt,
    })),
  };
}

export async function readEpisodeSourceDocument(
  vibeMemoryId: string,
): Promise<EpisodeSourceDocument> {
  const id = vibeMemoryId.trim();
  if (!id) throw new Error("vibeMemoryId is required");
  const { memory, diffs } =
    resolveDatabaseBackendConfig().kind === "sqlite"
      ? await readSqliteRows(id)
      : await readPostgresRows(id);
  if (!memory) {
    throw new Error(`vibe memory not found: ${id}`);
  }

  const parts: string[] = [];
  const events: EpisodeSourceEvent[] = [];
  appendBlock({
    parts,
    events,
    kind: "memory",
    eventId: `memory:${memory.id}`,
    createdAt: toIso(memory.created_at),
    body: formatMemoryBlock(memory),
  });
  for (const entry of diffs) {
    appendBlock({
      parts,
      events,
      kind: "agent_diff",
      eventId: `agent_diff:${entry.id}`,
      createdAt: toIso(entry.created_at),
      filePath: entry.file_path,
      body: formatDiffBlock(entry),
    });
  }

  return {
    vibeMemoryId: memory.id,
    sessionId: memory.session_id,
    content: parts.join(""),
    metadata: asRecord(memory.metadata),
    events,
  };
}
