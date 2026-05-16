import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { closeDbPool, getDb } from "../db/index.js";
import { contextPackItems, knowledgeItems } from "../db/schema.js";
import { computeDynamicScore } from "../modules/knowledge/knowledge-value.service.js";

type CliOptions = {
  apply: boolean;
  limit?: number;
};

type KnowledgeRow = {
  id: string;
  compileSelectCount: number;
  dynamicScore: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastCompiledAt: Date | null;
};

type AggregateRow = {
  itemId: string;
  totalCount: number;
  recentCount30d: number;
  lastCompiledAt: Date | null;
};

function asNonNegativeInteger(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(num));
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      if (arg === "--limit") index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function fetchKnowledgeRows(limit?: number): Promise<KnowledgeRow[]> {
  const db = getDb();
  const query = db
    .select({
      id: knowledgeItems.id,
      compileSelectCount: knowledgeItems.compileSelectCount,
      dynamicScore: knowledgeItems.dynamicScore,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
    })
    .from(knowledgeItems)
    .orderBy(desc(knowledgeItems.updatedAt));

  const rows = limit !== undefined ? await query.limit(limit) : await query;
  return rows.map((row) => ({
    id: row.id,
    compileSelectCount: asNonNegativeInteger(row.compileSelectCount),
    dynamicScore: Math.max(0, asFiniteNumber(row.dynamicScore, 0)),
    agenticAcceptCount: asNonNegativeInteger(row.agenticAcceptCount),
    explicitUpvoteCount: asNonNegativeInteger(row.explicitUpvoteCount),
    explicitDownvoteCount: asNonNegativeInteger(row.explicitDownvoteCount),
    lastCompiledAt: row.lastCompiledAt,
  }));
}

async function fetchAggregates(knowledgeIds: string[]): Promise<Map<string, AggregateRow>> {
  if (knowledgeIds.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      itemId: contextPackItems.itemId,
      totalCount: sql<number>`count(*)::int`,
      recentCount30d: sql<number>`count(*) filter (where ${contextPackItems.createdAt} >= now() - (30 * interval '1 day'))::int`,
      lastCompiledAt: sql<Date | null>`max(${contextPackItems.createdAt})`,
    })
    .from(contextPackItems)
    .where(
      and(
        inArray(contextPackItems.itemId, knowledgeIds),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
      ),
    )
    .groupBy(contextPackItems.itemId);

  const aggregateMap = new Map<string, AggregateRow>();
  for (const row of rows) {
    aggregateMap.set(row.itemId, {
      itemId: row.itemId,
      totalCount: asNonNegativeInteger(row.totalCount),
      recentCount30d: asNonNegativeInteger(row.recentCount30d),
      lastCompiledAt: asDate(row.lastCompiledAt),
    });
  }
  return aggregateMap;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const knowledgeRows = await fetchKnowledgeRows(options.limit);
  const knowledgeIds = knowledgeRows.map((row) => row.id);
  const aggregates = await fetchAggregates(knowledgeIds);
  const db = getDb();

  let changedCount = 0;
  let updatedCount = 0;
  let ignoredCount = 0;
  const changedPreview: string[] = [];

  for (const row of knowledgeRows) {
    const aggregate = aggregates.get(row.id);
    if (!aggregate) {
      ignoredCount += 1;
      continue;
    }

    const nextCompileSelectCount = aggregate.totalCount;
    const nextDynamicScore = computeDynamicScore({
      compileSelectCount: nextCompileSelectCount,
      recentSelectCount30d: aggregate.recentCount30d,
      agenticAcceptCount: row.agenticAcceptCount,
      explicitUpvoteCount: row.explicitUpvoteCount,
      explicitDownvoteCount: row.explicitDownvoteCount,
    });

    const hasChanged =
      nextCompileSelectCount !== row.compileSelectCount ||
      Math.abs(nextDynamicScore - row.dynamicScore) > 0.0001 ||
      !isSameTimestamp(aggregate.lastCompiledAt, row.lastCompiledAt);
    if (!hasChanged) {
      ignoredCount += 1;
      continue;
    }

    changedCount += 1;
    if (changedPreview.length < 20) changedPreview.push(row.id);
    if (!options.apply) continue;

    await db
      .update(knowledgeItems)
      .set({
        compileSelectCount: nextCompileSelectCount,
        lastCompiledAt: aggregate.lastCompiledAt,
        dynamicScore: nextDynamicScore,
      })
      .where(eq(knowledgeItems.id, row.id));
    updatedCount += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: !options.apply,
        scannedCount: knowledgeRows.length,
        changedCount,
        updatedCount,
        ignoredCount,
        changedIdPreview: changedPreview,
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
function isSameTimestamp(left: Date | null, right: Date | null): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.getTime() === right.getTime();
}
