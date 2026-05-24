import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { groupedConfig } from "../../../src/config.js";
import { db } from "../../../src/db/index.js";
import { distillationTargetStates, syncStates } from "../../../src/db/schema.js";
import { APP_CONSTANTS } from "../../../src/constants.js";
import { ensureRuntimeSettingsLoaded } from "../../../src/modules/settings/settings.service.js";
import {
  pauseDistillationTargetState,
  requeueDistillationTargetState,
} from "../../../src/modules/selectDistillationTarget/repository.js";
import type {
  DistillationTargetKind,
  DistillationTargetStatus,
} from "../../../src/modules/selectDistillationTarget/domain.js";

const DEFAULT_VERSION = APP_CONSTANTS.distillationTargetVersion;

type ProviderPressureStatus = "ok" | "cooldown";

export type QueueProviderPressure = {
  azureOpenai: {
    provider: "azure-openai";
    model: string | null;
    status: ProviderPressureStatus;
    cooldownUntil: string | null;
    reason: string | null;
    source: string | null;
    lastRateLimitedAt: string | null;
    updatedAt: string | null;
  };
};

export type QueueListQuery = {
  page: number;
  limit: number;
  query?: string;
  targetKind?: DistillationTargetKind | "all";
  status?: DistillationTargetStatus | "all";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoDateTimeValue(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function modelFromPressureId(id: string): string | null {
  const prefix = "llm_provider_pressure:azure-openai:";
  if (!id.startsWith(prefix)) return null;
  const encoded = id.slice(prefix.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded || null;
  }
}

async function fetchAzureOpenAiPressure(): Promise<QueueProviderPressure["azureOpenai"]> {
  await ensureRuntimeSettingsLoaded();
  const configuredModel = groupedConfig.azureOpenAi.model.trim() || null;
  const pressureId = configuredModel
    ? `llm_provider_pressure:azure-openai:${encodeURIComponent(configuredModel.toLowerCase())}`
    : null;
  const [row] = await db
    .select({
      id: syncStates.id,
      metadata: syncStates.metadata,
      updatedAt: syncStates.updatedAt,
    })
    .from(syncStates)
    .where(
      pressureId
        ? eq(syncStates.id, pressureId)
        : sql`${syncStates.id} like 'llm_provider_pressure:azure-openai:%'`,
    )
    .orderBy(desc(syncStates.updatedAt))
    .limit(1);

  const metadata = isRecord(row?.metadata) ? row.metadata : {};
  const cooldownUntil = isoDateTimeValue(metadata.cooldownUntil);
  const cooldownActive = cooldownUntil !== null && Date.parse(cooldownUntil) > Date.now();
  return {
    provider: "azure-openai",
    model: row ? modelFromPressureId(row.id) : configuredModel,
    status: cooldownActive ? "cooldown" : "ok",
    cooldownUntil: cooldownActive ? cooldownUntil : null,
    reason: stringValue(metadata.reason),
    source: stringValue(metadata.source),
    lastRateLimitedAt: isoDateTimeValue(metadata.lastRateLimitedAt),
    updatedAt: isoDateTimeValue(metadata.updatedAt) ?? row?.updatedAt?.toISOString() ?? null,
  };
}

export async function fetchQueueDashboardStats() {
  const [stats, kinds, azureOpenai] = await Promise.all([
    db
      .select({
        status: distillationTargetStates.status,
        count: count(),
      })
      .from(distillationTargetStates)
      .where(eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION))
      .groupBy(distillationTargetStates.status),
    db
      .select({
        targetKind: distillationTargetStates.targetKind,
        count: count(),
      })
      .from(distillationTargetStates)
      .where(eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION))
      .groupBy(distillationTargetStates.targetKind),
    fetchAzureOpenAiPressure(),
  ]);

  return {
    stats: stats.reduce(
      (acc, curr) => {
        acc[curr.status] = Number(curr.count ?? 0);
        return acc;
      },
      {} as Record<string, number>,
    ),
    kinds: kinds.reduce(
      (acc, curr) => {
        acc[curr.targetKind] = Number(curr.count ?? 0);
        return acc;
      },
      {} as Record<string, number>,
    ),
    providerPressure: {
      azureOpenai,
    } satisfies QueueProviderPressure,
  };
}

export async function listQueueItems(params: QueueListQuery) {
  const page = Math.max(1, params.page);
  const limit = Math.max(1, Math.min(100, params.limit));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION)];

  if (params.targetKind && params.targetKind !== "all") {
    conditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }

  if (params.status && params.status !== "all") {
    conditions.push(eq(distillationTargetStates.status, params.status));
  }

  if (params.query?.trim()) {
    const term = `%${params.query.trim()}%`;
    const textMatch = or(
      ilike(distillationTargetStates.targetKey, term),
      ilike(distillationTargetStates.sourceUri, term),
    );
    if (textMatch) {
      conditions.push(textMatch);
    }
  }

  const whereClause =
    and(...conditions) ?? eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION);

  const [totalResult] = await db
    .select({ count: count() })
    .from(distillationTargetStates)
    .where(whereClause);

  const items = await db
    .select()
    .from(distillationTargetStates)
    .where(whereClause)
    .orderBy(
      // prioritize running and pending
      sql`case
        when ${distillationTargetStates.status} = 'running' then 0
        when ${distillationTargetStates.status} = 'pending' then 1
        when ${distillationTargetStates.status} = 'failed' then 2
        when ${distillationTargetStates.status} = 'paused' then 3
        else 4
      end asc`,
      desc(distillationTargetStates.updatedAt),
      desc(distillationTargetStates.createdAt),
    )
    .limit(limit)
    .offset(offset);

  return {
    items,
    total: Number(totalResult?.count ?? 0),
    page,
    limit,
  };
}

export async function fetchActiveTasks() {
  return db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION),
        eq(distillationTargetStates.status, "running"),
      ),
    )
    .orderBy(desc(distillationTargetStates.lockedAt));
}

export async function pauseTarget(id: string, reason: string) {
  return pauseDistillationTargetState({
    id,
    reason,
  });
}

export async function resumeTarget(id: string) {
  return requeueDistillationTargetState({
    id,
    reason: "resumed from control plane",
    allowCompleted: true,
  });
}
