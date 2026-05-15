import { desc, eq, inArray, sql } from "drizzle-orm";
import { closeDbPool, getDb } from "../db/index.js";
import { knowledgeItems, vibeMemories } from "../db/schema.js";
import { normalizeRepoKey, normalizeRepoPath } from "../modules/context-compiler/query-context.js";

type CliOptions = {
  apply: boolean;
  limit?: number;
};

type KnowledgeRow = {
  id: string;
  appliesTo: unknown;
  metadata: unknown;
};

type CandidateRow = {
  id: string;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceSessionId: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      if (arg === "--limit") index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
    } else if (arg === "--json") {
      // JSON is the default output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function needsBackfill(
  appliesTo: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  const appliesRepoPath = valueAsString(appliesTo.repoPath);
  const appliesRepoKey = valueAsString(appliesTo.repoKey);
  const metadataRepoPath = valueAsString(metadata.repoPath);
  const metadataRepoKey = valueAsString(metadata.repoKey);
  return !(appliesRepoPath && appliesRepoKey && metadataRepoPath && metadataRepoKey);
}

async function fetchKnowledgeRows(limit?: number): Promise<KnowledgeRow[]> {
  const db = getDb();
  const query = db
    .select({
      id: knowledgeItems.id,
      appliesTo: knowledgeItems.appliesTo,
      metadata: knowledgeItems.metadata,
    })
    .from(knowledgeItems)
    .where(sql`${knowledgeItems.metadata} ? 'sourceSessionId'`)
    .orderBy(desc(knowledgeItems.updatedAt));

  if (limit !== undefined) {
    return query.limit(limit);
  }
  return query;
}

async function buildProjectRootLookup(sessionIds: string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      sessionId: vibeMemories.sessionId,
      metadata: vibeMemories.metadata,
    })
    .from(vibeMemories)
    .where(inArray(vibeMemories.sessionId, sessionIds))
    .orderBy(desc(vibeMemories.createdAt));

  const lookup = new Map<string, string>();
  for (const row of rows) {
    if (lookup.has(row.sessionId)) continue;
    const metadata = asRecord(row.metadata);
    const projectRoot = valueAsString(metadata.projectRoot) ?? valueAsString(metadata.repoPath);
    if (!projectRoot) continue;
    lookup.set(row.sessionId, projectRoot);
  }
  return lookup;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await fetchKnowledgeRows(options.limit);
  const candidates: CandidateRow[] = [];

  for (const row of rows) {
    const appliesTo = asRecord(row.appliesTo);
    const metadata = asRecord(row.metadata);
    const sourceSessionId = valueAsString(metadata.sourceSessionId);
    if (!sourceSessionId) continue;
    if (!needsBackfill(appliesTo, metadata)) continue;
    candidates.push({
      id: row.id,
      appliesTo,
      metadata,
      sourceSessionId,
    });
  }

  const sessionIds = [...new Set(candidates.map((row) => row.sourceSessionId))];
  const projectRootLookup = await buildProjectRootLookup(sessionIds);

  let updated = 0;
  let skippedNoProjectRoot = 0;
  const changedIds: string[] = [];

  const db = getDb();
  for (const candidate of candidates) {
    const projectRoot = projectRootLookup.get(candidate.sourceSessionId);
    if (!projectRoot) {
      skippedNoProjectRoot += 1;
      continue;
    }
    const normalizedRepoPath = normalizeRepoPath(projectRoot);
    const normalizedRepoKey = normalizeRepoKey(projectRoot);
    if (!normalizedRepoPath && !normalizedRepoKey) {
      skippedNoProjectRoot += 1;
      continue;
    }

    const nextAppliesTo = { ...candidate.appliesTo };
    const nextMetadata = { ...candidate.metadata };
    if (normalizedRepoPath) {
      if (!valueAsString(nextAppliesTo.repoPath)) nextAppliesTo.repoPath = normalizedRepoPath;
      if (!valueAsString(nextMetadata.repoPath)) nextMetadata.repoPath = normalizedRepoPath;
    }
    if (normalizedRepoKey) {
      if (!valueAsString(nextAppliesTo.repoKey)) nextAppliesTo.repoKey = normalizedRepoKey;
      if (!valueAsString(nextMetadata.repoKey)) nextMetadata.repoKey = normalizedRepoKey;
    }

    const appliesChanged = JSON.stringify(nextAppliesTo) !== JSON.stringify(candidate.appliesTo);
    const metadataChanged = JSON.stringify(nextMetadata) !== JSON.stringify(candidate.metadata);
    if (!appliesChanged && !metadataChanged) continue;

    changedIds.push(candidate.id);
    if (!options.apply) continue;

    await db
      .update(knowledgeItems)
      .set({
        appliesTo: nextAppliesTo,
        metadata: nextMetadata,
        updatedAt: new Date(),
      })
      .where(eq(knowledgeItems.id, candidate.id));
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        apply: options.apply,
        scannedKnowledgeRows: rows.length,
        candidateRows: candidates.length,
        uniqueSessions: sessionIds.length,
        resolvedSessions: projectRootLookup.size,
        changedRows: changedIds.length,
        updatedRows: updated,
        skippedNoProjectRoot,
        changedRowIdsPreview: changedIds.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
