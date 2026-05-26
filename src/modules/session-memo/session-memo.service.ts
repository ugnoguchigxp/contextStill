import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../../db/client.js";
import { sessionMemoEvents, sessionMemos } from "../../db/schema.js";
import { sessionMemoSlotLimit } from "../../shared/schemas/session-memo.schema.js";
import {
  getCompileRunById,
  getLatestCompileRunForSession,
  listCompileRunOutputsByIds,
} from "../context-compiler/context-compiler.repository.js";

type PutInput = {
  sessionId: string;
  slot?: number;
  kind?: string;
  title?: string;
  score?: number;
  label?: string;
  body: string;
  metadata?: Record<string, unknown>;
  expiresAt?: string;
  source?: "mcp" | "ui" | "system" | "import";
};

const compileEvalKind = "compile_eval";
const compileResultKind = "compile_result";
const defaultMemoKind = "scratch";

function normalizeLabel(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeCompileEvalLabel(value: string | null): string | null {
  if (!value) return null;
  return value.toLowerCase() === compileEvalKind ? null : value;
}

function normalizeKind(value?: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultMemoKind;
}

function normalizeTitle(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function asMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deriveCompileOutputKind(
  outputMarkdown: string | null,
): "narrative" | "no_content" | "unknown" {
  if (!outputMarkdown) return "unknown";
  return outputMarkdown.trim() === "No Content" ? "no_content" : "narrative";
}

function getContextCompileRunIdFromMetadata(metadata: Record<string, unknown>): string | null {
  const runId = metadata.contextCompileRunId;
  return typeof runId === "string" && runId.trim().length > 0 ? runId.trim() : null;
}

function parseCompileEvalOrdinal(label: string, runId: string): number | null {
  const prefix = `${compileEvalKind}:${runId}:`;
  if (!label.startsWith(prefix)) return null;
  const rawOrdinal = Number(label.slice(prefix.length));
  if (!Number.isInteger(rawOrdinal) || rawOrdinal < 1) return null;
  return rawOrdinal;
}

async function nextCompileEvalOrdinalIn(
  tx: NodePgDatabase<typeof import("../../db/schema.js")> | typeof db,
  sessionId: string,
  runId: string,
): Promise<number> {
  const labels = await tx
    .select({ label: sessionMemos.label })
    .from(sessionMemos)
    .where(
      and(
        eq(sessionMemos.sessionId, sessionId),
        eq(sessionMemos.kind, compileEvalKind),
        isNull(sessionMemos.deletedAt),
      ),
    );
  let maxOrdinal = 0;
  for (const row of labels) {
    const label = typeof row.label === "string" ? row.label : "";
    const ordinal = parseCompileEvalOrdinal(label, runId);
    if (ordinal !== null && ordinal > maxOrdinal) maxOrdinal = ordinal;
  }
  return maxOrdinal + 1;
}

async function resolveCompileEvalLabel(params: {
  tx: NodePgDatabase<typeof import("../../db/schema.js")> | typeof db;
  sessionId: string;
  explicitLabel: string | null;
  metadata: Record<string, unknown>;
}): Promise<string> {
  if (params.explicitLabel) return params.explicitLabel;
  const runId = getContextCompileRunIdFromMetadata(params.metadata) ?? "unresolved";
  const ordinal = await nextCompileEvalOrdinalIn(params.tx, params.sessionId, runId);
  return `${compileEvalKind}:${runId}:${ordinal}`;
}

async function enrichMetadataForCompileEval(params: {
  sessionId: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const explicitRunId = getContextCompileRunIdFromMetadata(params.metadata);
  if (explicitRunId) {
    const linkedRun = await getCompileRunById(explicitRunId);
    if (!linkedRun || linkedRun.sessionId !== params.sessionId) {
      return {
        ...params.metadata,
        linkStatus: "unresolved",
        unresolvedReason: "context_compile_run_not_found",
        contextCompileOutputKind: "unknown",
      };
    }
    return {
      ...params.metadata,
      contextCompileRunId: linkedRun.id,
      contextCompileRunCreatedAt: linkedRun.createdAt.toISOString(),
      linkStatus: "linked",
      contextCompileOutputKind: deriveCompileOutputKind(linkedRun.outputMarkdown),
    };
  }

  const linkedRun = await getLatestCompileRunForSession({
    sessionId: params.sessionId,
    createdBefore: params.createdAt,
  });
  if (!linkedRun) {
    return {
      ...params.metadata,
      linkStatus: "unresolved",
      unresolvedReason: "no_recent_context_compile_run",
      contextCompileOutputKind: "unknown",
    };
  }

  const linkedRunDetail = await getCompileRunById(linkedRun.id);

  return {
    ...params.metadata,
    contextCompileRunId: linkedRun.id,
    contextCompileRunCreatedAt: linkedRun.createdAt.toISOString(),
    linkStatus: "linked",
    contextCompileOutputKind: deriveCompileOutputKind(linkedRunDetail?.outputMarkdown ?? null),
  };
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
    .returning({ slot: sessionMemos.slot, kind: sessionMemos.kind, label: sessionMemos.label });
  if (expired.length === 0) return;
  await db.insert(sessionMemoEvents).values(
    expired.map((row) => ({
      sessionId,
      slot: row.slot,
      kind: row.kind,
      label: row.label,
      action: "expire",
      source: source ?? "mcp",
      metadata: {},
    })),
  );
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
  const kind = normalizeKind(input.kind);
  const label =
    kind === compileEvalKind
      ? normalizeCompileEvalLabel(normalizeLabel(input.label))
      : normalizeLabel(input.label);
  const title = normalizeTitle(input.title);
  const now = new Date();
  const source = input.source ?? "mcp";
  let effectiveMetadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    kind,
  };
  if (title !== undefined) effectiveMetadata.title = title;
  if (kind === compileEvalKind) {
    effectiveMetadata = await enrichMetadataForCompileEval({
      sessionId: input.sessionId,
      createdAt: now,
      metadata: effectiveMetadata,
    });
  }
  if (input.score !== undefined) {
    effectiveMetadata.score = input.score;
  }
  let effectiveLabel = label;
  if (kind === compileEvalKind) {
    effectiveLabel = await resolveCompileEvalLabel({
      tx,
      sessionId: input.sessionId,
      explicitLabel: label,
      metadata: effectiveMetadata,
    });
  }
  if (kind === compileResultKind && !effectiveLabel) {
    const runId = getContextCompileRunIdFromMetadata(effectiveMetadata);
    if (runId) effectiveLabel = `${compileResultKind}:${runId}`;
  }

  let rowByLabel:
    | { id: string; slot: number; label: string | null; body: string; metadata: unknown }
    | undefined;
  if (effectiveLabel) {
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
          sql`lower(${sessionMemos.label}) = lower(${effectiveLabel})`,
        ),
      )
      .limit(1);
    rowByLabel = rows[0];
  }

  let slot: number | undefined;
  if (slot === undefined && rowByLabel) slot = rowByLabel.slot;
  if (slot === undefined) {
    const emptySlot = await nextEmptySlotIn(tx, input.sessionId);
    if (emptySlot === null) throw new Error("MEMO_FULL");
    slot = emptySlot;
  }
  const resolvedSlot = slot;

  const [saved] = await tx
    .insert(sessionMemos)
    .values({
      sessionId: input.sessionId,
      slot: resolvedSlot,
      kind,
      label: effectiveLabel,
      body: input.body,
      metadata: effectiveMetadata,
      source,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [sessionMemos.sessionId, sessionMemos.slot],
      targetWhere: sql`${sessionMemos.deletedAt} is null`,
      set: {
        kind,
        label: effectiveLabel,
        body: input.body,
        metadata: effectiveMetadata,
        source,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        updatedAt: now,
        deletedAt: null,
      },
    })
    .returning();

  await tx.insert(sessionMemoEvents).values({
    sessionId: input.sessionId,
    slot: saved.slot,
    kind: saved.kind,
    label: saved.label,
    action: "put",
    source,
    bodyPreview: input.body.slice(0, 200),
    metadata: effectiveMetadata,
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

type SessionMemoRow = typeof sessionMemos.$inferSelect;

type LinkedCompileOutput = {
  contextCompileRunId: string;
  linkedOutputMarkdown: string | null;
  linkedOutputSource: "context_compile_runs.pack_snapshot";
  linkedOutputAvailable: boolean;
};

async function resolveLinkedCompileOutputs(
  rows: SessionMemoRow[],
): Promise<Map<string, LinkedCompileOutput>> {
  const runIds = rows
    .filter((row) => row.kind === compileResultKind)
    .map((row) => getContextCompileRunIdFromMetadata(asMetadataRecord(row.metadata)))
    .filter((value): value is string => Boolean(value));
  if (runIds.length === 0) return new Map();
  const runMap = await listCompileRunOutputsByIds(runIds);
  const outputByMemoId = new Map<string, LinkedCompileOutput>();
  for (const row of rows) {
    if (row.kind !== compileResultKind) continue;
    const runId = getContextCompileRunIdFromMetadata(asMetadataRecord(row.metadata));
    if (!runId) continue;
    const compileRun = runMap.get(runId);
    outputByMemoId.set(row.id, {
      contextCompileRunId: runId,
      linkedOutputMarkdown: compileRun?.outputMarkdown ?? null,
      linkedOutputSource: "context_compile_runs.pack_snapshot",
      linkedOutputAvailable: Boolean(compileRun?.outputMarkdown),
    });
  }
  return outputByMemoId;
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
  const linkedOutputByMemoId = await resolveLinkedCompileOutputs(rows);
  const items = rows.map((row) => ({
    metadata: asMetadataRecord(row.metadata),
    linkedOutput: linkedOutputByMemoId.get(row.id) ?? null,
    slot: row.slot,
    kind: row.kind,
    label: row.label,
    preview: row.body.slice(0, previewChars),
    previewChars,
    bodyLength: row.body.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  }));
  const normalizedItems = items.map((item) => ({
    slot: item.slot,
    kind: item.kind,
    label: item.label,
    title: typeof item.metadata.title === "string" ? item.metadata.title : null,
    score: typeof item.metadata.score === "number" ? item.metadata.score : null,
    preview: item.preview,
    previewChars: item.previewChars,
    bodyLength: item.bodyLength,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    metadata: item.metadata,
    expiresAt: item.expiresAt,
    linkedOutputMarkdown: item.linkedOutput?.linkedOutputMarkdown ?? null,
    linkedOutputAvailable: item.linkedOutput?.linkedOutputAvailable ?? false,
    linkedOutputSource: item.linkedOutput?.linkedOutputSource ?? null,
    contextCompileRunId: item.linkedOutput?.contextCompileRunId ?? null,
  }));
  if (!input.includeEmpty) return normalizedItems;
  const map = new Map(normalizedItems.map((item) => [item.slot, item]));
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
  const memo = rows[0];
  if (!memo) return null;
  const linkedOutputByMemoId = await resolveLinkedCompileOutputs([memo]);
  const linkedOutput = linkedOutputByMemoId.get(memo.id) ?? null;
  return {
    ...memo,
    linkedOutputMarkdown: linkedOutput?.linkedOutputMarkdown ?? null,
    linkedOutputAvailable: linkedOutput?.linkedOutputAvailable ?? false,
    linkedOutputSource: linkedOutput?.linkedOutputSource ?? null,
    contextCompileRunId: linkedOutput?.contextCompileRunId ?? null,
  };
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
    kind: row.kind,
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
      kind: defaultMemoKind,
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

export async function listSessionMemoSessions(limit = 200, includeCompileOnly = false) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 200;
  const now = new Date();
  const rows = await db
    .select({
      sessionId: sessionMemos.sessionId,
      memoCount: sql<number>`count(*)::int`,
      nonCompileResultMemoCount: sql<number>`count(*) filter (where ${sessionMemos.kind} <> ${compileResultKind})::int`,
      lastUpdatedAt: sql<Date>`max(${sessionMemos.updatedAt})`,
    })
    .from(sessionMemos)
    .where(
      and(
        isNull(sessionMemos.deletedAt),
        sql`(${sessionMemos.expiresAt} is null or ${sessionMemos.expiresAt} > ${now})`,
      ),
    )
    .groupBy(sessionMemos.sessionId)
    .having(
      includeCompileOnly
        ? undefined
        : sql`count(*) filter (where ${sessionMemos.kind} <> ${compileResultKind}) > 0`,
    )
    .orderBy(desc(sql`max(${sessionMemos.updatedAt})`))
    .limit(safeLimit);

  return rows.map((row) => ({
    sessionId: row.sessionId,
    memoCount: Number(row.memoCount ?? 0),
    nonCompileResultMemoCount: Number(row.nonCompileResultMemoCount ?? 0),
    compileResultMemoCount: Math.max(
      0,
      Number(row.memoCount ?? 0) - Number(row.nonCompileResultMemoCount ?? 0),
    ),
    compileOnly: Number(row.nonCompileResultMemoCount ?? 0) === 0,
    lastUpdatedAt: row.lastUpdatedAt?.toISOString?.() ?? new Date(0).toISOString(),
  }));
}
