import { and, desc, eq, inArray } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { getDefaultDbSession } from "../../db/session.js";
import { episodeCards, episodeRefs } from "../../db/schema.js";
import {
  type EpisodeCard,
  type EpisodeCardCreateInput,
  type EpisodeCardSearchInput,
  episodeCardCreateSchema,
  episodeCardSearchInputSchema,
  episodeCardSchema,
} from "../../shared/schemas/episode-card.schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";

const db = getDefaultDbSession().db;

type EpisodeCardRow = typeof episodeCards.$inferSelect;
type EpisodeRefRow = typeof episodeRefs.$inferSelect;

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function sqliteRepository() {
  return import("./episode-card.repository.sqlite.js");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeFacet(value: string): string {
  return normalizeText(value)
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}./+#-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueFacets(values: string[] | undefined): string[] {
  const set = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalizeFacet(value);
    if (normalized) set.add(normalized);
  }
  return [...set];
}

function intersects(queryValues: string[] | undefined, sourceValues: string[]): boolean {
  const query = uniqueFacets(queryValues);
  if (query.length === 0) return true;
  const source = new Set(sourceValues.map(normalizeFacet));
  return query.some((value) => source.has(value));
}

function overlapCount(queryValues: string[] | undefined, sourceValues: string[]): number {
  const query = uniqueFacets(queryValues);
  if (query.length === 0) return 0;
  const source = new Set(sourceValues.map(normalizeFacet));
  return query.filter((value) => source.has(value)).length;
}

function queryTokens(query: string): string[] {
  return [
    ...new Set(
      normalizeText(query)
        .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f./+#-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ].slice(0, 16);
}

function scoreText(text: string, query: string | undefined): number {
  const normalizedQuery = normalizeText(query ?? "");
  if (!normalizedQuery) return 0;
  const normalizedText = normalizeText(text);
  let score = normalizedText.includes(normalizedQuery) ? 8 : 0;
  for (const token of queryTokens(normalizedQuery)) {
    if (normalizedText.includes(token)) score += 1;
  }
  return score;
}

function mapEpisode(row: EpisodeCardRow, refs: EpisodeRefRow[], score?: number): EpisodeCard {
  return episodeCardSchema.parse({
    id: row.id,
    title: row.title,
    situation: row.situation,
    observations: row.observations,
    action: row.action,
    outcome: row.outcome,
    lesson: row.lesson,
    applicability: asRecord(row.applicability),
    antiApplicability: asRecord(row.antiApplicability),
    domains: asStringArray(row.domains),
    technologies: asStringArray(row.technologies),
    changeTypes: asStringArray(row.changeTypes),
    tools: asStringArray(row.tools),
    repoPath: row.repoPath,
    repoKey: row.repoKey,
    sourceKind: row.sourceKind,
    sourceKey: row.sourceKey,
    outcomeKind: row.outcomeKind,
    confidence: row.confidence,
    evidenceStatus: row.evidenceStatus,
    status: row.status,
    staleAt: row.staleAt,
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    score,
    refs: refs.map((ref) => ({
      id: ref.id,
      episodeCardId: ref.episodeCardId,
      refKind: ref.refKind,
      refValue: ref.refValue,
      locator: ref.locator,
      queryHint: ref.queryHint,
      metadata: asRecord(ref.metadata),
      createdAt: ref.createdAt,
    })),
  });
}

function searchableText(episode: EpisodeCard): string {
  return [
    episode.title,
    episode.situation,
    episode.observations,
    episode.action,
    episode.outcome,
    episode.lesson,
    episode.domains.join(" "),
    episode.technologies.join(" "),
    episode.changeTypes.join(" "),
    episode.tools.join(" "),
    episode.refs.map((ref) => `${ref.refKind} ${ref.refValue} ${ref.queryHint ?? ""}`).join(" "),
  ].join("\n");
}

function matchesSearchInput(episode: EpisodeCard, input: ReturnType<typeof normalizeSearchInput>) {
  if (!input.statuses.includes(episode.status)) return false;
  if (input.repoPath && episode.repoPath !== input.repoPath) return false;
  if (input.repoKey && episode.repoKey !== input.repoKey) return false;
  if (input.outcomeKinds.length > 0 && !input.outcomeKinds.includes(episode.outcomeKind)) {
    return false;
  }
  if (
    input.evidenceStatuses.length > 0 &&
    !input.evidenceStatuses.includes(episode.evidenceStatus)
  ) {
    return false;
  }
  if (!intersects(input.domains, episode.domains)) return false;
  if (!intersects(input.technologies, episode.technologies)) return false;
  if (!intersects(input.changeTypes, episode.changeTypes)) return false;
  if (!intersects(input.tools, episode.tools)) return false;
  return true;
}

function scoreEpisode(
  episode: EpisodeCard,
  input: ReturnType<typeof normalizeSearchInput>,
): number {
  const queryScore = scoreText(searchableText(episode), input.query);
  if (input.query && queryScore <= 0) return 0;
  const facetScore =
    overlapCount(input.domains, episode.domains) * 3 +
    overlapCount(input.technologies, episode.technologies) * 3 +
    overlapCount(input.changeTypes, episode.changeTypes) * 3 +
    overlapCount(input.tools, episode.tools) * 2;
  const evidenceBoost =
    episode.evidenceStatus === "verified" ? 2 : episode.evidenceStatus === "partial" ? 1 : 0;
  const outcomeBoost = episode.outcomeKind === "unknown" ? 0 : 1;
  return queryScore + facetScore + evidenceBoost + outcomeBoost + episode.confidence / 100;
}

function normalizeSearchInput(rawInput: EpisodeCardSearchInput) {
  const input = episodeCardSearchInputSchema.parse(rawInput);
  const statuses =
    input.statuses && input.statuses.length > 0
      ? input.statuses
      : input.status
        ? [input.status]
        : input.includeDraft
          ? ["active", "draft"]
          : ["active"];
  return {
    ...input,
    query: input.query?.trim(),
    statuses,
    domains: uniqueFacets(input.domains),
    technologies: uniqueFacets(input.technologies),
    changeTypes: uniqueFacets(input.changeTypes),
    tools: uniqueFacets(input.tools),
    outcomeKinds: input.outcomeKinds ?? [],
    evidenceStatuses: input.evidenceStatuses ?? [],
  };
}

async function refsByEpisodeIds(ids: string[]): Promise<Map<string, EpisodeRefRow[]>> {
  const refs = new Map<string, EpisodeRefRow[]>();
  if (ids.length === 0) return refs;
  const rows = await db.select().from(episodeRefs).where(inArray(episodeRefs.episodeCardId, ids));
  for (const row of rows) {
    const current = refs.get(row.episodeCardId) ?? [];
    current.push(row);
    refs.set(row.episodeCardId, current);
  }
  return refs;
}

export async function createEpisodeCard(rawInput: EpisodeCardCreateInput): Promise<EpisodeCard> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.createEpisodeCardSqlite(rawInput);
  }

  const input = episodeCardCreateSchema.parse(rawInput);
  const now = new Date();
  const episode = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(episodeCards)
      .values({
        title: redactSecrets(input.title),
        situation: redactSecrets(input.situation),
        observations: redactSecrets(input.observations),
        action: redactSecrets(input.action),
        outcome: redactSecrets(input.outcome),
        lesson: redactSecrets(input.lesson),
        applicability: input.applicability,
        antiApplicability: input.antiApplicability,
        domains: uniqueFacets(input.domains),
        technologies: uniqueFacets(input.technologies),
        changeTypes: uniqueFacets(input.changeTypes),
        tools: uniqueFacets(input.tools),
        repoPath: input.repoPath ?? null,
        repoKey: input.repoKey ?? null,
        sourceKind: input.sourceKind,
        sourceKey: input.sourceKey,
        outcomeKind: input.outcomeKind,
        confidence: input.confidence,
        evidenceStatus: input.evidenceStatus,
        status: input.status,
        staleAt: input.staleAt ?? null,
        metadata: redactSecretRecord(input.metadata),
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const insertedRefs =
      input.refs.length > 0
        ? await tx
            .insert(episodeRefs)
            .values(
              input.refs.map((ref) => ({
                episodeCardId: inserted.id,
                refKind: ref.refKind,
                refValue: ref.refValue,
                locator: ref.locator ?? null,
                queryHint: ref.queryHint ?? null,
                metadata: redactSecretRecord(ref.metadata),
              })),
            )
            .returning()
        : [];

    return mapEpisode(inserted, insertedRefs);
  });

  return episode;
}

export async function getEpisodeCard(id: string): Promise<EpisodeCard | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getEpisodeCardSqlite(id);
  }
  const [row] = await db.select().from(episodeCards).where(eq(episodeCards.id, id)).limit(1);
  if (!row) return null;
  const refs = await refsByEpisodeIds([row.id]);
  return mapEpisode(row, refs.get(row.id) ?? []);
}

export async function getEpisodeCardBySource(params: {
  sourceKind: EpisodeCardCreateInput["sourceKind"];
  sourceKey: string;
}): Promise<EpisodeCard | null> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.getEpisodeCardBySourceSqlite(params);
  }
  const [row] = await db
    .select()
    .from(episodeCards)
    .where(
      and(
        eq(episodeCards.sourceKind, params.sourceKind),
        eq(episodeCards.sourceKey, params.sourceKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  const refs = await refsByEpisodeIds([row.id]);
  return mapEpisode(row, refs.get(row.id) ?? []);
}

export async function searchEpisodeCards(rawInput: EpisodeCardSearchInput): Promise<EpisodeCard[]> {
  if (isSqliteBackend()) {
    const sqlite = await sqliteRepository();
    return sqlite.searchEpisodeCardsSqlite(rawInput);
  }
  const input = normalizeSearchInput(rawInput);
  const conditions = [inArray(episodeCards.status, input.statuses)];
  if (input.repoPath) conditions.push(eq(episodeCards.repoPath, input.repoPath));
  if (input.repoKey) conditions.push(eq(episodeCards.repoKey, input.repoKey));

  const rows = await db
    .select()
    .from(episodeCards)
    .where(and(...conditions))
    .orderBy(desc(episodeCards.createdAt))
    .limit(500);
  const refs = await refsByEpisodeIds(rows.map((row) => row.id));
  return rows
    .map((row) => mapEpisode(row, refs.get(row.id) ?? []))
    .filter((episode) => matchesSearchInput(episode, input))
    .map((episode) => ({ episode, score: scoreEpisode(episode, input) }))
    .filter(({ score }) => !input.query || score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.episode.createdAt.getTime() - left.episode.createdAt.getTime(),
    )
    .slice(0, input.limit)
    .map(({ episode, score }) => ({ ...episode, score }));
}
