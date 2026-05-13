import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { evidenceFragments, evidenceSources } from "../../db/schema.js";

export type EvidenceSearchResult = {
  id: string;
  sourceId: string;
  sourceUri: string;
  locator: string;
  content: string;
  score: number;
};

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function upsertEvidenceSource(params: {
  sourceKind: string;
  uri: string;
  title?: string;
  contentHash: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const existing = await db.query.evidenceSources.findFirst({
    where: and(
      eq(evidenceSources.uri, params.uri),
      eq(evidenceSources.contentHash, params.contentHash),
    ),
  });
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(evidenceSources)
    .values({
      sourceKind: params.sourceKind,
      uri: params.uri,
      title: params.title ?? null,
      contentHash: params.contentHash,
      metadata: params.metadata ?? {},
    })
    .returning({ id: evidenceSources.id });

  return inserted.id;
}

export async function insertEvidenceFragment(params: {
  sourceId: string;
  locator: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const [inserted] = await db
    .insert(evidenceFragments)
    .values({
      sourceId: params.sourceId,
      locator: params.locator,
      content: params.content,
      metadata: params.metadata ?? {},
    })
    .returning({ id: evidenceFragments.id });

  return inserted.id;
}

export async function searchEvidence(
  query: string,
  limit: number,
  sourceKinds?: Array<"markdown" | "session" | "tool_output" | "git" | "web" | "manual">,
): Promise<EvidenceSearchResult[]> {
  const rankExpr = sql<number>`
    ts_rank_cd(to_tsvector('simple', ${evidenceFragments.content}), plainto_tsquery('simple', ${query}))
  `;
  const textMatchExpr = sql<boolean>`
    to_tsvector('simple', ${evidenceFragments.content})
    @@ plainto_tsquery('simple', ${query})
  `;
  const conditions = [or(ilike(evidenceFragments.content, `%${query}%`), textMatchExpr)];
  if (sourceKinds && sourceKinds.length > 0) {
    conditions.push(inArray(evidenceSources.sourceKind, sourceKinds));
  }

  const rows = await db
    .select({
      id: evidenceFragments.id,
      sourceId: evidenceFragments.sourceId,
      sourceUri: evidenceSources.uri,
      locator: evidenceFragments.locator,
      content: evidenceFragments.content,
      score: rankExpr,
    })
    .from(evidenceFragments)
    .innerJoin(evidenceSources, eq(evidenceSources.id, evidenceFragments.sourceId))
    .where(and(...conditions))
    .orderBy(desc(rankExpr), desc(evidenceFragments.createdAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, score: finiteOrZero(row.score) }));
}
