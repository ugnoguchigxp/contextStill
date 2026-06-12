import { and, desc, eq, ne } from "drizzle-orm";
import { getDefaultDbSession } from "../../db/session.js";
import { contextCompileTaskTraces } from "../../db/schema.js";

const db = getDefaultDbSession().db;

export type ContextCompileTaskTraceEmbeddingStatus =
  | "facets_only"
  | "embedding_available"
  | "embedding_unavailable";

export type ContextCompileTaskTrace = {
  runId: string;
  retrievalMode: string;
  repoPath: string | null;
  repoKey: string | null;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  embeddingStatus: ContextCompileTaskTraceEmbeddingStatus;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: number[] | null;
  goalHash: string;
  createdAt: Date;
  updatedAt: Date;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function asNullableInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

function asEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value.map((entry) => Number(entry));
  if (vector.length === 0 || vector.some((entry) => !Number.isFinite(entry))) return null;
  return vector;
}

function mapRow(row: {
  runId: string;
  retrievalMode: string;
  repoPath: string | null;
  repoKey: string | null;
  technologies: unknown;
  changeTypes: unknown;
  domains: unknown;
  embeddingStatus: string;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: unknown;
  goalHash: string;
  createdAt: Date;
  updatedAt: Date;
}): ContextCompileTaskTrace {
  const embeddingStatus: ContextCompileTaskTraceEmbeddingStatus =
    row.embeddingStatus === "embedding_available" ||
    row.embeddingStatus === "embedding_unavailable" ||
    row.embeddingStatus === "facets_only"
      ? row.embeddingStatus
      : "facets_only";

  return {
    runId: row.runId,
    retrievalMode: row.retrievalMode,
    repoPath: row.repoPath,
    repoKey: row.repoKey,
    technologies: asStringArray(row.technologies),
    changeTypes: asStringArray(row.changeTypes),
    domains: asStringArray(row.domains),
    embeddingStatus,
    embeddingProvider: row.embeddingProvider,
    embeddingModel: row.embeddingModel,
    embeddingDimensions: asNullableInt(row.embeddingDimensions),
    embedding: asEmbedding(row.embedding),
    goalHash: row.goalHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function upsertContextCompileTaskTrace(input: {
  runId: string;
  retrievalMode: string;
  repoPath: string | null;
  repoKey: string | null;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  embeddingStatus: ContextCompileTaskTraceEmbeddingStatus;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: number[] | null;
  goalHash: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(contextCompileTaskTraces)
    .values({
      runId: input.runId,
      retrievalMode: input.retrievalMode,
      repoPath: input.repoPath,
      repoKey: input.repoKey,
      technologies: input.technologies,
      changeTypes: input.changeTypes,
      domains: input.domains,
      embeddingStatus: input.embeddingStatus,
      embeddingProvider: input.embeddingProvider,
      embeddingModel: input.embeddingModel,
      embeddingDimensions: input.embeddingDimensions,
      embedding: input.embedding,
      goalHash: input.goalHash,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [contextCompileTaskTraces.runId],
      set: {
        retrievalMode: input.retrievalMode,
        repoPath: input.repoPath,
        repoKey: input.repoKey,
        technologies: input.technologies,
        changeTypes: input.changeTypes,
        domains: input.domains,
        embeddingStatus: input.embeddingStatus,
        embeddingProvider: input.embeddingProvider,
        embeddingModel: input.embeddingModel,
        embeddingDimensions: input.embeddingDimensions,
        embedding: input.embedding,
        goalHash: input.goalHash,
        updatedAt: now,
      },
    });
}

export async function findContextCompileTaskTraceByRunId(
  runId: string,
): Promise<ContextCompileTaskTrace | null> {
  const [row] = await db
    .select({
      runId: contextCompileTaskTraces.runId,
      retrievalMode: contextCompileTaskTraces.retrievalMode,
      repoPath: contextCompileTaskTraces.repoPath,
      repoKey: contextCompileTaskTraces.repoKey,
      technologies: contextCompileTaskTraces.technologies,
      changeTypes: contextCompileTaskTraces.changeTypes,
      domains: contextCompileTaskTraces.domains,
      embeddingStatus: contextCompileTaskTraces.embeddingStatus,
      embeddingProvider: contextCompileTaskTraces.embeddingProvider,
      embeddingModel: contextCompileTaskTraces.embeddingModel,
      embeddingDimensions: contextCompileTaskTraces.embeddingDimensions,
      embedding: contextCompileTaskTraces.embedding,
      goalHash: contextCompileTaskTraces.goalHash,
      createdAt: contextCompileTaskTraces.createdAt,
      updatedAt: contextCompileTaskTraces.updatedAt,
    })
    .from(contextCompileTaskTraces)
    .where(eq(contextCompileTaskTraces.runId, runId))
    .limit(1);

  return row ? mapRow(row) : null;
}

export async function listRecentContextCompileTaskTraces(input: {
  limit: number;
  excludeRunId?: string;
}): Promise<ContextCompileTaskTrace[]> {
  const limit = Math.max(1, Math.min(400, Math.trunc(input.limit)));
  const where = input.excludeRunId
    ? and(ne(contextCompileTaskTraces.runId, input.excludeRunId))
    : undefined;

  const rows = await db
    .select({
      runId: contextCompileTaskTraces.runId,
      retrievalMode: contextCompileTaskTraces.retrievalMode,
      repoPath: contextCompileTaskTraces.repoPath,
      repoKey: contextCompileTaskTraces.repoKey,
      technologies: contextCompileTaskTraces.technologies,
      changeTypes: contextCompileTaskTraces.changeTypes,
      domains: contextCompileTaskTraces.domains,
      embeddingStatus: contextCompileTaskTraces.embeddingStatus,
      embeddingProvider: contextCompileTaskTraces.embeddingProvider,
      embeddingModel: contextCompileTaskTraces.embeddingModel,
      embeddingDimensions: contextCompileTaskTraces.embeddingDimensions,
      embedding: contextCompileTaskTraces.embedding,
      goalHash: contextCompileTaskTraces.goalHash,
      createdAt: contextCompileTaskTraces.createdAt,
      updatedAt: contextCompileTaskTraces.updatedAt,
    })
    .from(contextCompileTaskTraces)
    .where(where)
    .orderBy(desc(contextCompileTaskTraces.createdAt))
    .limit(limit);

  return rows.map(mapRow);
}
