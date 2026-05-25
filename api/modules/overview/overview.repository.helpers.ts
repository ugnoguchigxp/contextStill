import { groupedConfig } from "../../../src/config.js";
import { deriveSearchProviderCooldownUntil } from "../../../src/modules/distillation/search-rate-limit.js";
import { buildLandscapeReplayComparison } from "../../../src/modules/landscape/landscape-replay-comparison.service.js";
import { buildLandscapeSnapshot } from "../../../src/modules/landscape/landscape.service.js";
import { ensureContentRoot, listPages } from "../../../src/modules/sources/wiki/content-repo.js";
import type {
  OverviewDashboard,
  OverviewKnowledgeAssetsDomain,
  OverviewLandscapeHealthDomain,
  OverviewSystemQualityDomain,
} from "../../../src/shared/schemas/overview.schema.js";

const LANDSCAPE_OVERVIEW_WINDOW_DAYS = 30;
const LANDSCAPE_OVERVIEW_LIMIT = 1000;
const LANDSCAPE_OVERVIEW_REPLAY_LIMIT = 20;
const LANDSCAPE_OVERVIEW_CURRENT_LIMIT = 12;
const KNOWLEDGE_STATUS_ORDER = ["active", "draft", "deprecated"] as const;
const DISTILLATION_TARGET_KIND_ORDER = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
] as const;
type SearchRateLimitInput = Parameters<typeof deriveSearchProviderCooldownUntil>[0];

export const OVERVIEW_DAY_RANGE = 14;
export const LLM_KPI_DAY_RANGE = 30;
export const DASHBOARD_TIMEZONE = "Asia/Tokyo";

export function toNumber(value: unknown, fallback = 0): number {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : fallback;
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function checkedAt(): string {
  return new Date().toISOString();
}

export function latestCheckedAt(values: string[]): string {
  const latest = values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  return latest === undefined ? checkedAt() : new Date(latest).toISOString();
}

export async function countWikiPages(): Promise<number> {
  await ensureContentRoot(groupedConfig.sourceContent.root);
  return (await listPages(groupedConfig.sourceContent.root)).length;
}

function isRateLimitedStatus(value: unknown): boolean {
  if (typeof value === "number") {
    return value === 429;
  }
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "429" || normalized === "cooldown" || normalized === "rate_limited";
}

function hasUnknownCooldownSignal(entry: Record<string, unknown>): boolean {
  const lastRateLimit = isRecord(entry.lastRateLimit) ? entry.lastRateLimit : {};
  const lastError = stringValue(entry.lastError)?.toLowerCase() ?? "";
  return (
    isRateLimitedStatus(entry.status) ||
    isRateLimitedStatus(lastRateLimit.status) ||
    lastError.includes("429") ||
    lastError.includes("rate limit") ||
    lastError.includes("rate-limit")
  );
}

function isoDateTimeValue(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function latestFutureIso(values: Array<string | null>, now: number): string | null {
  const futureTimes = values
    .flatMap((value) => {
      if (!value) return [];
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && parsed > now ? [parsed] : [];
    })
    .sort((a, b) => b - a);
  return futureTimes[0] ? new Date(futureTimes[0]).toISOString() : null;
}

export function buildCommunitySourceCoverage(
  communities: Array<{
    sourceRefCount: number;
    health: { thinEvidence: boolean };
  }>,
): Pick<
  OverviewKnowledgeAssetsDomain["kpis"],
  | "sourceCommunities"
  | "sourceCoveredCommunities"
  | "sourceThinCommunities"
  | "sourceMissingCommunities"
> {
  let sourceCoveredCommunities = 0;
  let sourceThinCommunities = 0;
  let sourceMissingCommunities = 0;

  for (const community of communities) {
    if (community.sourceRefCount <= 0) {
      sourceMissingCommunities += 1;
      continue;
    }
    if (community.health.thinEvidence) {
      sourceThinCommunities += 1;
      continue;
    }
    sourceCoveredCommunities += 1;
  }

  return {
    sourceCommunities: communities.length,
    sourceCoveredCommunities,
    sourceThinCommunities,
    sourceMissingCommunities,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Landscape summary could not be loaded.";
}

export async function buildOverviewLandscapeSummary(): Promise<
  OverviewLandscapeHealthDomain["landscape"]
> {
  try {
    const [snapshot, replay] = await Promise.all([
      buildLandscapeSnapshot({
        windowDays: LANDSCAPE_OVERVIEW_WINDOW_DAYS,
        limit: LANDSCAPE_OVERVIEW_LIMIT,
        status: "active",
        relationAxes: ["session", "project", "source"],
        minSelectedCount: 3,
        minFeedbackCount: 3,
      }),
      buildLandscapeReplayComparison({
        windowDays: LANDSCAPE_OVERVIEW_WINDOW_DAYS,
        limit: LANDSCAPE_OVERVIEW_REPLAY_LIMIT,
        runStatus: "all",
        currentLimit: LANDSCAPE_OVERVIEW_CURRENT_LIMIT,
        includeRuns: false,
      }),
    ]);

    return {
      status: "ok",
      windowDays: LANDSCAPE_OVERVIEW_WINDOW_DAYS,
      generatedAt: replay.generatedAt,
      snapshot: {
        totalCommunities: snapshot.stats.totalCommunities,
        strongAttractorCount: snapshot.stats.strongAttractorCount,
        usefulAttractorCount: snapshot.stats.usefulAttractorCount,
        negativeCandidateCount: snapshot.stats.negativeCandidateCount,
        overSelectedNotUsedCount: snapshot.stats.overSelectedNotUsedCount,
        deadZoneReachabilityCount: snapshot.stats.deadZoneReachabilityCount,
        deadZoneStaleCount: snapshot.stats.deadZoneStaleCount,
        feedbackInsufficientCount: snapshot.stats.insufficientFeedbackCommunities,
        topRiskCount: snapshot.risks.length,
      },
      replay: {
        comparedRunCount: replay.comparedRunCount,
        averageOverlapRate: replay.averageOverlapRate,
        retainedItemCount: replay.retainedItemCount,
        missingFromCurrentItemCount: replay.missingFromCurrentItemCount,
        newlyRetrievedItemCount: replay.newlyRetrievedItemCount,
        usedBaselineLostItemCount: replay.usedBaselineLostItemCount,
        highChurnRunCount: replay.scoreTuning.highChurnRunCount,
        currentNoMatchRunCount: replay.currentNoMatchRunCount,
        promotionGateMode: replay.promotionGateSummary.gateMode,
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      windowDays: LANDSCAPE_OVERVIEW_WINDOW_DAYS,
      error: errorMessage(error),
    };
  }
}

export function normalizeSearchApiStatus(
  metadata: unknown,
): OverviewSystemQualityDomain["searchApiStatus"] {
  const root = isRecord(metadata)
    ? isRecord(metadata.providers)
      ? metadata.providers
      : metadata
    : {};
  const now = Date.now();

  const normalizeProvider = (provider: "brave" | "exa") => {
    const entry = isRecord(root[provider]) ? root[provider] : {};
    const storedCooldownUntil = isoDateTimeValue(entry.cooldownUntil);
    const rateLimitCooldownUntil = deriveSearchProviderCooldownUntil({
      provider: provider as SearchRateLimitInput["provider"],
      rateLimit: isRecord(entry.lastRateLimit)
        ? (entry.lastRateLimit as SearchRateLimitInput["rateLimit"])
        : undefined,
      updatedAt: isoDateTimeValue(entry.updatedAt),
      nowMs: now,
    });
    const cooldownUntil = latestFutureIso([storedCooldownUntil, rateLimitCooldownUntil], now);
    const cooldownActive = cooldownUntil !== null || hasUnknownCooldownSignal(entry);
    return {
      status: cooldownActive ? ("cooldown" as const) : ("ok" as const),
      cooldownUntil: cooldownActive ? cooldownUntil : null,
      lastError: stringValue(entry.lastError),
    };
  };

  return {
    brave: normalizeProvider("brave"),
    exa: normalizeProvider("exa"),
  };
}

export function buildKnowledgeStatusTypeChart(
  rows: Array<Record<string, unknown>>,
): OverviewKnowledgeAssetsDomain["charts"]["knowledgeByStatusType"] {
  const statusTypeMap = new Map<string, { rule: number; procedure: number }>();
  for (const status of KNOWLEDGE_STATUS_ORDER) {
    statusTypeMap.set(status, { rule: 0, procedure: 0 });
  }
  for (const row of rows) {
    const status = typeof row.status === "string" ? row.status : "";
    const type = typeof row.type === "string" ? row.type : "";
    if (!statusTypeMap.has(status)) continue;
    const counts = statusTypeMap.get(status);
    if (!counts) continue;
    if (type === "rule") counts.rule = toNumber(row.item_count);
    if (type === "procedure") counts.procedure = toNumber(row.item_count);
  }

  return KNOWLEDGE_STATUS_ORDER.map((status) => ({
    status,
    rule: statusTypeMap.get(status)?.rule ?? 0,
    procedure: statusTypeMap.get(status)?.procedure ?? 0,
  }));
}

export function buildDistillationQueueChart(
  rows: Array<Record<string, unknown>>,
): OverviewSystemQualityDomain["charts"]["distillationQueue"] {
  const distillationQueueMap = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const targetKind = typeof row.target_kind === "string" ? row.target_kind : "";
    if (!targetKind) continue;
    distillationQueueMap.set(targetKind, row);
  }

  return DISTILLATION_TARGET_KIND_ORDER.map((targetKind) => {
    const row = distillationQueueMap.get(targetKind);
    return {
      targetKind,
      pending: toNumber(row?.pending),
      running: toNumber(row?.running),
      paused: toNumber(row?.paused),
      completed: toNumber(row?.completed),
      failed: toNumber(row?.failed),
    };
  });
}
