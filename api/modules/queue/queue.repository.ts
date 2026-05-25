import { and, asc, count, desc, eq, gt, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { groupedConfig } from "../../../src/config.js";
import { db } from "../../../src/db/index.js";
import {
  distillationTargetStates,
  findCandidateResults,
  syncStates,
} from "../../../src/db/schema.js";
import { APP_CONSTANTS } from "../../../src/constants.js";
import {
  decideFindCandidateSchedule,
  type FindCandidateScheduleDecision,
} from "../../../src/modules/findCandidate/find-candidate-scheduler.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes,
  resolveFindCandidateRoute,
  resolveWebSourceResearchRoute,
} from "../../../src/modules/settings/settings.service.js";
import {
  resolveDistillationModel,
  resolveProviderForDistillation,
  type DistillationProviderName,
  type DistillationProviderSetting,
} from "../../../src/modules/distillation/llm-resolver.js";
import {
  findNextFindCandidateTargetState,
  pauseDistillationTargetState,
  requeueDistillationTargetState,
} from "../../../src/modules/selectDistillationTarget/repository.js";
import type {
  DistillationTargetKind,
  DistillationTargetStatus,
} from "../../../src/modules/selectDistillationTarget/domain.js";

const DEFAULT_VERSION = APP_CONSTANTS.distillationTargetVersion;
const FIND_CANDIDATE_TARGET_KINDS = ["web_ingest", "wiki_file", "vibe_memory"] as const;

type ProviderPressureStatus = "ok" | "cooldown";
type FindCandidateTargetKind = (typeof FIND_CANDIDATE_TARGET_KINDS)[number];
type QueueFindCandidateReason =
  | FindCandidateScheduleDecision["reason"]
  | "next_retry"
  | "no_target"
  | "running";

export type QueueFindCandidateStatus = {
  status: "ready" | "waiting" | "idle" | "running";
  waitMs: number;
  waitUntil: string | null;
  reason: QueueFindCandidateReason;
  targetKind: FindCandidateTargetKind | null;
  provider: string | null;
  model: string | null;
  source: "scheduler" | "target_retry" | "running" | "none";
  updatedAt: string;
  diagnostics: FindCandidateScheduleDecision["diagnostics"] | null;
};

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

type QueueTaskWithModel = typeof distillationTargetStates.$inferSelect & {
  activeModel: string | null;
  activeProvider: DistillationProviderName | null;
};

function asDistillationProviderSetting(value: unknown): DistillationProviderSetting {
  if (
    value === "openai" ||
    value === "azure-openai" ||
    value === "bedrock" ||
    value === "local-llm" ||
    value === "auto"
  ) {
    return value;
  }
  return "auto";
}

function resolveProviderModel(
  providerSetting: DistillationProviderSetting,
): { provider: DistillationProviderName; model: string | null } {
  const provider = resolveProviderForDistillation(providerSetting);
  const model = resolveDistillationModel(providerSetting).trim();
  return {
    provider,
    model: model || null,
  };
}

function dedupe(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function modelFromTaskMetadata(metadata: unknown): { model: string | null; provider: string | null } {
  const root = isRecord(metadata) ? metadata : {};
  const llmModel = stringValue(root.llmModel);
  const llmProvider = stringValue(root.llmProvider);
  if (llmModel) {
    return { model: llmModel, provider: llmProvider };
  }

  const scheduleDecision = isRecord(root.scheduleDecision) ? root.scheduleDecision : {};
  const scheduleModel = stringValue(scheduleDecision.model);
  const scheduleProvider = stringValue(scheduleDecision.provider);
  if (scheduleModel) {
    return { model: scheduleModel, provider: scheduleProvider };
  }

  const diagnostics = isRecord(scheduleDecision.diagnostics) ? scheduleDecision.diagnostics : {};
  const diagnosticsModel = stringValue(diagnostics.model);
  const diagnosticsProvider = stringValue(diagnostics.provider);
  if (diagnosticsModel) {
    return { model: diagnosticsModel, provider: diagnosticsProvider };
  }

  return { model: null, provider: null };
}

function findCandidateProviderModel(
  targetKind: DistillationTargetKind | string,
): { model: string | null; provider: DistillationProviderName | null } {
  if (
    targetKind !== "wiki_file" &&
    targetKind !== "vibe_memory" &&
    targetKind !== "web_ingest"
  ) {
    return { model: null, provider: null };
  }
  const route = resolveFindCandidateRoute(targetKind);
  const resolved = resolveProviderModel(asDistillationProviderSetting(route.provider));
  return {
    model: resolved.model,
    provider: resolved.provider,
  };
}

function webResearchProviderModel(): {
  model: string | null;
  provider: DistillationProviderName | null;
} {
  const route = resolveWebSourceResearchRoute();
  const resolved = resolveProviderModel(asDistillationProviderSetting(route.provider));
  return {
    model: resolved.model,
    provider: resolved.provider,
  };
}

function coverEvidenceProviderModel(): {
  model: string | null;
  provider: DistillationProviderName | null;
} {
  const routes = resolveCoverEvidenceRoutes();
  const resolvedRoutes = [
    resolveProviderModel(asDistillationProviderSetting(routes.sourceSupport.provider)),
    resolveProviderModel(asDistillationProviderSetting(routes.externalEvidence.provider)),
    resolveProviderModel(asDistillationProviderSetting(routes.mcpEvidence.provider)),
  ];
  const models = dedupe(resolvedRoutes.map((entry) => entry.model));
  const providers = dedupe(resolvedRoutes.map((entry) => entry.provider));
  return {
    model: models.length > 0 ? models.join(" | ") : null,
    provider:
      providers.length === 0
        ? null
        : providers.length === 1
          ? (providers[0] as DistillationProviderName)
          : null,
  };
}

function finalizeProviderModel(): {
  model: string | null;
  provider: DistillationProviderName | null;
} {
  const resolved = resolveProviderModel(groupedConfig.distillation.provider);
  return {
    model: resolved.model,
    provider: resolved.provider,
  };
}

function activeProviderModelForTask(task: typeof distillationTargetStates.$inferSelect): {
  model: string | null;
  provider: DistillationProviderName | null;
} {
  const metadataModel = modelFromTaskMetadata(task.metadata);
  if (metadataModel.model) {
    return {
      model: metadataModel.model,
      provider:
        metadataModel.provider === "openai" ||
        metadataModel.provider === "azure-openai" ||
        metadataModel.provider === "bedrock" ||
        metadataModel.provider === "local-llm"
          ? metadataModel.provider
          : null,
    };
  }

  if (task.phase === "researching_source" || task.phase === "writing_source") {
    return webResearchProviderModel();
  }
  if (task.phase === "covering_evidence") {
    return coverEvidenceProviderModel();
  }
  if (task.phase === "finalizing") {
    return finalizeProviderModel();
  }
  return findCandidateProviderModel(task.targetKind);
}

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

function isFindCandidateTargetKind(value: unknown): value is FindCandidateTargetKind {
  return (
    typeof value === "string" &&
    FIND_CANDIDATE_TARGET_KINDS.includes(value as FindCandidateTargetKind)
  );
}

function normalizeFindCandidateReason(value: string | null): QueueFindCandidateReason {
  switch (value) {
    case "disabled":
    case "provider_cooldown":
    case "recent_interactive_compile":
    case "interactive_pressure":
    case "parallel_lane_busy":
    case "ready":
    case "running":
      return value;
    default:
      return value ? "next_retry" : "no_target";
  }
}

function throttledReasonFromPause(row: {
  lastError: string | null;
  metadata: unknown;
}): QueueFindCandidateReason {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const scheduleDecision = isRecord(metadata.scheduleDecision) ? metadata.scheduleDecision : {};
  const metadataReason = normalizeFindCandidateReason(stringValue(scheduleDecision.reason));
  if (metadataReason !== "no_target") return metadataReason;
  const prefix = "find_candidate_throttled:";
  const pauseReason = stringValue(row.lastError);
  if (pauseReason?.startsWith(prefix)) {
    return normalizeFindCandidateReason(pauseReason.slice(prefix.length));
  }
  return "next_retry";
}

async function fetchRunningFindCandidateTarget() {
  const [row] = await db
    .select({
      targetKind: distillationTargetStates.targetKind,
      updatedAt: distillationTargetStates.updatedAt,
    })
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION),
        inArray(distillationTargetStates.targetKind, [...FIND_CANDIDATE_TARGET_KINDS]),
        eq(distillationTargetStates.status, "running"),
        eq(distillationTargetStates.phase, "finding_candidate"),
      ),
    )
    .orderBy(desc(distillationTargetStates.updatedAt))
    .limit(1);

  return row ?? null;
}

async function fetchNextFindCandidateRetry(now: Date) {
  const [row] = await db
    .select({
      targetKind: distillationTargetStates.targetKind,
      nextRetryAt: distillationTargetStates.nextRetryAt,
      lastError: distillationTargetStates.lastError,
      metadata: distillationTargetStates.metadata,
      updatedAt: distillationTargetStates.updatedAt,
    })
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION),
        inArray(distillationTargetStates.targetKind, [...FIND_CANDIDATE_TARGET_KINDS]),
        eq(distillationTargetStates.status, "paused"),
        gt(distillationTargetStates.nextRetryAt, now),
        sql`${distillationTargetStates.lastError} like 'find_candidate_throttled:%'`,
        sql`not exists (
          select 1
          from ${findCandidateResults}
          where ${findCandidateResults.targetStateId} = ${distillationTargetStates.id}
        )`,
      ),
    )
    .orderBy(
      asc(distillationTargetStates.nextRetryAt),
      asc(distillationTargetStates.sortKey),
      asc(distillationTargetStates.createdAt),
      asc(distillationTargetStates.id),
    )
    .limit(1);

  return row ?? null;
}

async function fetchFindCandidateStatus(): Promise<QueueFindCandidateStatus> {
  await ensureRuntimeSettingsLoaded();
  const now = new Date();
  const updatedAt = now.toISOString();

  const runningTarget = await fetchRunningFindCandidateTarget();
  if (runningTarget && isFindCandidateTargetKind(runningTarget.targetKind)) {
    return {
      status: "running",
      waitMs: 0,
      waitUntil: null,
      reason: "running",
      targetKind: runningTarget.targetKind,
      provider: null,
      model: null,
      source: "running",
      updatedAt,
      diagnostics: null,
    };
  }

  const preview = await findNextFindCandidateTargetState({
    distillationVersion: DEFAULT_VERSION,
    targetKinds: [...FIND_CANDIDATE_TARGET_KINDS],
    now,
  });
  if (preview && isFindCandidateTargetKind(preview.targetKind)) {
    const decision = await decideFindCandidateSchedule({
      targetKind: preview.targetKind,
      includeJitter: false,
    });
    const waitMs = Math.max(0, Math.ceil(decision.waitMs));
    return {
      status: decision.shouldWait ? "waiting" : "ready",
      waitMs,
      waitUntil: decision.shouldWait ? new Date(now.getTime() + waitMs).toISOString() : null,
      reason: decision.reason,
      targetKind: preview.targetKind,
      provider: decision.diagnostics.provider,
      model: decision.diagnostics.model,
      source: "scheduler",
      updatedAt,
      diagnostics: decision.diagnostics,
    };
  }

  const retryTarget = await fetchNextFindCandidateRetry(now);
  if (
    retryTarget?.nextRetryAt &&
    retryTarget.targetKind &&
    isFindCandidateTargetKind(retryTarget.targetKind)
  ) {
    const retryAt = retryTarget.nextRetryAt;
    return {
      status: "waiting",
      waitMs: Math.max(0, retryAt.getTime() - now.getTime()),
      waitUntil: retryAt.toISOString(),
      reason: throttledReasonFromPause(retryTarget),
      targetKind: retryTarget.targetKind,
      provider: null,
      model: null,
      source: "target_retry",
      updatedAt,
      diagnostics: null,
    };
  }

  return {
    status: "idle",
    waitMs: 0,
    waitUntil: null,
    reason: "no_target",
    targetKind: null,
    provider: null,
    model: null,
    source: "none",
    updatedAt,
    diagnostics: null,
  };
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
  const [stats, kinds, azureOpenai, findCandidate] = await Promise.all([
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
    fetchFindCandidateStatus(),
  ]);

  return {
    maxAttempts: APP_CONSTANTS.distillationTargetMaxAttempts,
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
    findCandidate,
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
  await ensureRuntimeSettingsLoaded();
  const rows = await db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION),
        eq(distillationTargetStates.status, "running"),
      ),
    )
    .orderBy(desc(distillationTargetStates.lockedAt));

  return rows.map((row) => {
    const active = activeProviderModelForTask(row);
    return {
      ...row,
      activeModel: active.model,
      activeProvider: active.provider,
    } satisfies QueueTaskWithModel;
  });
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
    resetAttemptCount: false,
    maxAttempts: APP_CONSTANTS.distillationTargetMaxAttempts,
  });
}
