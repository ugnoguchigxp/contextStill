import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../../db/client.js";
import { sessionMemoEvents, sessionMemos } from "../../db/schema.js";
import { sessionMemoSlotLimit } from "../../shared/schemas/session-memo.schema.js";

type PutInput = {
  sessionId: string;
  slot?: number;
  label?: string;
  body: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
  source?: "mcp" | "ui" | "system" | "import";
};

function normalizeLabel(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function expireRows(sessionId: string, source: PutInput["source"] = "mcp"): Promise<void> {
  const now = new Date();
  const expired = await db
    .update(sessionMemos)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(sessionMemos.sessionId, sessionId),
        isNull(sessionMemos.deletedAt),
        lte(sessionMemos.expiresAt, now),
      ),
    )
    .returning({ slot: sessionMemos.slot, label: sessionMemos.label });
  if (expired.length === 0) return;
  await db.insert(sessionMemoEvents).values(
    expired.map((row) => ({
      sessionId,
      slot: row.slot,
      label: row.label,
      action: "expire",
      source: source ?? "mcp",
      metadata: {},
    })),
  );
}

async function nextEmptySlot(sessionId: string): Promise<number | null> {
  return nextEmptySlotIn(db, sessionId);
}

async function nextEmptySlotIn(
  tx: NodePgDatabase<typeof import("../../db/schema.js")> | typeof db,
  sessionId: string,
): Promise<number | null> {
  const rows = await tx
    .select({ slot: sessionMemos.slot })
    .from(sessionMemos)
    .where(and(eq(sessionMemos.sessionId, sessionId), isNull(sessionMemos.deletedAt)));
  const used = new Set(rows.map((r) => r.slot));
  for (let i = 0; i < sessionMemoSlotLimit; i += 1) {
    if (!used.has(i)) return i;
  }
  return null;
}

export async function putSessionMemo(input: PutInput) {
  await expireRows(input.sessionId, input.source);
  return db.transaction(async (tx) => putSessionMemoIn(tx, input));
}

async function putSessionMemoIn(
  tx: NodePgDatabase<typeof import("../../db/schema.js")> | typeof db,
  input: PutInput,
) {
  const label = normalizeLabel(input.label);
  const now = new Date();
  const source = input.source ?? "mcp";

  let rowByLabel:
    | { id: string; slot: number; label: string | null; body: string; metadata: unknown }
    | undefined;
  if (label) {
    const rows = await tx
      .select({
        id: sessionMemos.id,
        slot: sessionMemos.slot,
        label: sessionMemos.label,
        body: sessionMemos.body,
        metadata: sessionMemos.metadata,
      })
      .from(sessionMemos)
      .where(
        and(
          eq(sessionMemos.sessionId, input.sessionId),
          isNull(sessionMemos.deletedAt),
          sql`lower(${sessionMemos.label}) = lower(${label})`,
        ),
      )
      .limit(1);
    rowByLabel = rows[0];
  }

  let slot: number | null | undefined = input.slot;
  if (slot === undefined && rowByLabel) slot = rowByLabel.slot;
  if (slot === undefined) {
    const emptySlot = await nextEmptySlotIn(tx, input.sessionId);
    if (emptySlot === null) throw new Error("MEMO_FULL");
    slot = emptySlot;
  }
  const resolvedSlot = slot;

  if (rowByLabel && input.slot !== undefined && rowByLabel.slot !== input.slot) {
    throw new Error("LABEL_SLOT_CONFLICT");
  }

  const [saved] = await tx
    .insert(sessionMemos)
    .values({
      sessionId: input.sessionId,
      slot: resolvedSlot,
      label,
      body: input.body,
      metadata: input.metadata ?? {},
      source,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [sessionMemos.sessionId, sessionMemos.slot],
      targetWhere: sql`${sessionMemos.deletedAt} is null`,
      set: {
        label,
        body: input.body,
        metadata: input.metadata ?? {},
        source,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        updatedAt: now,
        deletedAt: null,
      },
    });
  })
  .returning();

  await tx.insert(sessionMemoEvents).values({
    sessionId: input.sessionId,
    slot: saved.slot,
    label: saved.label,
    action: "put",
    source,
    bodyPreview: input.body.slice(0, 200),
    metadata: input.metadata ?? {},
  });

  return saved;
}

export async function putManySessionMemos(
  sessionId: string,
  items: Array<Omit<PutInput, "sessionId">>,
  source: PutInput["source"] = "mcp",
) {
  await expireRows(sessionId, source);
  const saved = await db.transaction(async (tx) => {
    const rows = [];
    for (const item of items) {
      rows.push(await putSessionMemoIn(tx, { ...item, sessionId, source }));
    }
    return rows;
  });
  return saved;
}

export async function listSessionMemos(input: {
  sessionId: string;
  includeEmpty?: boolean;
  previewChars?: number;
}) {
  await expireRows(input.sessionId);
  const previewChars = input.previewChars ?? 320;
  const rows = await db
    .select()
    .from(sessionMemos)
    .where(and(eq(sessionMemos.sessionId, input.sessionId), isNull(sessionMemos.deletedAt)))
    .orderBy(sessionMemos.slot);
  const items = rows.map((row) => ({
    slot: row.slot,
    label: row.label,
    preview: row.body.slice(0, previewChars),
    previewChars,
    bodyLength: row.body.length,
    updatedAt: row.updatedAt,
    metadata: row.metadata,
    expiresAt: row.expiresAt,
  }));
  if (!input.includeEmpty) return items;
  const map = new Map(items.map((item) => [item.slot, item]));
  return Array.from({ length: sessionMemoSlotLimit }, (_, slot) => {
    const entry = map.get(slot);
    if (entry) return entry;
    return { slot, empty: true };
  });
}

export async function getSessionMemo(input: {
  sessionId: string;
  slot?: number;
  label?: string;
}) {
  await expireRows(input.sessionId);
  const label = normalizeLabel(input.label);
  if (input.slot === undefined && !label) {
    throw new Error("slot or label is required");
  }
  const rows = await db
    .select()
    .from(sessionMemos)
    .where(
      and(
        eq(sessionMemos.sessionId, input.sessionId),
        isNull(sessionMemos.deletedAt),
        input.slot !== undefined ? eq(sessionMemos.slot, input.slot) : undefined,
        label ? sql`lower(${sessionMemos.label}) = lower(${label})` : undefined,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSessionMemo(input: {
  sessionId: string;
  slot?: number;
  label?: string;
}) {
  await expireRows(input.sessionId);
  const row = await getSessionMemo(input);
  if (!row) return { ok: true, deleted: false };
  const now = new Date();
  await db
    .update(sessionMemos)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(sessionMemos.id, row.id));
  await db.insert(sessionMemoEvents).values({
    sessionId: input.sessionId,
    slot: row.slot,
    label: row.label,
    action: "delete",
    source: "mcp",
    bodyPreview: row.body.slice(0, 200),
    metadata: {},
  });
  return { ok: true, deleted: true };
}

export async function clearSessionMemos(sessionId: string) {
  await expireRows(sessionId);
  const now = new Date();
  const rows = await db
    .update(sessionMemos)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(sessionMemos.sessionId, sessionId), isNull(sessionMemos.deletedAt)))
    .returning({ slot: sessionMemos.slot, label: sessionMemos.label });
  if (rows.length > 0) {
    await db.insert(sessionMemoEvents).values({
      sessionId,
      action: "clear",
      source: "mcp",
      metadata: { count: rows.length },
    });
  }
  return { ok: true, cleared: rows.length };
}

export async function listSessionMemoEvents(sessionId: string, limit = 200) {
  return db
    .select()
    .from(sessionMemoEvents)
    .where(eq(sessionMemoEvents.sessionId, sessionId))
    .orderBy(desc(sessionMemoEvents.createdAt))
    .limit(limit);
}
