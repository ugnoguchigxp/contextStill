import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { knowledgeItems } from "../../../src/db/schema.js";
import {
  auditEventTypes,
  recordAuditLogSafe,
} from "../../../src/modules/audit/audit-log.service.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";
import { canTransitionKnowledgeStatus } from "../../../src/modules/lifecycle/lifecycle.service.js";
import type { KnowledgeStatus } from "../../../src/shared/schemas/knowledge.schema.js";
import { normalizeKnowledgeScore } from "../../../src/lib/score-scale.js";

export type KnowledgeWriteInput = {
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  metadata?: Record<string, unknown>;
};

export type BulkKnowledgeStatusUpdateResult = {
  targetStatus: KnowledgeStatus;
  requestedIds: string[];
  updatedIds: string[];
  unchangedIds: string[];
  notFoundIds: string[];
  invalidTransitionIds: Array<{ id: string; fromStatus: KnowledgeStatus }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractSourceRefs(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const sourceRefs = Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : [];
  const candidateSourceRefs = Array.isArray(metadata.candidateSourceRefs)
    ? metadata.candidateSourceRefs
    : [];
  for (const value of [...sourceRefs, ...candidateSourceRefs]) {
    if (typeof value === "string" && value.trim()) refs.add(value.trim());
  }

  const sourceDocumentUri =
    typeof metadata.sourceDocumentUri === "string" ? metadata.sourceDocumentUri.trim() : "";
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri.trim() : "";
  const locator =
    typeof metadata.sourceFragmentLocator === "string" && metadata.sourceFragmentLocator.trim()
      ? metadata.sourceFragmentLocator.trim()
      : "full";
  const origin = sourceDocumentUri || sourceUri;
  if (origin) refs.add(`${origin}#${locator}`);
  return [...refs].slice(0, 8);
}

function extractSourceVibeMemoryIds(metadata: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const direct = Array.isArray(metadata.sourceVibeMemoryIds) ? metadata.sourceVibeMemoryIds : [];
  for (const value of direct) {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  }
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri.trim() : "";
  if (sourceUri.startsWith("vibe-memory://")) {
    const id = sourceUri.replace("vibe-memory://", "").trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

export async function listKnowledgeItems(params: {
  limit: number;
  status?: string;
  type?: string;
  query?: string;
}) {
  const conditions = [];
  if (params.status) {
    conditions.push(eq(knowledgeItems.status, params.status));
  }
  if (params.type) {
    conditions.push(eq(knowledgeItems.type, params.type));
  }
  if (params.query?.trim()) {
    const query = `%${params.query.trim()}%`;
    conditions.push(ilike(knowledgeItems.title, query));
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      metadata: knowledgeItems.metadata,
      createdAt: knowledgeItems.createdAt,
      updatedAt: knowledgeItems.updatedAt,
    })
    .from(knowledgeItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(knowledgeItems.updatedAt))
    .limit(params.limit);

  return rows.map((row) => ({
    ...row,
    metadata: asRecord(row.metadata),
    sourceRefs: extractSourceRefs(asRecord(row.metadata)),
    sourceVibeMemoryIds: extractSourceVibeMemoryIds(asRecord(row.metadata)),
    confidence: normalizeKnowledgeScore(row.confidence, 70),
    importance: normalizeKnowledgeScore(row.importance, 70),
  }));
}

async function tryEmbedKnowledge(input: KnowledgeWriteInput): Promise<number[] | undefined> {
  try {
    return await embedOne(`${input.title}\n${input.body}`, "passage");
  } catch {
    return undefined;
  }
}

export async function createKnowledgeItem(input: KnowledgeWriteInput) {
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const embedding = await tryEmbedKnowledge(input);
  const [inserted] = await db
    .insert(knowledgeItems)
    .values({
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
      body: input.body,
      confidence,
      importance,
      metadata: input.metadata ?? {},
      embedding,
    })
    .returning({ id: knowledgeItems.id });
  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeCreated,
    actor: "user",
    payload: {
      knowledgeId: inserted.id,
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
    },
  });
  return inserted;
}

export async function updateKnowledgeItem(id: string, input: KnowledgeWriteInput) {
  const [existing] = await db
    .select({
      id: knowledgeItems.id,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      type: knowledgeItems.type,
      title: knowledgeItems.title,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .limit(1);
  if (!existing) return null;

  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const embedding = await tryEmbedKnowledge(input);
  const [updated] = await db
    .update(knowledgeItems)
    .set({
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
      body: input.body,
      confidence,
      importance,
      metadata: input.metadata ?? {},
      embedding,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeItems.id, existing.id))
    .returning({ id: knowledgeItems.id });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeUpdated,
    actor: "user",
    payload: {
      knowledgeId: updated.id,
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
      previousStatus: existing.status,
    },
  });
  if (existing.status !== input.status) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeStatusChanged,
      actor: "user",
      payload: {
        knowledgeId: updated.id,
        fromStatus: existing.status,
        toStatus: input.status,
      },
    });
  }
  return updated ?? null;
}

export async function deleteKnowledgeItem(id: string) {
  const [deleted] = await db
    .delete(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .returning({ id: knowledgeItems.id });
  if (deleted) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeDeleted,
      actor: "user",
      payload: {
        knowledgeId: deleted.id,
      },
    });
  }
  return deleted ?? null;
}

export async function bulkUpdateKnowledgeStatus(params: {
  ids: string[];
  status: KnowledgeStatus;
}): Promise<BulkKnowledgeStatusUpdateResult> {
  const requestedIds = [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
  const result: BulkKnowledgeStatusUpdateResult = {
    targetStatus: params.status,
    requestedIds,
    updatedIds: [],
    unchangedIds: [],
    notFoundIds: [],
    invalidTransitionIds: [],
  };
  if (requestedIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
      status: knowledgeItems.status,
    })
    .from(knowledgeItems)
    .where(inArray(knowledgeItems.id, requestedIds));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const id of requestedIds) {
    const row = rowById.get(id);
    if (!row) {
      result.notFoundIds.push(id);
      continue;
    }
    const fromStatus = row.status as KnowledgeStatus;
    if (fromStatus === params.status) {
      result.unchangedIds.push(id);
      continue;
    }
    if (!canTransitionKnowledgeStatus(fromStatus, params.status)) {
      result.invalidTransitionIds.push({ id, fromStatus });
      continue;
    }
    result.updatedIds.push(id);
  }

  if (result.updatedIds.length > 0) {
    await db
      .update(knowledgeItems)
      .set({
        status: params.status,
        updatedAt: new Date(),
      })
      .where(inArray(knowledgeItems.id, result.updatedIds));
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeStatusChanged,
      actor: "user",
      payload: {
        targetStatus: params.status,
        updatedIds: result.updatedIds,
        unchangedIds: result.unchangedIds,
        notFoundIds: result.notFoundIds,
        invalidTransitionIds: result.invalidTransitionIds,
      },
    });
  }

  return result;
}
