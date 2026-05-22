import { type SQL, and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { contextPackItems, knowledgeItems } from "../../../src/db/schema.js";
import { normalizeKnowledgeScore } from "../../../src/lib/score-scale.js";
import {
  auditEventTypes,
  recordAuditLogSafe,
} from "../../../src/modules/audit/audit-log.service.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";
import {
  mergeApplicabilityInput,
  normalizeKnowledgeApplicability,
} from "../../../src/modules/knowledge/applicability.service.js";
import {
  type KnowledgeTagKind,
  type KnowledgeTagStatus,
  listKnowledgeTagDefinitions,
} from "../../../src/modules/knowledge/knowledge-tags.repository.js";
import {
  computeDecayFactor,
  computeDynamicScore,
} from "../../../src/modules/knowledge/knowledge-value.service.js";
import { canTransitionKnowledgeStatus } from "../../../src/modules/lifecycle/lifecycle.service.js";
import type { KnowledgeStatus } from "../../../src/shared/schemas/knowledge.schema.js";

export type KnowledgeCreateInput = {
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown>;
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
  metadata?: Record<string, unknown>;
};

export type KnowledgeUpdateInput = {
  type?: string;
  status?: string;
  scope?: string;
  title?: string;
  body?: string;
  confidence?: number;
  importance?: number;
  appliesTo?: Record<string, unknown>;
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
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

export type BulkKnowledgeStatusSelection = {
  status?: KnowledgeStatus;
  type?: string;
  query?: string;
};

export type BulkKnowledgeStatusUpdateParams =
  | {
      ids: string[];
      status: KnowledgeStatus;
    }
  | {
      selection: BulkKnowledgeStatusSelection;
      status: KnowledgeStatus;
    };

export type KnowledgeFeedbackDirection = "up" | "down";

export type KnowledgeFeedbackResult = {
  id: string;
  direction: KnowledgeFeedbackDirection;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  lastVerifiedAt: Date | null;
};

export type KnowledgeTagDefinitionApi = {
  id: string;
  kind: KnowledgeTagKind;
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  status: KnowledgeTagStatus;
  sortOrder: number;
};

export type KnowledgeListItem = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceRefs: string[];
  sourceVibeMemoryIds: string[];
  compileSelectCount: number;
  lastCompiledAt: Date | null;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  decayFactor: number;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type KnowledgeListParams = {
  limit: number;
  page?: number;
  status?: string;
  type?: string;
  query?: string;
  sortBy?: KnowledgeListSortBy;
  sortDir?: KnowledgeListSortDir;
};

export type KnowledgeListSortBy =
  | "title"
  | "type"
  | "status"
  | "scope"
  | "qualityScore"
  | "updatedAt";

export type KnowledgeListSortDir = "asc" | "desc";

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

function isMissingKnowledgeLifecycleColumnsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = (error as { code?: unknown })?.code;
  if (code === "42703") return true;
  return (
    normalized.includes("compile_select_count") ||
    normalized.includes("last_compiled_at") ||
    normalized.includes("agentic_accept_count") ||
    normalized.includes("explicit_upvote_count") ||
    normalized.includes("explicit_downvote_count") ||
    normalized.includes("dynamic_score")
  );
}

function buildKnowledgeListWhere(params: Pick<KnowledgeListParams, "status" | "type" | "query">) {
  const conditions: SQL[] = [];
  if (params.status) {
    conditions.push(eq(knowledgeItems.status, params.status));
  }
  if (params.type) {
    conditions.push(eq(knowledgeItems.type, params.type));
  }
  if (params.query?.trim()) {
    const query = `%${params.query.trim()}%`;
    const searchCondition = or(
      ilike(knowledgeItems.title, query),
      ilike(knowledgeItems.body, query),
      sql`${knowledgeItems.appliesTo} ->> 'technologies' ilike ${query}`,
      sql`${knowledgeItems.appliesTo} ->> 'domains' ilike ${query}`,
      sql`${knowledgeItems.appliesTo} ->> 'changeTypes' ilike ${query}`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function countKnowledgeItems(
  params: Pick<KnowledgeListParams, "status" | "type" | "query">,
): Promise<number> {
  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(knowledgeItems)
    .where(buildKnowledgeListWhere(params));

  return Math.max(0, Number(rows[0]?.count ?? 0));
}

export async function listKnowledgeItems(
  params: KnowledgeListParams,
): Promise<KnowledgeListItem[]> {
  const where = buildKnowledgeListWhere(params);
  const offset = Math.max(0, (params.page ?? 1) - 1) * params.limit;
  const orderBy = buildKnowledgeListOrderBy(params);
  const commonSelect = {
    id: knowledgeItems.id,
    type: knowledgeItems.type,
    status: knowledgeItems.status,
    scope: knowledgeItems.scope,
    title: knowledgeItems.title,
    body: knowledgeItems.body,
    confidence: knowledgeItems.confidence,
    importance: knowledgeItems.importance,
    appliesTo: knowledgeItems.appliesTo,
    metadata: knowledgeItems.metadata,
    lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    createdAt: knowledgeItems.createdAt,
    updatedAt: knowledgeItems.updatedAt,
  } as const;

  let rows:
    | Array<
        (typeof commonSelect extends infer T ? T : never) & {
          compileSelectCount?: number;
          lastCompiledAt?: Date | null;
          agenticAcceptCount?: number;
          explicitUpvoteCount?: number;
          explicitDownvoteCount?: number;
          dynamicScore?: number;
        }
      >
    | Array<Record<string, unknown>>;

  try {
    rows = await db
      .select({
        ...commonSelect,
        compileSelectCount: knowledgeItems.compileSelectCount,
        lastCompiledAt: knowledgeItems.lastCompiledAt,
        agenticAcceptCount: knowledgeItems.agenticAcceptCount,
        explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
        explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
        dynamicScore: knowledgeItems.dynamicScore,
      })
      .from(knowledgeItems)
      .where(where)
      .orderBy(...orderBy)
      .limit(params.limit)
      .offset(offset);
  } catch (error) {
    if (!isMissingKnowledgeLifecycleColumnsError(error)) {
      throw error;
    }
    rows = await db
      .select(commonSelect)
      .from(knowledgeItems)
      .where(where)
      .orderBy(...orderBy)
      .limit(params.limit)
      .offset(offset);
  }

  return rows.map((row: Record<string, unknown>): KnowledgeListItem => {
    const normalizedType = row.type === "procedure" ? "procedure" : "rule";
    const normalizedScope = row.scope === "global" ? "global" : "repo";
    const decayFactor = computeDecayFactor({
      type: normalizedType,
      scope: normalizedScope,
      lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
      updatedAt: row.updatedAt as Date,
    });
    return {
      id: String(row.id),
      type: String(row.type ?? "rule"),
      status: String(row.status ?? "draft"),
      scope: String(row.scope ?? "repo"),
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      appliesTo: asRecord(row.appliesTo),
      metadata: asRecord(row.metadata),
      sourceRefs: extractSourceRefs(asRecord(row.metadata)),
      sourceVibeMemoryIds: extractSourceVibeMemoryIds(asRecord(row.metadata)),
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      compileSelectCount: Math.max(0, Number(row.compileSelectCount ?? 0)),
      agenticAcceptCount: Math.max(0, Number(row.agenticAcceptCount ?? 0)),
      explicitUpvoteCount: Math.max(0, Number(row.explicitUpvoteCount ?? 0)),
      explicitDownvoteCount: Math.max(0, Number(row.explicitDownvoteCount ?? 0)),
      dynamicScore: Math.max(0, Number(row.dynamicScore ?? 0)),
      lastCompiledAt: (row.lastCompiledAt as Date | null) ?? null,
      decayFactor,
      lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    };
  });
}

function buildKnowledgeListOrderBy(params: Pick<KnowledgeListParams, "sortBy" | "sortDir">) {
  const sortBy = params.sortBy ?? "updatedAt";
  const direction = params.sortDir === "asc" ? asc : desc;
  const qualityScore = sql<number>`(${knowledgeItems.importance} * 0.6 + ${knowledgeItems.confidence} * 0.4)`;
  const sortableColumns = {
    title: sql`lower(${knowledgeItems.title})`,
    type: sql`${knowledgeItems.type}`,
    status: sql`${knowledgeItems.status}`,
    scope: sql`${knowledgeItems.scope}`,
    qualityScore,
    updatedAt: sql`${knowledgeItems.updatedAt}`,
  } satisfies Record<KnowledgeListSortBy, SQL>;
  const selected = sortableColumns[sortBy] ?? sortableColumns.updatedAt;
  return [direction(selected), desc(knowledgeItems.updatedAt), desc(knowledgeItems.id)];
}

async function tryEmbedKnowledge(input: { title: string; body: string }): Promise<
  number[] | undefined
> {
  try {
    return await embedOne(`${input.title}\n${input.body}`, "passage");
  } catch {
    return undefined;
  }
}

type KnowledgeApplicabilityInput = Pick<
  KnowledgeCreateInput,
  "appliesTo" | "general" | "technologies" | "changeTypes" | "domains" | "repoPath" | "repoKey"
>;

const knownApplicabilityKeys = new Set([
  "general",
  "technologies",
  "changeTypes",
  "domains",
  "repoPath",
  "repoKey",
]);

async function buildNormalizedApplicability(input: KnowledgeApplicabilityInput) {
  const mergedInput = mergeApplicabilityInput({
    appliesTo: input.appliesTo,
    general: input.general,
    technologies: input.technologies,
    changeTypes: input.changeTypes,
    domains: input.domains,
    repoPath: input.repoPath,
    repoKey: input.repoKey,
  });
  return normalizeKnowledgeApplicability(mergedInput);
}

function pickUnknownApplicabilityKeys(value: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!knownApplicabilityKeys.has(key)) {
      extras[key] = entry;
    }
  }
  return extras;
}

function mergeNormalizedApplicability(params: {
  existingAppliesTo?: unknown;
  inputAppliesTo?: unknown;
  normalizedAppliesTo: Record<string, unknown>;
}): Record<string, unknown> {
  const existing = asRecord(params.existingAppliesTo);
  const incoming = asRecord(params.inputAppliesTo);
  return {
    ...pickUnknownApplicabilityKeys(existing),
    ...pickUnknownApplicabilityKeys(incoming),
    ...params.normalizedAppliesTo,
  };
}

function mergeApplicabilityMetadata(
  metadata: Record<string, unknown>,
  normalized: Awaited<ReturnType<typeof buildNormalizedApplicability>>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  if (normalized.warnings.length > 0) {
    next.tagNormalizationWarnings = normalized.warnings;
  }
  if (normalized.unknownTagCandidates.length > 0) {
    next.unknownTagCandidates = normalized.unknownTagCandidates;
  }
  return next;
}

export async function createKnowledgeItem(input: KnowledgeCreateInput) {
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const normalizedApplicability = await buildNormalizedApplicability(input);
  const metadata = mergeApplicabilityMetadata(input.metadata ?? {}, normalizedApplicability);
  const embedding = await tryEmbedKnowledge(input);
  const appliesTo = mergeNormalizedApplicability({
    existingAppliesTo: undefined,
    inputAppliesTo: input.appliesTo,
    normalizedAppliesTo: normalizedApplicability.appliesTo,
  });
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
      appliesTo,
      metadata,
      embedding,
      lastVerifiedAt: new Date(),
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

export async function updateKnowledgeItem(id: string, input: KnowledgeUpdateInput) {
  const [existing] = await db
    .select({
      id: knowledgeItems.id,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      type: knowledgeItems.type,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .limit(1);
  if (!existing) return null;

  const nextType = input.type ?? existing.type;
  const nextStatus = input.status ?? existing.status;
  const nextScope = input.scope ?? existing.scope;
  const nextTitle = input.title ?? existing.title;
  const nextBody = input.body ?? existing.body;
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const nextConfidence =
    input.confidence === undefined ? normalizeKnowledgeScore(existing.confidence, 70) : confidence;
  const nextImportance =
    input.importance === undefined ? normalizeKnowledgeScore(existing.importance, 70) : importance;
  const existingAppliesTo = asRecord(existing.appliesTo);
  const hasApplicabilityPatch =
    input.appliesTo !== undefined ||
    input.general !== undefined ||
    input.technologies !== undefined ||
    input.changeTypes !== undefined ||
    input.domains !== undefined ||
    input.repoPath !== undefined ||
    input.repoKey !== undefined;

  const normalizedApplicability = hasApplicabilityPatch
    ? await buildNormalizedApplicability({
        appliesTo:
          input.appliesTo === undefined
            ? existingAppliesTo
            : {
                ...existingAppliesTo,
                ...asRecord(input.appliesTo),
              },
        general: input.general,
        technologies: input.technologies,
        changeTypes: input.changeTypes,
        domains: input.domains,
        repoPath: input.repoPath,
        repoKey: input.repoKey,
      })
    : null;
  const appliesTo =
    normalizedApplicability === null
      ? existingAppliesTo
      : mergeNormalizedApplicability({
          existingAppliesTo,
          inputAppliesTo: input.appliesTo,
          normalizedAppliesTo: normalizedApplicability.appliesTo,
        });
  const metadataBase = {
    ...asRecord(existing.metadata),
    ...(input.metadata ?? {}),
  };
  const metadata =
    normalizedApplicability === null
      ? metadataBase
      : mergeApplicabilityMetadata(metadataBase, normalizedApplicability);
  const titleChanged = nextTitle !== existing.title;
  const bodyChanged = nextBody !== existing.body;
  const promotedToActive = existing.status === "draft" && nextStatus === "active";
  const shouldUpdateLastVerifiedAt = titleChanged || bodyChanged || promotedToActive;
  const embedding =
    titleChanged || bodyChanged
      ? await tryEmbedKnowledge({ title: nextTitle, body: nextBody })
      : undefined;
  const now = new Date();
  const [updated] = await db
    .update(knowledgeItems)
    .set({
      type: nextType,
      status: nextStatus,
      scope: nextScope,
      title: nextTitle,
      body: nextBody,
      confidence: nextConfidence,
      importance: nextImportance,
      appliesTo,
      metadata,
      embedding,
      updatedAt: now,
      lastVerifiedAt: shouldUpdateLastVerifiedAt ? now : existing.lastVerifiedAt,
    })
    .where(eq(knowledgeItems.id, existing.id))
    .returning({ id: knowledgeItems.id });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeUpdated,
    actor: "user",
    payload: {
      knowledgeId: updated.id,
      type: nextType,
      status: nextStatus,
      scope: nextScope,
      title: nextTitle,
      previousStatus: existing.status,
    },
  });
  if (existing.status !== nextStatus) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeStatusChanged,
      actor: "user",
      payload: {
        knowledgeId: updated.id,
        fromStatus: existing.status,
        toStatus: nextStatus,
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

async function resolveBulkKnowledgeStatusIds(
  params: BulkKnowledgeStatusUpdateParams,
): Promise<string[]> {
  if ("ids" in params) {
    return [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
    })
    .from(knowledgeItems)
    .where(buildKnowledgeListWhere(params.selection));
  return rows.map((row) => row.id);
}

export async function bulkUpdateKnowledgeStatus(
  params: BulkKnowledgeStatusUpdateParams,
): Promise<BulkKnowledgeStatusUpdateResult> {
  const requestedIds = await resolveBulkKnowledgeStatusIds(params);
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
    const now = new Date();
    const promoteIds = result.updatedIds.filter((id) => {
      const row = rowById.get(id);
      return row?.status === "draft" && params.status === "active";
    });
    await db
      .update(knowledgeItems)
      .set({
        status: params.status,
        updatedAt: now,
      })
      .where(inArray(knowledgeItems.id, result.updatedIds));
    if (promoteIds.length > 0) {
      await db
        .update(knowledgeItems)
        .set({
          lastVerifiedAt: now,
        })
        .where(inArray(knowledgeItems.id, promoteIds));
    }
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

async function loadRecentSelectionCount30d(knowledgeId: string): Promise<number> {
  const result = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(contextPackItems)
    .where(
      and(
        eq(contextPackItems.itemId, knowledgeId),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        sql`${contextPackItems.createdAt} >= now() - (30 * interval '1 day')`,
      ),
    );

  return Math.max(0, Number(result[0]?.count ?? 0));
}

export async function recordKnowledgeFeedback(params: {
  id: string;
  direction: KnowledgeFeedbackDirection;
  reason?: string;
}): Promise<KnowledgeFeedbackResult | null> {
  const [row] = await db
    .select({
      id: knowledgeItems.id,
      compileSelectCount: knowledgeItems.compileSelectCount,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, params.id))
    .limit(1);
  if (!row) return null;

  const recentSelectCount30d = await loadRecentSelectionCount30d(row.id);
  const nextUpvoteCount =
    Math.max(0, Number(row.explicitUpvoteCount ?? 0)) + (params.direction === "up" ? 1 : 0);
  const nextDownvoteCount =
    Math.max(0, Number(row.explicitDownvoteCount ?? 0)) + (params.direction === "down" ? 1 : 0);
  const dynamicScore = computeDynamicScore({
    compileSelectCount: Math.max(0, Number(row.compileSelectCount ?? 0)),
    recentSelectCount30d,
    agenticAcceptCount: Math.max(0, Number(row.agenticAcceptCount ?? 0)),
    explicitUpvoteCount: nextUpvoteCount,
    explicitDownvoteCount: nextDownvoteCount,
  });
  const now = new Date();
  const lastVerifiedAt = params.direction === "up" ? now : row.lastVerifiedAt;

  const [updated] = await db
    .update(knowledgeItems)
    .set({
      explicitUpvoteCount: nextUpvoteCount,
      explicitDownvoteCount: nextDownvoteCount,
      dynamicScore,
      lastVerifiedAt,
    })
    .where(eq(knowledgeItems.id, params.id))
    .returning({
      id: knowledgeItems.id,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      dynamicScore: knowledgeItems.dynamicScore,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeFeedbackRecorded,
    actor: "user",
    payload: {
      knowledgeId: updated.id,
      direction: params.direction,
      reason: params.reason?.trim() || undefined,
      dynamicScore: updated.dynamicScore,
      explicitUpvoteCount: updated.explicitUpvoteCount,
      explicitDownvoteCount: updated.explicitDownvoteCount,
    },
  });

  return {
    id: updated.id,
    direction: params.direction,
    explicitUpvoteCount: updated.explicitUpvoteCount,
    explicitDownvoteCount: updated.explicitDownvoteCount,
    dynamicScore: updated.dynamicScore,
    lastVerifiedAt: updated.lastVerifiedAt,
  };
}

export async function listKnowledgeTagDefinitionsForApi(params?: {
  kind?: KnowledgeTagKind;
  status?: KnowledgeTagStatus;
}): Promise<KnowledgeTagDefinitionApi[]> {
  const definitions = await listKnowledgeTagDefinitions({
    kinds: params?.kind ? [params.kind] : undefined,
    statuses: params?.status ? [params.status] : undefined,
  });
  return definitions.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    slug: definition.slug,
    label: definition.label,
    description: definition.description,
    aliases: definition.aliases,
    status: definition.status,
    sortOrder: definition.sortOrder,
  }));
}
