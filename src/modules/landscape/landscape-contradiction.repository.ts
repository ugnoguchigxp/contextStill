import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contextCompileRuns, contextPackItems, knowledgeItems } from "../../db/schema.js";

export type LandscapeContradictionKnowledgeRow = {
  id: string;
  type: "rule" | "procedure";
  status: "active" | "deprecated";
  title: string;
  body: string;
  appliesTo: unknown;
  compileSelectCount: number;
  dynamicScore: number;
  lastCompiledAt: Date | null;
  updatedAt: Date;
};

function finite(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function contradictionPairKey(leftKnowledgeId: string, rightKnowledgeId: string): string {
  return leftKnowledgeId < rightKnowledgeId
    ? `${leftKnowledgeId}::${rightKnowledgeId}`
    : `${rightKnowledgeId}::${leftKnowledgeId}`;
}

export async function loadContradictionKnowledgeRows(limit: number) {
  const rows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      appliesTo: knowledgeItems.appliesTo,
      compileSelectCount: knowledgeItems.compileSelectCount,
      dynamicScore: knowledgeItems.dynamicScore,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
      updatedAt: knowledgeItems.updatedAt,
    })
    .from(knowledgeItems)
    .where(
      and(
        inArray(knowledgeItems.type, ["rule", "procedure"]),
        inArray(knowledgeItems.status, ["active", "deprecated"]),
      ),
    )
    .orderBy(
      desc(knowledgeItems.compileSelectCount),
      desc(knowledgeItems.dynamicScore),
      desc(knowledgeItems.lastCompiledAt),
      desc(knowledgeItems.updatedAt),
    )
    .limit(limit);

  return rows.filter(
    (row): row is LandscapeContradictionKnowledgeRow =>
      (row.type === "rule" || row.type === "procedure") &&
      (row.status === "active" || row.status === "deprecated"),
  );
}

export async function loadRecentSelectionCountByKnowledgeId(params: {
  knowledgeIds: string[];
  windowDays: number;
}): Promise<Map<string, number>> {
  const knowledgeIds = [...new Set(params.knowledgeIds.filter((id) => id.trim().length > 0))];
  if (knowledgeIds.length === 0) return new Map();

  const since = new Date(Date.now() - params.windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      itemId: contextPackItems.itemId,
      count: sql<number>`count(*)::int`,
    })
    .from(contextPackItems)
    .innerJoin(contextCompileRuns, eq(contextCompileRuns.id, contextPackItems.runId))
    .where(
      and(
        inArray(contextPackItems.itemId, knowledgeIds),
        gte(contextCompileRuns.createdAt, since),
        sql`${contextPackItems.itemKind} IN ('rule', 'procedure')`,
      ),
    )
    .groupBy(contextPackItems.itemId);

  return new Map(rows.map((row) => [row.itemId, finite(row.count)] as const));
}

export async function loadSemanticNeighborPairs(params: {
  knowledgeIds: string[];
  minSimilarity: number;
  maxPairs: number;
  topKPerKnowledge: number;
}): Promise<Map<string, number>> {
  const knowledgeIds = [...new Set(params.knowledgeIds.filter((id) => id.trim().length > 0))];
  if (knowledgeIds.length < 2) return new Map();

  const idsSql = sql.join(
    knowledgeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const fetchLimit = Math.max(
    params.maxPairs * 3,
    knowledgeIds.length * params.topKPerKnowledge * 2,
  );

  const result = await db.execute(sql`
    select
      a.id::text as left_id,
      b.id::text as right_id,
      (1 - (a.embedding <=> b.embedding))::real as similarity
    from ${knowledgeItems} a
    join ${knowledgeItems} b on a.id < b.id
    where a.id in (${idsSql})
      and b.id in (${idsSql})
      and a.embedding is not null
      and b.embedding is not null
      and (1 - (a.embedding <=> b.embedding)) >= ${params.minSimilarity}
    order by similarity desc
    limit ${fetchLimit}
  `);

  const rows = result.rows as Array<{
    left_id: string;
    right_id: string;
    similarity: number | string;
  }>;

  const degree = new Map<string, number>();
  const pairByKey = new Map<string, number>();
  for (const row of rows) {
    const left = row.left_id;
    const right = row.right_id;
    if (!left || !right) continue;

    const leftDegree = degree.get(left) ?? 0;
    const rightDegree = degree.get(right) ?? 0;
    if (leftDegree >= params.topKPerKnowledge || rightDegree >= params.topKPerKnowledge) continue;

    const similarity = finite(row.similarity);
    if (!Number.isFinite(similarity) || similarity <= 0) continue;

    const pairKey = contradictionPairKey(left, right);
    if (pairByKey.has(pairKey)) continue;

    degree.set(left, leftDegree + 1);
    degree.set(right, rightDegree + 1);
    pairByKey.set(pairKey, similarity);
    if (pairByKey.size >= params.maxPairs) break;
  }

  return pairByKey;
}
