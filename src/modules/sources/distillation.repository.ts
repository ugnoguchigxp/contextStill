import crypto from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import {
  knowledgeSourceLinks,
  sourceDistillationEvidence,
  sourceDistillationRuns,
  sourceFragments,
  sources,
  syncStates,
} from "../../db/schema.js";
import type { DistillationToolResult } from "../distillation/distillation-tools.service.js";

export type SourceFragmentForDistillation = {
  id: string;
  sourceId: string;
  sourceKind: "wiki";
  sourceUri: string;
  sourceTitle: string | null;
  sourceContentHash: string;
  locator: string;
  heading: string | null;
  content: string;
  metadata: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
  createdAt: Date;
};

export type SourceDistillationStatus = "ok" | "skipped" | "failed";

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listSourceFragmentsForDistillation(params: {
  limit: number;
  promptVersion: string;
  includeProcessed?: boolean;
  sourceKind?: "wiki";
  uri?: string;
}): Promise<SourceFragmentForDistillation[]> {
  const processedFilter = params.includeProcessed
    ? sql`true`
    : sql`
      not exists (
        select 1
        from ${sourceDistillationRuns}
        where ${sourceDistillationRuns.sourceFragmentId} = ${sourceFragments.id}
          and ${sourceDistillationRuns.promptVersion} = ${params.promptVersion}
          and ${sourceDistillationRuns.status} in ('ok', 'skipped')
      )
      and not exists (
        select 1
        from ${sourceDistillationRuns}
        where ${sourceDistillationRuns.sourceFragmentId} = ${sourceFragments.id}
          and ${sourceDistillationRuns.promptVersion} = ${params.promptVersion}
          and ${sourceDistillationRuns.status} = 'failed'
          and ${sourceDistillationRuns.updatedAt} > now() - (${config.distillationFailureRetryDelaySeconds} * interval '1 second')
      )
    `;
  const rows = await db
    .select({
      id: sourceFragments.id,
      sourceId: sourceFragments.sourceId,
      sourceKind: sources.sourceKind,
      sourceUri: sources.uri,
      sourceTitle: sources.title,
      sourceContentHash: sources.contentHash,
      locator: sourceFragments.locator,
      heading: sourceFragments.heading,
      content: sourceFragments.content,
      metadata: sourceFragments.metadata,
      sourceMetadata: sources.metadata,
      createdAt: sourceFragments.createdAt,
    })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .where(
      and(
        params.sourceKind ? eq(sources.sourceKind, params.sourceKind) : undefined,
        params.uri ? eq(sources.uri, params.uri) : undefined,
        processedFilter,
      ),
    )
    .orderBy(
      asc(sources.updatedAt),
      asc(sources.id),
      asc(sourceFragments.createdAt),
      asc(sourceFragments.id),
    )
    .limit(params.limit);

  return rows.map((row) => ({
    id: row.id,
    sourceId: row.sourceId,
    sourceKind: row.sourceKind as "wiki",
    sourceUri: row.sourceUri,
    sourceTitle: row.sourceTitle,
    sourceContentHash: row.sourceContentHash,
    locator: row.locator,
    heading: row.heading,
    content: row.content,
    metadata: normalizeRecord(row.metadata),
    sourceMetadata: normalizeRecord(row.sourceMetadata),
    createdAt: row.createdAt,
  }));
}

export async function upsertSourceDistillationRun(params: {
  sourceFragmentId: string;
  status: SourceDistillationStatus;
  candidateCount: number;
  knowledgeIds: string[];
  error?: string | null;
  inputHash: string;
  promptVersion: string;
  model: string;
  toolEvents?: DistillationToolResult[];
  metadata?: Record<string, unknown>;
}) {
  const [run] = await db
    .insert(sourceDistillationRuns)
    .values({
      sourceFragmentId: params.sourceFragmentId,
      status: params.status,
      candidateCount: params.candidateCount,
      knowledgeIds: params.knowledgeIds,
      error: params.error ?? null,
      inputHash: params.inputHash,
      promptVersion: params.promptVersion,
      model: params.model,
      toolEvents: params.toolEvents ?? [],
      metadata: params.metadata ?? {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        sourceDistillationRuns.sourceFragmentId,
        sourceDistillationRuns.promptVersion,
        sourceDistillationRuns.inputHash,
      ],
      set: {
        status: params.status,
        candidateCount: params.candidateCount,
        knowledgeIds: params.knowledgeIds,
        error: params.error ?? null,
        model: params.model,
        toolEvents: params.toolEvents ?? [],
        metadata: params.metadata ?? {},
        updatedAt: new Date(),
      },
    })
    .returning();

  return run;
}

export async function recordSourceDistillationEvidence(params: {
  runId: string;
  toolEvents: DistillationToolResult[];
}): Promise<void> {
  await db
    .delete(sourceDistillationEvidence)
    .where(eq(sourceDistillationEvidence.runId, params.runId));
  if (params.toolEvents.length === 0) return;

  await db.insert(sourceDistillationEvidence).values(
    params.toolEvents.map((event) => {
      const metadata = normalizeRecord(event.metadata);
      const url =
        typeof metadata.url === "string"
          ? metadata.url
          : typeof metadata.finalUrl === "string"
            ? metadata.finalUrl
            : null;
      return {
        runId: params.runId,
        toolName: event.name,
        url,
        ok: event.ok ? 1 : 0,
        contentHash: crypto.createHash("sha256").update(event.content).digest("hex"),
        metadata: {
          ...metadata,
          error: event.error,
        },
      };
    }),
  );
}

export async function linkKnowledgeToSourceFragment(params: {
  knowledgeId: string;
  sourceFragmentId: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const existing = await db.query.knowledgeSourceLinks.findFirst({
    where: and(
      eq(knowledgeSourceLinks.knowledgeId, params.knowledgeId),
      eq(knowledgeSourceLinks.sourceFragmentId, params.sourceFragmentId),
    ),
  });
  if (existing) return;
  await db.insert(knowledgeSourceLinks).values({
    knowledgeId: params.knowledgeId,
    sourceFragmentId: params.sourceFragmentId,
    linkType: "derived_from",
    confidence: params.confidence,
    metadata: params.metadata ?? {},
  });
}

export async function recordSourceDistillationState(params: {
  ok: boolean;
  apply: boolean;
  model: string;
  promptVersion: string;
  processed: number;
  skipped: number;
  failed: number;
  knowledgeCount: number;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(syncStates)
    .values({
      id: "source_distillation",
      lastSyncedAt: now,
      cursor: {},
      metadata: params,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: syncStates.id,
      set: {
        lastSyncedAt: now,
        cursor: {},
        metadata: params,
        updatedAt: now,
      },
    });
}
