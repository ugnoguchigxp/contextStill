import { and, desc, eq, inArray } from "drizzle-orm";
import { getRuntimeSqliteCoreDatabase } from "../../db/sqlite/runtime.js";
import {
  sqliteKnowledgeItems,
  sqliteKnowledgeSourceLinks,
  sqliteSourceFragments,
  sqliteSources,
} from "../../db/sqlite/schema.js";
import { SqliteCoreRepository } from "../../db/sqlite/core-repository.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type { KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { computeDecayFactor } from "./knowledge-value.service.js";
import {
  type ApplicabilityQuery,
  type KnowledgeSearchOptions,
  type KnowledgeSearchQueryInput,
  type KnowledgeSearchResult,
  type UpsertKnowledgeFromSourceParams,
  asRecord,
  buildApplicabilityQuery,
  buildKnowledgeScopeMetadata,
  computeApplicability,
  fallbackSourceRefsFromMetadata,
  finiteOrZero,
  hasApplicabilityQuery,
} from "./knowledge.repository.shared.js";

type SqliteKnowledgeSearchRow = typeof sqliteKnowledgeItems.$inferSelect & {
  score: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRequiredDate(value: string): Date {
  return normalizeDate(value) ?? new Date(0);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function lowerIncludes(value: string, query: string): boolean {
  return value.toLowerCase().includes(query.toLowerCase());
}

function tokenize(query: string): string[] {
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

function textScore(row: typeof sqliteKnowledgeItems.$inferSelect, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const title = row.title.toLowerCase();
  const body = row.body.toLowerCase();
  let score = 0;
  if (title.includes(normalized)) score += 4;
  if (body.includes(normalized)) score += 2;
  for (const token of tokenize(query)) {
    if (title.includes(token)) score += 1.5;
    if (body.includes(token)) score += 0.75;
  }
  return score;
}

function matchesIntentTags(
  row: typeof sqliteKnowledgeItems.$inferSelect,
  tags?: string[],
): boolean {
  if (!tags || tags.length === 0) return true;
  const rowTags = new Set(stringArray(row.intentTags));
  return tags.some((tag) => rowTags.has(tag));
}

function matchesRepoScope(
  row: typeof sqliteKnowledgeItems.$inferSelect,
  options: KnowledgeSearchOptions,
): boolean {
  const repoPath = options.repoPath?.trim();
  const repoKey = options.repoKey?.trim().toLowerCase();
  if (!repoPath && !repoKey) return true;
  const allowGlobalScope = options.allowGlobalScope !== false;
  const appliesTo = asRecord(row.appliesTo);
  const metadata = asRecord(row.metadata);
  if (options.scopeMatchMode !== "legacy") {
    if (allowGlobalScope && row.scope === "global") return true;
    if (repoKey && String(appliesTo.repoKey ?? "").toLowerCase() === repoKey) return true;
    if (repoPath && String(appliesTo.repoPath ?? "") === repoPath) return true;
    return false;
  }
  if (repoKey) {
    if (String(metadata.repoKey ?? "").toLowerCase() === repoKey) return true;
    if (String(metadata.sourceProject ?? "").toLowerCase() === repoKey) return true;
  }
  if (repoPath) {
    const fileUriPrefix = `file://${repoPath.startsWith("/") ? "" : "/"}${repoPath}`;
    for (const key of ["repoPath", "sourceUri", "sourceDocumentUri"]) {
      const value = String(metadata[key] ?? "");
      if (
        value === repoPath ||
        value.startsWith(`${repoPath}/`) ||
        value.startsWith(`${fileUriPrefix}/`)
      ) {
        return true;
      }
    }
  }
  return false;
}

function matchesApplicability(
  row: typeof sqliteKnowledgeItems.$inferSelect,
  query: ApplicabilityQuery,
): boolean {
  if (!hasApplicabilityQuery(query)) return true;
  const applicability = computeApplicability(asRecord(row.appliesTo), query);
  return applicability.score > 0 || (query.includeGeneral && applicability.matches.general);
}

async function listKnowledgeSourceRefs(knowledgeIds: string[]): Promise<Map<string, string[]>> {
  if (knowledgeIds.length === 0) return new Map();
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const rows = sqlite.orm
    .select({
      knowledgeId: sqliteKnowledgeSourceLinks.knowledgeId,
      sourceUri: sqliteSources.uri,
      locator: sqliteSourceFragments.locator,
      confidence: sqliteKnowledgeSourceLinks.confidence,
    })
    .from(sqliteKnowledgeSourceLinks)
    .innerJoin(
      sqliteSourceFragments,
      eq(sqliteSourceFragments.id, sqliteKnowledgeSourceLinks.sourceFragmentId),
    )
    .innerJoin(sqliteSources, eq(sqliteSources.id, sqliteSourceFragments.sourceId))
    .where(inArray(sqliteKnowledgeSourceLinks.knowledgeId, knowledgeIds))
    .orderBy(
      desc(sqliteKnowledgeSourceLinks.confidence),
      desc(sqliteKnowledgeSourceLinks.createdAt),
    )
    .all();

  const refsByKnowledgeId = new Map<string, string[]>();
  for (const row of rows) {
    const current = refsByKnowledgeId.get(row.knowledgeId) ?? [];
    const ref = `${row.sourceUri}#${row.locator}`;
    if (!current.includes(ref)) current.push(ref);
    refsByKnowledgeId.set(row.knowledgeId, current);
  }
  return refsByKnowledgeId;
}

function mapRowsToResults(
  rows: SqliteKnowledgeSearchRow[],
  sourceRefsByKnowledgeId: Map<string, string[]>,
  applicabilityQuery: ApplicabilityQuery,
): KnowledgeSearchResult[] {
  return rows.map((row) => {
    const appliesTo = asRecord(row.appliesTo);
    const metadata = asRecord(row.metadata);
    const updatedAt = normalizeRequiredDate(row.updatedAt);
    const lastVerifiedAt = normalizeDate(row.lastVerifiedAt);
    const sourceRefs =
      sourceRefsByKnowledgeId.get(row.id) ?? fallbackSourceRefsFromMetadata(metadata);
    const normalizedType = row.type === "procedure" ? "procedure" : "rule";
    const normalizedScope = row.scope === "global" ? "global" : "repo";
    const applicability = computeApplicability(appliesTo, applicabilityQuery);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      scope: row.scope,
      polarity: String(row.polarity ?? "positive"),
      intentTags: stringArray(row.intentTags),
      title: row.title,
      body: row.body,
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      score: finiteOrZero(row.score) + applicability.score / 100,
      appliesTo,
      metadata,
      sourceRefs,
      hasSourceLinks: sourceRefs.length > 0,
      dynamicScore: Math.max(0, finiteOrZero(row.dynamicScore)),
      compileSelectCount: Math.max(0, Math.floor(finiteOrZero(row.compileSelectCount))),
      agenticAcceptCount: Math.max(0, Math.floor(finiteOrZero(row.agenticAcceptCount))),
      explicitUpvoteCount: Math.max(0, Math.floor(finiteOrZero(row.explicitUpvoteCount))),
      explicitDownvoteCount: Math.max(0, Math.floor(finiteOrZero(row.explicitDownvoteCount))),
      lastCompiledAt: normalizeDate(row.lastCompiledAt),
      lastVerifiedAt,
      updatedAt,
      decayFactor: computeDecayFactor({
        type: normalizedType,
        scope: normalizedScope,
        lastVerifiedAt,
        updatedAt,
      }),
      applicabilityScore: applicability.score,
      applicabilityMatches: applicability.matches,
    };
  });
}

export async function searchKnowledgeSqlite(
  input: KnowledgeSearchQueryInput,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const statuses = input.statuses && input.statuses.length > 0 ? input.statuses : [input.status];
  const types = options.types && options.types.length > 0 ? options.types : input.types;
  const polarities = options.polarities ?? input.polarities;
  const applicabilityQuery = buildApplicabilityQuery(input, options);
  const candidates = sqlite.orm
    .select()
    .from(sqliteKnowledgeItems)
    .where(
      and(
        inArray(sqliteKnowledgeItems.status, statuses),
        ...(types && types.length > 0 ? [inArray(sqliteKnowledgeItems.type, types)] : []),
        ...(polarities && polarities.length > 0
          ? [inArray(sqliteKnowledgeItems.polarity, polarities)]
          : []),
      ),
    )
    .orderBy(desc(sqliteKnowledgeItems.importance), desc(sqliteKnowledgeItems.updatedAt))
    .limit(Math.max(input.limit * 12, 120))
    .all();

  const query = input.query.trim();
  const rows = candidates
    .map((row) => ({ ...row, score: textScore(row, query) }))
    .filter((row) => row.score > 0 || matchesApplicability(row, applicabilityQuery))
    .filter((row) => matchesIntentTags(row, options.intentTags ?? input.intentTags))
    .filter((row) =>
      matchesRepoScope(row, { ...options, repoPath: options.repoPath ?? input.repoPath }),
    )
    .filter((row) => matchesApplicability(row, applicabilityQuery))
    .sort(
      (a, b) =>
        b.score - a.score || b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, input.limit);

  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapRowsToResults(rows, sourceRefsByKnowledgeId, applicabilityQuery)
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, input.limit);
}

export async function upsertKnowledgeFromSourceSqlite(
  params: UpsertKnowledgeFromSourceParams,
): Promise<string> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const repo = new SqliteCoreRepository(sqlite);
  const scoped = buildKnowledgeScopeMetadata(params.sourceUri, params.metadata, params.appliesTo);
  const existing = sqlite.orm
    .select()
    .from(sqliteKnowledgeItems)
    .all()
    .find((row) => asRecord(row.metadata).sourceUri === params.sourceUri);
  const id = existing?.id ?? crypto.randomUUID();
  repo.upsertKnowledgeItem({
    id,
    type: params.type,
    status: params.status,
    scope: params.scope,
    polarity: params.polarity ?? existing?.polarity ?? "positive",
    intentTags: params.intentTags ?? stringArray(existing?.intentTags),
    title: params.title,
    body: params.body,
    confidence: normalizeKnowledgeScore(params.confidence, 70),
    importance: normalizeKnowledgeScore(params.importance, 70),
    appliesTo: scoped.appliesTo,
    metadata: scoped.metadata,
    embedding: params.embedding,
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  });
  return id;
}

export async function vectorSearchKnowledgeSqlite(
  embedding: number[],
  limit: number,
  statuses: KnowledgeStatus[] = ["active"],
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchResult[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const repo = new SqliteCoreRepository(sqlite);
  const hits = repo.vectorSearchKnowledge(embedding, Math.max(limit * 4, 20));
  if (hits.length === 0) return [];
  const hitScoreById = new Map(hits.map((hit) => [hit.id, hit.score]));
  const rows = sqlite.orm
    .select()
    .from(sqliteKnowledgeItems)
    .where(
      inArray(
        sqliteKnowledgeItems.id,
        hits.map((hit) => hit.id),
      ),
    )
    .all()
    .filter((row) => statuses.includes(row.status as KnowledgeStatus))
    .filter(
      (row) =>
        !options.types || options.types.length === 0 || options.types.includes(row.type as any),
    )
    .filter(
      (row) =>
        !options.polarities ||
        options.polarities.length === 0 ||
        options.polarities.includes(row.polarity as any),
    )
    .filter((row) => matchesIntentTags(row, options.intentTags))
    .filter((row) => matchesRepoScope(row, options))
    .map((row) => ({ ...row, score: hitScoreById.get(row.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const applicabilityQuery = buildApplicabilityQuery({ includeGeneral: true }, options);
  const sourceRefsByKnowledgeId = await listKnowledgeSourceRefs(rows.map((row) => row.id));
  return mapRowsToResults(rows, sourceRefsByKnowledgeId, applicabilityQuery);
}
