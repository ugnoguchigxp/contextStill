import crypto from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { distillationEvidenceCache } from "../../db/schema.js";

export type DistillationEvidenceCacheRow = typeof distillationEvidenceCache.$inferSelect;

export function evidenceCacheKey(value: string): string {
  return crypto.createHash("sha256").update(value.trim()).digest("hex");
}

export async function findDistillationEvidenceCache(params: {
  toolName: string;
  queryHash: string;
  url?: string | null;
  freshAfter: Date;
}): Promise<DistillationEvidenceCacheRow | null> {
  const [row] = await db
    .select()
    .from(distillationEvidenceCache)
    .where(
      and(
        eq(distillationEvidenceCache.toolName, params.toolName),
        eq(distillationEvidenceCache.queryHash, params.queryHash),
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
  queryHash: string;
  queryText?: string | null;
  url?: string | null;
  contentHash?: string | null;
  ok: boolean;
  excerpt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(distillationEvidenceCache)
    .values({
      toolName: params.toolName,
      queryHash: params.queryHash,
      queryText: params.queryText ?? null,
      url: params.url ?? "",
      contentHash: params.contentHash ?? null,
      ok: params.ok ? 1 : 0,
      excerpt: params.excerpt ?? null,
      metadata: params.metadata ?? {},
      fetchedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        distillationEvidenceCache.toolName,
        distillationEvidenceCache.queryHash,
        distillationEvidenceCache.url,
      ],
      set: {
        queryText: params.queryText ?? null,
        contentHash: params.contentHash ?? null,
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

export function contentHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
