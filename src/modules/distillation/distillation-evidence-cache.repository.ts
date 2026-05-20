import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { distillationEvidenceCache } from "../../db/schema.js";

export type DistillationEvidenceCacheRow = typeof distillationEvidenceCache.$inferSelect;

export async function findDistillationEvidenceCache(params: {
  toolName: string;
  queryText: string;
  url?: string | null;
  freshAfter: Date;
}): Promise<DistillationEvidenceCacheRow | null> {
  const [row] = await db
    .select()
    .from(distillationEvidenceCache)
    .where(
      and(
        eq(distillationEvidenceCache.toolName, params.toolName),
        eq(distillationEvidenceCache.queryText, params.queryText),
        params.url
          ? eq(distillationEvidenceCache.url, params.url)
          : eq(distillationEvidenceCache.url, ""),
        gte(distillationEvidenceCache.fetchedAt, params.freshAfter),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function upsertDistillationEvidenceCache(params: {
  toolName: string;
  queryText: string;
  url?: string | null;
  ok: boolean;
  excerpt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(distillationEvidenceCache)
    .values({
      toolName: params.toolName,
      queryText: params.queryText,
      url: params.url ?? "",
      ok: params.ok ? 1 : 0,
      excerpt: params.excerpt ?? null,
      metadata: params.metadata ?? {},
      fetchedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        distillationEvidenceCache.toolName,
        distillationEvidenceCache.queryText,
        distillationEvidenceCache.url,
      ],
      set: {
        queryText: params.queryText,
        ok: params.ok ? 1 : 0,
        excerpt: params.excerpt ?? null,
        metadata: sql`${distillationEvidenceCache.metadata} || ${JSON.stringify(
          params.metadata ?? {},
        )}::jsonb` as never,
        fetchedAt: now,
        updatedAt: now,
      },
    });
}

export function evidenceCacheFreshAfter(ttlSeconds: number): Date {
  return new Date(Date.now() - ttlSeconds * 1000);
}
