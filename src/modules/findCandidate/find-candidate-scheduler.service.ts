import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/client.js";
import { contextCompileRuns, llmUsageLogs } from "../../db/schema.js";
import {
  resolveDistillationModel,
  resolveProviderForDistillation,
  type DistillationProviderName,
  type DistillationProviderSetting,
} from "../distillation/llm-resolver.js";
import {
  jitterMs,
  readProviderPressureState,
  resolveFindCandidateThrottleSeconds,
} from "../llm/provider-pressure.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveFindCandidateRoute,
} from "../settings/settings.service.js";

type FindCandidateTargetKind = "wiki_file" | "vibe_memory" | "web_ingest";

export type FindCandidateScheduleDecision = {
  shouldWait: boolean;
  waitMs: number;
  reason:
    | "disabled"
    | "provider_cooldown"
    | "recent_interactive_compile"
    | "interactive_pressure"
    | "ready";
  diagnostics: {
    provider: DistillationProviderName;
    model: string;
    compileCount: number;
    interactiveLlmCount: number;
    lastCompileAgeSeconds: number | null;
    lastBackgroundAgeSeconds: number | null;
  };
};

function parseIsoAgeSeconds(value: string | null): number | null {
  if (!value) return null;
  const parsedMs = Date.parse(value);
  if (!Number.isFinite(parsedMs)) return null;
  return Math.max(0, Math.floor((Date.now() - parsedMs) / 1000));
}

function asNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

async function collectInteractiveStats(params: {
  provider: DistillationProviderName;
  windowSeconds: number;
}): Promise<{
  compileCount: number;
  interactiveLlmCount: number;
  lastCompileAgeSeconds: number | null;
}> {
  const since = new Date(Date.now() - params.windowSeconds * 1000);
  const [compileRow] = await db
    .select({
      count: sql<number>`count(*)::int`,
      lastCreatedAt: sql<Date | null>`max(${contextCompileRuns.createdAt})`,
    })
    .from(contextCompileRuns)
    .where(gte(contextCompileRuns.createdAt, since));

  const [usageRow] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(llmUsageLogs)
    .where(
      and(
        gte(llmUsageLogs.createdAt, since),
        eq(llmUsageLogs.provider, params.provider),
        inArray(llmUsageLogs.source, ["context-compiler", "context-response-composer"]),
      ),
    );

  const lastCompileAgeSeconds = compileRow?.lastCreatedAt
    ? Math.max(0, Math.floor((Date.now() - compileRow.lastCreatedAt.getTime()) / 1000))
    : null;

  return {
    compileCount: asNonNegativeInt(Number(compileRow?.count ?? 0)),
    interactiveLlmCount: asNonNegativeInt(Number(usageRow?.count ?? 0)),
    lastCompileAgeSeconds,
  };
}

function resolveProviderAndModel(params: {
  targetKind: FindCandidateTargetKind;
  providerOverride?: DistillationProviderSetting;
}): { provider: DistillationProviderName; model: string } {
  const routeProvider =
    params.providerOverride ?? resolveFindCandidateRoute(params.targetKind).provider;
  const provider = resolveProviderForDistillation(routeProvider);
  const model = resolveDistillationModel(routeProvider);
  return { provider, model };
}

export async function decideFindCandidateSchedule(params: {
  targetKind: FindCandidateTargetKind;
  providerOverride?: DistillationProviderSetting;
}): Promise<FindCandidateScheduleDecision> {
  await ensureRuntimeSettingsLoaded();
  const throttlingEnabled = groupedConfig.distillation.findCandidateBackgroundEnabled;
  const resolved = resolveProviderAndModel(params);
  const pressure = await readProviderPressureState(resolved);
  const lastBackgroundAgeSeconds = parseIsoAgeSeconds(pressure.metadata.lastBackgroundAt);

  const baseDiagnostics = {
    provider: resolved.provider,
    model: resolved.model,
    compileCount: 0,
    interactiveLlmCount: 0,
    lastCompileAgeSeconds: null,
    lastBackgroundAgeSeconds,
  };

  if (!throttlingEnabled) {
    return {
      shouldWait: true,
      waitMs: Math.max(1, groupedConfig.distillation.findCandidateMinIntervalSeconds) * 1000,
      reason: "disabled",
      diagnostics: baseDiagnostics,
    };
  }

  if (pressure.cooldownActive) {
    return {
      shouldWait: true,
      waitMs: pressure.waitMs + jitterMs(),
      reason: "provider_cooldown",
      diagnostics: baseDiagnostics,
    };
  }

  const stats = await collectInteractiveStats({
    provider: resolved.provider,
    windowSeconds: groupedConfig.distillation.findCandidateInteractiveWindowSeconds,
  });

  if (
    typeof stats.lastCompileAgeSeconds === "number" &&
    stats.lastCompileAgeSeconds < groupedConfig.distillation.findCandidateRecentBlockSeconds
  ) {
    return {
      shouldWait: true,
      waitMs:
        (groupedConfig.distillation.findCandidateRecentBlockSeconds - stats.lastCompileAgeSeconds) *
          1000 +
        jitterMs(),
      reason: "recent_interactive_compile",
      diagnostics: {
        ...baseDiagnostics,
        ...stats,
        lastBackgroundAgeSeconds,
      },
    };
  }

  const intervalSeconds = resolveFindCandidateThrottleSeconds({
    compileCount: stats.compileCount,
    interactiveLlmCount: stats.interactiveLlmCount,
  });
  const elapsedSinceBackgroundSeconds = lastBackgroundAgeSeconds ?? Number.POSITIVE_INFINITY;
  const waitSeconds = Math.max(0, intervalSeconds - elapsedSinceBackgroundSeconds);
  if (waitSeconds > 0) {
    return {
      shouldWait: true,
      waitMs: waitSeconds * 1000 + jitterMs(),
      reason: "interactive_pressure",
      diagnostics: {
        ...baseDiagnostics,
        ...stats,
        lastBackgroundAgeSeconds,
      },
    };
  }

  return {
    shouldWait: false,
    waitMs: 0,
    reason: "ready",
    diagnostics: {
      ...baseDiagnostics,
      ...stats,
      lastBackgroundAgeSeconds,
    },
  };
}
