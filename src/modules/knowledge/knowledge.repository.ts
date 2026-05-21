import { type SQL, and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeItems, knowledgeSourceLinks, sourceFragments, sources } from "../../db/schema.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type {
  KnowledgeItem,
  KnowledgeApplicabilityInput,
  KnowledgeSearchInput,
  KnowledgeStatus,
} from "../../shared/schemas/knowledge.schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { normalizeRepoKey, normalizeRepoPath } from "../context-compiler/query-context.js";
import { parseApplicabilityFromRecord } from "./applicability.service.js";
import { computeDecayFactor } from "./knowledge-value.service.js";

export type KnowledgeSearchResult = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  score: number;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceRefs: string[];
  hasSourceLinks: boolean;
  dynamicScore: number;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  decayFactor: number;
  applicabilityScore: number;
  applicabilityMatches: {
    technologies: string[];
    changeTypes: string[];
    general: boolean;
  };
};

export type UpsertKnowledgeFromSourceParams = {
  sourceUri: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  scope: KnowledgeItem["scope"];
  title: string;
  body: string;
  confidence?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  appliesTo?: Record<string, unknown> | KnowledgeApplicabilityInput;
};

export type KnowledgeSearchOptions = {
  repoPath?: string;
  repoKey?: string;
  allowGlobalScope?: boolean;
  types?: KnowledgeItem["type"][];
  scopeMatchMode?: "primary" | "legacy";
  technologies?: string[];
  changeTypes?: string[];
  includeGeneral?: boolean;
};

type KnowledgeSearchQueryInput = Omit<KnowledgeSearchInput, "includeGeneral"> & {
  includeGeneral?: boolean;
};

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizedImportanceExpr() {
  return sql<number>`
    CASE
      WHEN ${knowledgeItems.importance} >= 0 AND ${knowledgeItems.importance} <= 1
        THEN ${knowledgeItems.importance} * 100
      ELSE ${knowledgeItems.importance}
    END
  `;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toLowerSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9./-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueLowerSlugs(values: string[] | undefined): string[] {
  const deduped = new Set<string>();
  for (const raw of values ?? []) {
    const normalized = toLowerSlug(raw);
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

type ApplicabilityQuery = {
  technologies: string[];
  changeTypes: string[];
  includeGeneral: boolean;
};

function buildApplicabilityQuery(
  input: Pick<KnowledgeSearchQueryInput, "technologies" | "changeTypes" | "includeGeneral">,
  options: Pick<KnowledgeSearchOptions, "technologies" | "changeTypes" | "includeGeneral">,
): ApplicabilityQuery {
  const technologies = uniqueLowerSlugs(options.technologies ?? input.technologies);
  const changeTypes = uniqueLowerSlugs(options.changeTypes ?? input.changeTypes);
  const includeGeneral = options.includeGeneral ?? input.includeGeneral ?? true;
  return {
    technologies,
    changeTypes,
    includeGeneral,
  };
}

function hasApplicabilityQuery(query: ApplicabilityQuery): boolean {
  return query.technologies.length > 0 || query.changeTypes.length > 0;
}

function intersect(queryValues: string[], sourceValues: string[]): string[] {
  if (queryValues.length === 0 || sourceValues.length === 0) return [];
  const sourceSet = new Set(sourceValues.map(toLowerSlug));
  const matched: string[] = [];
  for (const value of queryValues) {
    if (sourceSet.has(toLowerSlug(value))) matched.push(value);
  }
  return matched;
}

function computeApplicability(appliesTo: Record<string, unknown>, query: ApplicabilityQuery) {
  const sourceTechnologies = toStringArray(appliesTo.technologies);
  const sourceChangeTypes = toStringArray(appliesTo.changeTypes);
  const technologies = intersect(query.technologies, sourceTechnologies);
  const changeTypes = intersect(query.changeTypes, sourceChangeTypes);
  const hasFacetData = sourceTechnologies.length > 0 || sourceChangeTypes.length > 0;
  const hasExplicitGeneral = typeof appliesTo.general === "boolean";
  const general = appliesTo.general === true || (!hasExplicitGeneral && !hasFacetData);
  const hasScopedQuery = query.technologies.length > 0 || query.changeTypes.length > 0;

  let score = 0;
  score += Math.min(0.18, technologies.length * 0.08);
  score += Math.min(0.12, changeTypes.length * 0.06);
  if (score === 0 && query.includeGeneral && general && hasScopedQuery) score += 0.03;

  return {
    score,
    matches: {
      technologies,
      changeTypes,
      general: general && query.includeGeneral,
    },
  };
}

function buildKnowledgeScopeMetadata(
  sourceUri: string,
  metadata?: Record<string, unknown>,
  explicitAppliesTo?: Record<string, unknown> | KnowledgeApplicabilityInput,
): { metadata: Record<string, unknown>; appliesTo: Record<string, unknown> } {
  const sourceMetadata = asRecord(metadata);
  const explicit = parseApplicabilityFromRecord(explicitAppliesTo);
  const repoPathCandidate =
    explicit.repoPath ??
    valueAsString(sourceMetadata.repoPath) ??
    valueAsString(sourceMetadata.sourceRepoPath) ??
    valueAsString(sourceMetadata.workspacePath);
  const repoPath = normalizeRepoPath(repoPathCandidate);
  const repoKey =
    valueAsString(explicit.repoKey) ??
    valueAsString(sourceMetadata.repoKey) ??
    normalizeRepoKey(repoPathCandidate);
  const technologies = uniqueLowerSlugs(explicit.technologies);
  const changeTypes = uniqueLowerSlugs(explicit.changeTypes);
  const general = explicit.general === true;

  return {
    metadata: {
      ...sourceMetadata,
      sourceUri,
      ...(repoPath ? { repoPath } : {}),
      ...(repoKey ? { repoKey } : {}),
    },
    appliesTo: {
      ...(repoPath ? { repoPath } : {}),
      ...(repoKey ? { repoKey } : {}),
      ...(general ? { general: true } : {}),
      ...(technologies.length > 0 ? { technologies } : {}),
      ...(changeTypes.length > 0 ? { changeTypes } : {}),
    },
  };
}

function normalizeRepoScope(
  options: KnowledgeSearchOptions,
): { repoPath: string; repoKey: string; allowGlobalScope: boolean } | undefined {
  const repoPath = normalizeRepoPath(options.repoPath);
  const repoKey = (options.repoKey || normalizeRepoKey(options.repoPath))?.trim();
  if (!repoPath && !repoKey) return undefined;
  return {
    repoPath: repoPath ?? "",
    repoKey: (repoKey ?? "").toLowerCase(),
    allowGlobalScope: options.allowGlobalScope !== false,
  };
}

function buildRepoScopedCondition(options: KnowledgeSearchOptions): SQL | undefined {
  const normalized = normalizeRepoScope(options);
  if (!normalized) return undefined;

  const mode = options.scopeMatchMode ?? "primary";
  const clauses: SQL[] = [];
  if (mode === "primary") {
    if (normalized.allowGlobalScope) {
      clauses.push(eq(knowledgeItems.scope, "global"));
    }
    if (normalized.repoKey) {
      clauses.push(sql`${knowledgeItems.appliesTo} ->> 'repoKey' = ${normalized.repoKey}`);
    }
    if (normalized.repoPath) {
      clauses.push(sql`${knowledgeItems.appliesTo} ->> 'repoPath' = ${normalized.repoPath}`);
    }
  } else {
    if (normalized.repoKey) {
      clauses.push(sql`${knowledgeItems.metadata} ->> 'repoKey' = ${normalized.repoKey}`);
      clauses.push(sql`${knowledgeItems.metadata} ->> 'sourceProject' = ${normalized.repoKey}`);
    }
    if (normalized.repoPath) {
      clauses.push(sql`${knowledgeItems.metadata} ->> 'repoPath' = ${normalized.repoPath}`);
      clauses.push(
        sql`${knowledgeItems.metadata} ->> 'sourceUri' ilike ${`${normalized.repoPath}/%`}`,
      );
      clauses.push(
        sql`${knowledgeItems.metadata} ->> 'sourceDocumentUri' ilike ${`${normalized.repoPath}/%`}`,
      );
      const fileUriPrefix = `file://${normalized.repoPath.startsWith("/") ? "" : "/"}${normalized.repoPath}`;
      clauses.push(sql`${knowledgeItems.metadata} ->> 'sourceUri' ilike ${`${fileUriPrefix}/%`}`);
      clauses.push(
        sql`${knowledgeItems.metadata} ->> 'sourceDocumentUri' ilike ${`${fileUriPrefix}/%`}`,
      );
    }
  }

  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

function fallbackSourceRefsFromMetadata(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const sourceDocumentUri =
    typeof metadata.sourceDocumentUri === "string" ? metadata.sourceDocumentUri : undefined;
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri : undefined;
  const locator =
    typeof metadata.sourceFragmentLocator === "string" && metadata.sourceFragmentLocator.trim()
      ? metadata.sourceFragmentLocator.trim()
      : "full";

  const source = sourceDocumentUri ?? sourceUri;
  if (source) refs.add(`${source}#${locator}`);
  return [...refs];
}

function resolveKnowledgeActor(sourceUri: string): "agent" | "system" {
  return sourceUri.startsWith("agent://") ? "agent" : "system";
}

async function listKnowledgeSourceRefs(knowledgeIds: string[]): Promise<Map<string, string[]>> {
  if (knowledgeIds.length === 0) return new Map();
  const rows = await db
    .select({
      knowledgeId: knowledgeSourceLinks.knowledgeId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      confidence: knowledgeSourceLinks.confidence,
    })
    .from(knowledgeSourceLinks)
    .innerJoin(sourceFragments, eq(sourceFragments.id, knowledgeSourceLinks.sourceFragmentId))
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(inArray(knowledgeSourceLinks.knowledgeId, knowledgeIds))
    .orderBy(desc(knowledgeSourceLinks.confidence), desc(knowledgeSourceLinks.createdAt));

  const refsByKnowledgeId = new Map<string, string[]>();
  for (const row of rows) {
    const current = refsByKnowledgeId.get(row.knowledgeId) ?? [];
    const ref = `${row.sourceUri}#${row.locator}`;
    if (!current.includes(ref)) current.push(ref);
    refsByKnowledgeId.set(row.knowledgeId, current);
  }
  return refsByKnowledgeId;
}

type KnowledgeSearchRow = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo: unknown;
  metadata: unknown;
  dynamicScore: number;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  score: number;
};

function mapKnowledgeRowsToResults(
  rows: KnowledgeSearchRow[],
  sourceRefsByKnowledgeId: Map<string, string[]>,
  applicabilityQuery: ApplicabilityQuery,
): KnowledgeSearchResult[] {
  return rows.map((row) => {
    const appliesTo = asRecord(row.appliesTo);
    const metadata = asRecord(row.metadata);
    const sourceRefs =
      sourceRefsByKnowledgeId.get(row.id) ?? fallbackSourceRefsFromMetadata(metadata);
    const normalizedType = row.type === "procedure" ? "procedure" : "rule";
    const normalizedScope = row.scope === "global" ? "global" : "repo";
    const dynamicScore = Math.max(0, finiteOrZero(row.dynamicScore));
    const compileSelectCount = Math.max(0, Math.floor(finiteOrZero(row.compileSelectCount)));
    const agenticAcceptCount = Math.max(0, Math.floor(finiteOrZero(row.agenticAcceptCount)));
    const explicitUpvoteCount = Math.max(0, Math.floor(finiteOrZero(row.explicitUpvoteCount)));
    const explicitDownvoteCount = Math.max(0, Math.floor(finiteOrZero(row.explicitDownvoteCount)));
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    const decayFactor = computeDecayFactor({
      type: normalizedType,
      scope: normalizedScope,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt,
    });
    const applicability = computeApplicability(appliesTo, applicabilityQuery);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      scope: row.scope,
      title: row.title,
      body: row.body,
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      score: finiteOrZero(row.score) + applicability.score,
      appliesTo,
      metadata,
      sourceRefs,
      hasSourceLinks: sourceRefs.length > 0,
      dynamicScore,
      compileSelectCount,
      agenticAcceptCount,
      explicitUpvoteCount,
      explicitDownvoteCount,
      lastCompiledAt: row.lastCompiledAt,
      lastVerifiedAt: row.lastVerifiedAt,
      updatedAt,
      decayFactor,
      applicabilityScore: applicability.score,
      applicabilityMatches: applicability.matches,
    };
  });
}

function buildJsonbArrayAnyMatch(key: string, values: string[]): SQL | undefined {
  if (values.length === 0) return undefined;
  const quotedKey = sql.raw(`'${key}'`);
  return sql`(coalesce(${knowledgeItems.appliesTo} -> ${quotedKey}, '[]'::jsonb) ?| array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`,`,
  )}])`;
}

function buildApplicabilityFilterCondition(query: ApplicabilityQuery): SQL | undefined {
  const clauses: SQL[] = [];
  const technologies = buildJsonbArrayAnyMatch("technologies", query.technologies);
  if (technologies) clauses.push(technologies);
  const changeTypes = buildJsonbArrayAnyMatch("changeTypes", query.changeTypes);
  if (changeTypes) clauses.push(changeTypes);
  if (query.includeGeneral) {
    clauses.push(sql`coalesce((${knowledgeItems.appliesTo} ->> 'general')::boolean, false) = true`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

export async function searchKnowledge(
  input: KnowledgeSearchQueryInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const conditions: SQL[] = [];

  if (options.types && options.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, options.types));
  } else if (input.types && input.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, input.types));
  }

  if (input.statuses && input.statuses.length > 0) {
    conditions.push(inArray(knowledgeItems.status, input.statuses));
  } else {
    conditions.push(eq(knowledgeItems.status, input.status));
  }

  const repoScopedCondition = buildRepoScopedCondition({
    ...options,
    repoPath: options.repoPath ?? input.repoPath,
  });
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
  }

  const query = input.query.trim();
  const importanceOrderExpr = normalizedImportanceExpr();
  const rankExpr = sql<number>`
    ts_rank_cd(
      to_tsvector('simple', concat_ws(' ', ${knowledgeItems.title}, ${knowledgeItems.body})),
      plainto_tsquery('simple', ${query})
    )
  `;
  const textMatchExpr = sql<boolean>`
    to_tsvector('simple', concat_ws(' ', ${knowledgeItems.title}, ${knowledgeItems.body}))
    @@ plainto_tsquery('simple', ${query})
  `;
  const textSearchCondition =
    or(
      ilike(knowledgeItems.title, `%${query}%`),
      ilike(knowledgeItems.body, `%${query}%`),
      textMatchExpr,
    ) ?? textMatchExpr;
  const applicabilityQuery = buildApplicabilityQuery(input, options);
  const facetRequested = hasApplicabilityQuery(applicabilityQuery);
  const searchLimit = facetRequested ? Math.max(input.limit * 3, 30) : input.limit;

  const selectFields = {
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
    dynamicScore: knowledgeItems.dynamicScore,
    compileSelectCount: knowledgeItems.compileSelectCount,
    agenticAcceptCount: knowledgeItems.agenticAcceptCount,
    explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
    explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
    lastCompiledAt: knowledgeItems.lastCompiledAt,
    lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    updatedAt: knowledgeItems.updatedAt,
    score: rankExpr,
  } as const;

  const rankedRows = (await db
    .select(selectFields)
    .from(knowledgeItems)
    .where(and(...conditions, textSearchCondition))
    .orderBy(desc(rankExpr), desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
    .limit(searchLimit)) as KnowledgeSearchRow[];

  let rows: KnowledgeSearchRow[] = [...rankedRows];
  if (rows.length === 0 && facetRequested) {
    const applicabilityCondition = buildApplicabilityFilterCondition(applicabilityQuery);
    if (applicabilityCondition) {
      const fallbackRows = (await db
        .select({
          ...selectFields,
          score: sql<number>`0`,
        })
        .from(knowledgeItems)
        .where(and(...conditions, applicabilityCondition))
        .orderBy(desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
        .limit(searchLimit)) as KnowledgeSearchRow[];
      rows = fallbackRows;
    }
  }

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapKnowledgeRowsToResults(rows, sourceRefsByKnowledgeId, applicabilityQuery)
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, input.limit);
}

export async function upsertKnowledgeFromSource(
  params: UpsertKnowledgeFromSourceParams,
): Promise<string> {
  const existing = await db.query.knowledgeItems.findFirst({
    where: sql`${knowledgeItems.metadata} ->> 'sourceUri' = ${params.sourceUri}`,
  });

  const scoped = buildKnowledgeScopeMetadata(params.sourceUri, params.metadata, params.appliesTo);
  const metadata = scoped.metadata;

  if (existing) {
    const now = new Date();
    await db
      .update(knowledgeItems)
      .set({
        type: params.type,
        status: params.status,
        scope: params.scope,
        title: params.title,
        body: params.body,
        confidence: normalizeKnowledgeScore(params.confidence, 70),
        importance: normalizeKnowledgeScore(params.importance, 70),
        appliesTo: scoped.appliesTo,
        metadata,
        embedding: params.embedding,
        updatedAt: now,
        lastVerifiedAt: now,
      })
      .where(eq(knowledgeItems.id, existing.id));
    const actor = resolveKnowledgeActor(params.sourceUri);
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeUpdated,
      actor,
      payload: {
        knowledgeId: existing.id,
        sourceUri: params.sourceUri,
        type: params.type,
        status: params.status,
        scope: params.scope,
        title: params.title,
        previousStatus: existing.status,
      },
    });
    if (existing.status !== params.status) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.knowledgeStatusChanged,
        actor,
        payload: {
          knowledgeId: existing.id,
          sourceUri: params.sourceUri,
          fromStatus: existing.status,
          toStatus: params.status,
        },
      });
    }
    return existing.id;
  }

  const [inserted] = await db
    .insert(knowledgeItems)
    .values({
      type: params.type,
      status: params.status,
      scope: params.scope,
      title: params.title,
      body: params.body,
      confidence: normalizeKnowledgeScore(params.confidence, 70),
      importance: normalizeKnowledgeScore(params.importance, 70),
      appliesTo: scoped.appliesTo,
      metadata,
      embedding: params.embedding,
      lastVerifiedAt: new Date(),
    })
    .returning({ id: knowledgeItems.id });

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeCreated,
    actor: resolveKnowledgeActor(params.sourceUri),
    payload: {
      knowledgeId: inserted.id,
      sourceUri: params.sourceUri,
      type: params.type,
      status: params.status,
      scope: params.scope,
      title: params.title,
    },
  });

  return inserted.id;
}

export async function vectorSearchKnowledge(
  embedding: number[],
  limit: number,
  statuses: KnowledgeStatus[] = ["active"],
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const applicabilityQuery = buildApplicabilityQuery(
    {
      includeGeneral: options.includeGeneral ?? true,
    },
    options,
  );
  const facetRequested = hasApplicabilityQuery(applicabilityQuery);
  const searchLimit = facetRequested ? Math.max(limit * 3, 30) : limit;
  const embeddingStr = JSON.stringify(embedding);
  const importanceOrderExpr = normalizedImportanceExpr();
  const similarity = sql<number>`1 - (${knowledgeItems.embedding} <=> ${embeddingStr}::vector)`;
  const conditions: SQL[] = [
    inArray(knowledgeItems.status, statuses),
    sql`${knowledgeItems.embedding} IS NOT NULL`,
  ];
  if (options.types && options.types.length > 0) {
    conditions.push(inArray(knowledgeItems.type, options.types));
  }
  const repoScopedCondition = buildRepoScopedCondition(options);
  if (repoScopedCondition) {
    conditions.push(repoScopedCondition);
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
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
      dynamicScore: knowledgeItems.dynamicScore,
      compileSelectCount: knowledgeItems.compileSelectCount,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
      updatedAt: knowledgeItems.updatedAt,
      score: similarity,
    })
    .from(knowledgeItems)
    .where(and(...conditions))
    .orderBy(desc(similarity), desc(importanceOrderExpr))
    .limit(searchLimit);

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapKnowledgeRowsToResults(
    rows as KnowledgeSearchRow[],
    sourceRefsByKnowledgeId,
    applicabilityQuery,
  )
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit);
}
