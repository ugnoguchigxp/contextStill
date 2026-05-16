import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories, vibeMemoryDistillationRuns } from "../../db/schema.js";
import { syncStates } from "../../db/schema.js";
import type { DistillationToolResult } from "../distillation/distillation-tools.service.js";

export type VibeMemoryForDistillation = typeof vibeMemories.$inferSelect;
export type AgentDiffEntryForDistillation = typeof agentDiffEntries.$inferSelect;
export type VibeMemoryDistillationStatus = "ok" | "skipped" | "failed";

export async function listVibeMemoriesForDistillation(params: {
  limit: number;
  sessionId?: string;
  vibeMemoryIds?: string[];
  promptVersion: string;
  includeProcessed?: boolean;
}): Promise<VibeMemoryForDistillation[]> {
  const filters = [];

  if (params.sessionId) {
    filters.push(eq(vibeMemories.sessionId, params.sessionId));
  }
  if (params.vibeMemoryIds && params.vibeMemoryIds.length > 0) {
    filters.push(inArray(vibeMemories.id, params.vibeMemoryIds));
  }

  if (!params.includeProcessed) {
    filters.push(sql`not exists (
      select 1
      from ${vibeMemoryDistillationRuns}
      where ${vibeMemoryDistillationRuns.vibeMemoryId} = ${vibeMemories.id}
        and ${vibeMemoryDistillationRuns.promptVersion} = ${params.promptVersion}
        and ${vibeMemoryDistillationRuns.status} in ('ok', 'skipped')
    )`);
    filters.push(sql`not exists (
      select 1
      from ${vibeMemoryDistillationRuns}
      where ${vibeMemoryDistillationRuns.vibeMemoryId} = ${vibeMemories.id}
        and ${vibeMemoryDistillationRuns.promptVersion} = ${params.promptVersion}
        and ${vibeMemoryDistillationRuns.status} = 'failed'
      and ${vibeMemoryDistillationRuns.updatedAt} > now() - (${groupedConfig.distillationTools.failureRetryDelaySeconds} * interval '1 second')
    )`);
  }

  const estimatedInputSize = sql<number>`
    length(${vibeMemories.content}) + coalesce((
      select sum(length(${agentDiffEntries.diffHunk}))
      from ${agentDiffEntries}
      where ${agentDiffEntries.vibeMemoryId} = ${vibeMemories.id}
    ), 0)
  `;

  return db
    .select()
    .from(vibeMemories)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(estimatedInputSize), asc(vibeMemories.createdAt), asc(vibeMemories.id))
    .limit(params.limit);
}

export async function listAgentDiffEntriesForVibeMemories(
  vibeMemoryIds: string[],
): Promise<AgentDiffEntryForDistillation[]> {
  if (vibeMemoryIds.length === 0) return [];

  return db
    .select()
    .from(agentDiffEntries)
    .where(inArray(agentDiffEntries.vibeMemoryId, vibeMemoryIds))
    .orderBy(
      asc(agentDiffEntries.createdAt),
      asc(agentDiffEntries.filePath),
      asc(agentDiffEntries.id),
    );
}

export async function upsertVibeMemoryDistillationRun(params: {
  vibeMemoryId: string;
  status: VibeMemoryDistillationStatus;
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
    .insert(vibeMemoryDistillationRuns)
    .values({
      vibeMemoryId: params.vibeMemoryId,
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
        vibeMemoryDistillationRuns.vibeMemoryId,
        vibeMemoryDistillationRuns.promptVersion,
        vibeMemoryDistillationRuns.inputHash,
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

export async function recordVibeMemoryDistillationState(params: {
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
      id: "vibe_distillation",
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
