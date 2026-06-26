import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { db } from "../../../src/db/client.js";
import { vibeMemories } from "../../../src/db/schema.js";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../../../src/modules/vibe-memory/vibe-memory.service.js";

import { recordVibeMemoryInputSchema } from "../../../src/shared/schemas/vibe-memory.schema.js";

export const vibeMemoryRouter = new Hono();

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function timestampToIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const unixMillis = trimmed.startsWith("unix-ms:")
    ? Number(trimmed.slice("unix-ms:".length))
    : Number.NaN;
  if (Number.isFinite(unixMillis)) {
    const date = new Date(unixMillis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapSqliteVibeMemory(row: Record<string, unknown>) {
  const createdAt = timestampToIso(row.created_at);
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    memoryType: row.memory_type,
    dedupeKey: row.dedupe_key,
    embedding: row.embedding,
    metadata: parseJson(row.metadata as string | null | undefined),
    createdAt: createdAt ?? row.created_at,
    goalId: row.goal_id,
    parentId: row.parent_id,
    subject: row.subject,
    intent: row.intent,
    wants: parseJson(row.wants as string | null | undefined),
    refs: parseJson(row.refs as string | null | undefined),
    confidence: row.confidence,
    evidenceStatus: row.evidence_status,
    actorId: row.actor_id,
    ttlAt: timestampToIso(row.ttl_at) ?? row.ttl_at,
  };
}

const sqliteEffectiveVibeMemoryTimestampSql = `
  case
    when coalesce(nullif(json_extract(metadata, '$.timestamp'), ''), '') like 'unix-ms:%'
      then datetime(cast(substr(json_extract(metadata, '$.timestamp'), 9) as integer) / 1000, 'unixepoch')
    when coalesce(nullif(json_extract(metadata, '$.sessionStartedAt'), ''), '') like 'unix-ms:%'
      then datetime(cast(substr(json_extract(metadata, '$.sessionStartedAt'), 9) as integer) / 1000, 'unixepoch')
    when coalesce(created_at, '') like 'unix-ms:%'
      then datetime(cast(substr(created_at, 9) as integer) / 1000, 'unixepoch')
    else coalesce(
      datetime(nullif(json_extract(metadata, '$.timestamp'), '')),
      datetime(nullif(json_extract(metadata, '$.sessionStartedAt'), '')),
      datetime(created_at)
    )
  end
`;

// Legacy compatibility
vibeMemoryRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const memories = sqlite.db
      .query<Record<string, unknown>, [number]>(
        `
        select *
        from vibe_memories
        where memory_type <> 'capsule'
        order by
          ${sqliteEffectiveVibeMemoryTimestampSql} desc,
          created_at desc
        limit ?
      `,
      )
      .all(limit)
      .map(mapSqliteVibeMemory);
    return c.json({ memories });
  }

  const effectiveTimestamp = sql<string>`coalesce(
    nullif(${vibeMemories.metadata} ->> 'timestamp', ''),
    nullif(${vibeMemories.metadata} ->> 'sessionStartedAt', '')
  )`;
  const memories = await db
    .select()
    .from(vibeMemories)
    .where(and(ne(vibeMemories.memoryType, "capsule")))
    .orderBy(desc(effectiveTimestamp), desc(vibeMemories.createdAt))
    .limit(limit);
  return c.json({ memories });
});

// Legacy contextual search for raw Vibe Memory.
vibeMemoryRouter.get("/context", async (c) => {
  if (c.req.query("goalId") !== undefined || (c.req.queries("profile") ?? []).length > 0) {
    return c.json({ error: "Goal Room context has been removed." }, 400);
  }

  const query = c.req.query("query");
  const sessionId = c.req.query("sessionId");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

  const result = await retrieveVibeMemoryContext({
    query,
    sessionId,
    limit,
  });

  return c.json(result);
});

// Legacy compatibility
vibeMemoryRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const memory = sqlite.db
      .query<Record<string, unknown>, [string]>("select * from vibe_memories where id = ? limit 1")
      .get(id);
    if (!memory) {
      return c.json({ error: "Vibe memory not found" }, 404);
    }
    return c.json({ memory: mapSqliteVibeMemory(memory) });
  }

  const [memory] = await db.select().from(vibeMemories).where(eq(vibeMemories.id, id));
  if (!memory) {
    return c.json({ error: "Vibe memory not found" }, 404);
  }
  return c.json({ memory });
});

// Legacy compatibility
vibeMemoryRouter.post("/", zValidator("json", recordVibeMemoryInputSchema), async (c) => {
  const result = await recordVibeMemoryWithDiffEntries(c.req.valid("json"));
  return c.json(result, 201);
});

// Legacy compatibility
vibeMemoryRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db.query("delete from vibe_memories where id = ?").run(id);
    return c.json({ ok: true });
  }

  await db.delete(vibeMemories).where(eq(vibeMemories.id, id));
  return c.json({ ok: true });
});
