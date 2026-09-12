import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backendKind: "postgres" as "postgres" | "sqlite",
  execute: vi.fn(),
  sqliteGet: vi.fn(),
  sqliteAll: vi.fn(),
  inspectCompileRuns: vi.fn(),
  buildGraphSnapshot: vi.fn(),
  buildLandscapeSnapshot: vi.fn(),
  buildLandscapeReplayComparison: vi.fn(),
  ensureContentRoot: vi.fn(),
  listPages: vi.fn(),
  ensureRuntimeSettingsLoaded: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: (...args: unknown[]) => mocks.execute(...args),
  },
  getDb: () => ({
    execute: (...args: unknown[]) => mocks.execute(...args),
  }),
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: () =>
    Promise.resolve({
      db: {
        query: (sql: string) => ({
          get: (...args: unknown[]) => mocks.sqliteGet(sql, ...args) ?? undefined,
          all: (...args: unknown[]) => mocks.sqliteAll(sql, ...args) ?? [],
        }),
      },
    }),
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: (...args: unknown[]) => mocks.ensureRuntimeSettingsLoaded(...args),
}));

vi.mock("../src/modules/doctor/inspectors/compile.inspector.js", () => ({
  inspectCompileRuns: (...args: unknown[]) => mocks.inspectCompileRuns(...args),
}));

vi.mock("../src/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: (...args: unknown[]) => mocks.buildGraphSnapshot(...args),
}));

vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: (...args: unknown[]) => mocks.buildGraphSnapshot(...args),
}));

vi.mock("../src/modules/landscape/landscape.service.js", () => ({
  buildLandscapeSnapshot: (...args: unknown[]) => mocks.buildLandscapeSnapshot(...args),
}));

vi.mock("../src/modules/landscape/landscape-replay-comparison.service.js", () => ({
  buildLandscapeReplayComparison: (...args: unknown[]) =>
    mocks.buildLandscapeReplayComparison(...args),
}));

vi.mock("../src/modules/sources/wiki/content-repo.js", () => ({
  ensureContentRoot: (...args: unknown[]) => mocks.ensureContentRoot(...args),
  listPages: (...args: unknown[]) => mocks.listPages(...args),
}));

import {
  buildCommunitySourceCoverage,
  buildKnowledgeStatusTypeChart,
  buildOverviewLandscapeSummary,
  countWikiPages,
  latestCheckedAt,
  normalizeOverviewTimezone,
  sqliteTimezoneModifier,
  stringValue,
  toNullableNumber,
  toNumber,
} from "../api/modules/overview/overview.repository.helpers.js";
import {
  fetchOverviewDashboardForApi,
  fetchOverviewDomainForApi,
  fetchOverviewKnowledgeAssetsDomainForApi,
  fetchOverviewLandscapeHealthDomainForApi,
  fetchOverviewLlmResourcesDomainForApi,
  fetchOverviewSystemQualityDomainForApi,
  normalizeSearchApiStatus,
} from "../api/modules/overview/overview.repository.js";

function queryText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => queryText(item, depth + 1)).join(" ");
  if (!value || typeof value !== "object") return "";
  try {
    return `${JSON.stringify(value)} ${Object.values(value as Record<string, unknown>)
      .map((item) => queryText(item, depth + 1))
      .join(" ")}`;
  } catch {
    return Object.values(value as Record<string, unknown>)
      .map((item) => queryText(item, depth + 1))
      .join(" ");
  }
}

const compileRunHealth = {
  windowSize: 20,
  totalRuns: 4,
  degradedRuns: 1,
  degradedRate: 0.25,
  durationMsP50: 10,
  durationMsP95: 20,
  durationMsAvg: 12,
  durationSamples: [],
  lastRunAt: "2026-05-20T00:00:00.000Z",
  lastRunAgeMinutes: 5,
  freshnessThresholdMinutes: 60,
  degradedRateThreshold: 0.3,
};

const graphSnapshot = {
  communities: [
    {
      sourceRefCount: 3,
      compileSelectCount: 5,
      health: { thinEvidence: false, dead: false, stale: false },
    },
    {
      sourceRefCount: 1,
      compileSelectCount: 1,
      health: { thinEvidence: true, dead: false, stale: false },
    },
    {
      sourceRefCount: 0,
      compileSelectCount: 0,
      health: { thinEvidence: false, dead: true, stale: true },
    },
  ],
  stats: {
    visibleKnowledgeCount: 9,
    relationEdgeCount: 4,
    embeddedKnowledgeCount: 3,
    sessionEdgeCount: 1,
    projectEdgeCount: 1,
    sourceEdgeCount: 2,
  },
};

const landscapeSnapshot = {
  stats: {
    totalCommunities: 3,
    strongAttractorCount: 1,
    usefulAttractorCount: 1,
    negativeCandidateCount: 0,
    overSelectedNotUsedCount: 0,
    deadZoneReachabilityCount: 1,
    deadZoneStaleCount: 0,
    insufficientFeedbackCommunities: 1,
  },
  risks: [{ id: "risk-1" }],
};

const landscapeReplay = {
  generatedAt: "2026-05-20T00:00:00.000Z",
  comparedRunCount: 2,
  averageOverlapRate: 0.5,
  retainedItemCount: 1,
  missingFromCurrentItemCount: 1,
  newlyRetrievedItemCount: 1,
  usedBaselineLostItemCount: 0,
  currentNoMatchRunCount: 0,
  scoreTuning: { highChurnRunCount: 1 },
  promotionGateSummary: { gateMode: "normal" as const },
};

function knowledgeSummary(overrides: Record<string, unknown> = {}) {
  return {
    knowledge_total: 10,
    active_knowledge: 6,
    draft_knowledge: 3,
    deprecated_knowledge: 1,
    rules: 7,
    procedures: 3,
    embedded_knowledge: 4,
    zero_use_active_knowledge: 2,
    source_evidence_linked_knowledge: 5,
    origin_linked_knowledge: 4,
    provenance_traceable_knowledge: 6,
    ...overrides,
  };
}

function stubPostgresExecute() {
  mocks.execute.mockImplementation(async (query: unknown) => {
    const text = queryText(query);
    if (text.includes("knowledge_total")) return { rows: [knowledgeSummary()] };
    if (text.includes("indexed_sources")) {
      return { rows: [{ indexed_sources: 8, source_fragments: 20, source_links: 12 }] };
    }
    if (text.includes("vibe_records")) {
      return {
        rows: [
          { vibe_records: 4, vibe_sessions: 2, vibe_records_with_diffs: 1, agent_diff_entries: 3 },
        ],
      };
    }
    if (
      text.includes("as item_count") ||
      (text.includes("item_count") && text.includes("group by status"))
    ) {
      return {
        rows: [
          { status: "active", type: "rule", item_count: 4 },
          { status: "draft", type: "procedure", item_count: 2 },
          { status: "ignored", type: "rule", item_count: 9 },
        ],
      };
    }
    if (text.includes("bucket_0")) {
      return {
        rows: [
          {
            bucket_0: 1,
            bucket_0_1: 1,
            bucket_1_5: 1,
            bucket_5_10: 1,
            bucket_10_15: 1,
            bucket_15_20: 1,
            bucket_20_25: 1,
            bucket_25_30: 1,
            bucket_30_35: 1,
            bucket_35_plus: 1,
          },
        ],
      };
    }
    if (text.includes("vibe_memories") && text.includes("to_char")) {
      return { rows: [{ day: "2026-05-20", records: 2 }] };
    }
    if (text.includes("origin_kind")) {
      return { rows: [{ origin_kind: "vibe_memory", count: 3 }] };
    }
    if (text.includes("compile_ok_runs")) {
      return {
        rows: [
          { compile_runs: 4, compile_ok_runs: 2, compile_degraded_runs: 1, compile_failed_runs: 1 },
        ],
      };
    }
    if (text.includes("context_compile_runs") && text.includes("generate_series")) {
      return {
        rows: [{ day: "2026-05-20", ok: 2, degraded: 1, failed: 0, avg_duration_ms: 15 }],
      };
    }
    if (text.includes("distillation_search_providers")) {
      return {
        rows: [
          {
            metadata: {
              providers: {
                brave: { lastError: "Brave search HTTP 429", lastRateLimit: { status: 429 } },
                exa: { lastError: null },
              },
            },
          },
        ],
      };
    }
    if (text.includes("relevance_avg")) {
      return {
        rows: [
          {
            evaluated_run_count: 2,
            evaluation_count: 3,
            average_avg: 80,
            relevance_avg: 81,
            actionability_avg: 82,
            coverage_avg: 83,
            clarity_avg: 84,
            specificity_avg: 85,
          },
        ],
      };
    }
    if (
      text.includes("prevented_rework_signal_count") ||
      text.includes("compile_run_reuse") ||
      text.includes("accepted_compile_evaluation_count")
    ) {
      return {
        rows: [
          {
            compile_run_count: 4,
            evaluated_compile_run_count: 2,
            compile_evaluation_count: 3,
            accepted_compile_evaluation_count: 2,
            reused_compile_run_count: 1,
            decision_run_count: 5,
            decision_feedback_count: 4,
            known_decision_feedback_count: 3,
            successful_decision_feedback_count: 2,
            bad_decision_feedback_count: 1,
            prevented_rework_signal_count: 1,
            applied_feedback_effect_count: 1,
          },
        ],
      };
    }
    if (text.includes("total_calls_30d")) {
      return {
        rows: [
          {
            total_calls_30d: 10,
            measured_calls_30d: 6,
            estimated_calls_30d: 4,
            local_tokens_total_30d: 100,
            local_prompt_tokens_30d: 60,
            local_completion_tokens_30d: 40,
            cloud_tokens_total_30d: 200,
            cloud_prompt_tokens_30d: 120,
            cloud_completion_tokens_30d: 80,
            measured_tokens_total_30d: 180,
            estimated_tokens_total_30d: 120,
            reasoning_tokens_total_30d: 5,
            cloud_cost_jpy_total_30d: 12.5,
            cloud_model_30d: "gpt-4o",
          },
        ],
      };
    }
    if (text.includes("local_prompt_tokens") && text.includes("generate_series")) {
      return {
        rows: [
          {
            day: "2026-05-20",
            local_prompt_tokens: 10,
            local_completion_tokens: 5,
            local_reasoning_tokens: 1,
            cloud_prompt_tokens: 20,
            cloud_completion_tokens: 8,
            cloud_reasoning_tokens: 0,
            total_tokens: 43,
            measured_tokens: 30,
            estimated_tokens: 13,
            measured_calls: 2,
            estimated_calls: 1,
            cost_jpy: 1.5,
          },
        ],
      };
    }
    if (text.includes("group by source") || text.includes("by source")) {
      return {
        rows: [
          {
            source: "compile",
            calls: 4,
            measured_calls: 3,
            estimated_calls: 1,
            prompt_tokens: 40,
            completion_tokens: 20,
            total_tokens: 60,
          },
        ],
      };
    }
    // Fallback: treat remaining aggregate queries as product-value stats.
    if (text.includes("context_decision") || text.includes("context_compile_evals")) {
      return {
        rows: [
          {
            compile_run_count: 4,
            evaluated_compile_run_count: 2,
            compile_evaluation_count: 3,
            accepted_compile_evaluation_count: 2,
            reused_compile_run_count: 1,
            decision_run_count: 5,
            decision_feedback_count: 4,
            known_decision_feedback_count: 3,
            successful_decision_feedback_count: 2,
            bad_decision_feedback_count: 1,
            prevented_rework_signal_count: 1,
            applied_feedback_effect_count: 1,
          },
        ],
      };
    }
    return { rows: [] };
  });
}

function stubSqliteQueries() {
  mocks.sqliteGet.mockImplementation((sql: string) => {
    if (sql.includes("knowledge_total")) return knowledgeSummary();
    if (sql.includes("indexed_sources")) {
      return { indexed_sources: 8, source_fragments: 20, source_links: 12 };
    }
    if (sql.includes("vibe_records")) {
      return {
        vibe_records: 4,
        vibe_sessions: 2,
        vibe_records_with_diffs: 1,
        agent_diff_entries: 3,
      };
    }
    if (sql.includes("bucket_0")) {
      return {
        bucket_0: 1,
        bucket_0_1: 0,
        bucket_1_5: 0,
        bucket_5_10: 0,
        bucket_10_15: 0,
        bucket_15_20: 0,
        bucket_20_25: 0,
        bucket_25_30: 0,
        bucket_30_35: 0,
        bucket_35_plus: 0,
      };
    }
    if (sql.includes("total_calls_30d")) {
      return {
        total_calls_30d: 0,
        measured_calls_30d: 0,
        estimated_calls_30d: 0,
        local_tokens_total_30d: 0,
        local_prompt_tokens_30d: 0,
        local_completion_tokens_30d: 0,
        cloud_tokens_total_30d: 0,
        cloud_prompt_tokens_30d: 0,
        cloud_completion_tokens_30d: 0,
        measured_tokens_total_30d: 0,
        estimated_tokens_total_30d: 0,
        reasoning_tokens_total_30d: 0,
        cloud_cost_jpy_total_30d: 0,
      };
    }
    if (sql.includes("from llm_usage_logs") && sql.includes("group by model")) {
      return { model: "gpt-4o" };
    }
    if (sql.includes("from context_compile_runs") && sql.includes("compile_runs")) {
      return {
        compile_runs: 4,
        compile_ok_runs: 2,
        compile_degraded_runs: 1,
        compile_failed_runs: 1,
      };
    }
    if (sql.includes("distillation_search_providers")) {
      return { metadata: JSON.stringify({ brave: { lastError: null }, exa: { lastError: null } }) };
    }
    if (sql.includes("from context_compile_evals") && sql.includes("relevance")) {
      return { evaluated_run_count: 0, evaluation_count: 0 };
    }
    if (sql.includes("compile_run_reuse") || sql.includes("compile_run_count")) {
      return { compile_run_count: 0 };
    }
    if (sql.includes("landscape_snapshot'")) {
      return {
        payload: JSON.stringify({
          stats: landscapeSnapshot.stats,
          risks: landscapeSnapshot.risks,
        }),
      };
    }
    if (sql.includes("landscape_replay_comparison")) {
      return { payload: JSON.stringify(landscapeReplay) };
    }
    return {};
  });
  mocks.sqliteAll.mockImplementation((sql: string) => {
    if (
      sql.includes("item_count") ||
      (sql.includes("group by status, type") && sql.includes("knowledge_items"))
    ) {
      return [{ status: "active", type: "rule", item_count: 4 }];
    }
    if (sql.includes("from vibe_memories")) return [{ day: "2026-05-20", records: 2 }];
    if (sql.includes("origin_kind")) return [{ origin_kind: "agent_candidate", count: 2 }];
    if (sql.includes("from context_compile_runs")) {
      return [{ day: "2026-05-20", ok: 1, degraded: 0, failed: 0, avg_duration_ms: null }];
    }
    if (sql.includes("local_prompt_tokens")) {
      return [
        {
          day: "2026-05-20",
          local_prompt_tokens: 1,
          local_completion_tokens: 1,
          local_reasoning_tokens: 0,
          cloud_prompt_tokens: 0,
          cloud_completion_tokens: 0,
          cloud_reasoning_tokens: 0,
          total_tokens: 2,
          measured_tokens: 2,
          estimated_tokens: 0,
          measured_calls: 1,
          estimated_calls: 0,
          cost_jpy: 0,
        },
      ];
    }
    if (sql.includes("group by source")) {
      return [
        {
          source: "queue",
          calls: 1,
          measured_calls: 1,
          estimated_calls: 0,
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      ];
    }
    return [];
  });
}

describe("normalizeSearchApiStatus", () => {
  test("returns cooldown status when cooldownUntil is missing but rate-limit signal exists", () => {
    const status = normalizeSearchApiStatus({
      providers: {
        brave: {
          updatedAt: "2026-05-22T08:00:00.000Z",
          lastRateLimit: {
            status: 429,
          },
          lastError: "Brave search HTTP 429",
        },
      },
    });

    expect(status.brave.status).toBe("cooldown");
    expect(status.brave.cooldownUntil).toBeNull();
    expect(status.brave.lastError).toBe("Brave search HTTP 429");
  });

  test("returns ok status when cooldown is already expired", () => {
    const status = normalizeSearchApiStatus({
      providers: {
        exa: {
          cooldownUntil: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
          lastRateLimit: {
            status: 200,
          },
          lastError: null,
        },
      },
    });

    expect(status.exa.status).toBe("ok");
    expect(status.exa.cooldownUntil).toBeNull();
  });

  test("treats non-record metadata as empty providers", () => {
    const status = normalizeSearchApiStatus("not-an-object");
    expect(status.brave.status).toBe("ok");
    expect(status.exa.status).toBe("ok");
  });
});

describe("overview repository helpers", () => {
  test("normalizes timezone values", () => {
    expect(normalizeOverviewTimezone(null)).toBe("Asia/Tokyo");
    expect(normalizeOverviewTimezone("system")).toBe("Asia/Tokyo");
    expect(normalizeOverviewTimezone("UTC")).toBe("UTC");
    expect(normalizeOverviewTimezone("not/a/zone")).toBe("Asia/Tokyo");
  });

  test("builds sqlite timezone modifiers", () => {
    expect(sqliteTimezoneModifier("Asia/Tokyo")).toBe("+9 hours");
    expect(sqliteTimezoneModifier("UTC")).toBe("+0 hours");
    expect(sqliteTimezoneModifier("Asia/Kolkata")).toMatch(/minutes|hours/);
  });

  test("converts numeric and string helper values", () => {
    expect(toNumber("12", 0)).toBe(12);
    expect(toNumber("nope", 7)).toBe(7);
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber(undefined)).toBeNull();
    expect(toNullableNumber("8.5")).toBe(8.5);
    expect(toNullableNumber("bad")).toBeNull();
    expect(stringValue("  hi  ")).toBe("hi");
    expect(stringValue("   ")).toBeNull();
    expect(stringValue(1)).toBeNull();
  });

  test("picks the latest parseable timestamp", () => {
    const latest = latestCheckedAt([
      "not-a-date",
      "unix-ms:1747699200000",
      "2026-05-20 00:00:00",
      "2026-05-21T00:00:00.000Z",
    ]);
    expect(latest).toBe("2026-05-21T00:00:00.000Z");
    expect(latestCheckedAt([])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("builds community source coverage and knowledge charts", () => {
    expect(
      buildCommunitySourceCoverage([
        { sourceRefCount: 2, health: { thinEvidence: false } },
        { sourceRefCount: 1, health: { thinEvidence: true } },
        { sourceRefCount: 0, health: { thinEvidence: false } },
      ]),
    ).toEqual({
      sourceCommunities: 3,
      sourceCoveredCommunities: 1,
      sourceThinCommunities: 1,
      sourceMissingCommunities: 1,
    });

    expect(
      buildKnowledgeStatusTypeChart([
        { status: "active", type: "rule", item_count: 4 },
        { status: "draft", type: "procedure", item_count: 2 },
        { status: "unknown", type: "rule", item_count: 9 },
      ]),
    ).toEqual([
      { status: "active", rule: 4, procedure: 0 },
      { status: "draft", rule: 0, procedure: 2 },
      { status: "deprecated", rule: 0, procedure: 0 },
    ]);
  });

  test("counts wiki pages through the content repo", async () => {
    mocks.ensureContentRoot.mockResolvedValue(undefined);
    mocks.listPages.mockResolvedValue([{ slug: "a" }, { slug: "b" }]);
    await expect(countWikiPages()).resolves.toBe(2);
  });

  test("buildOverviewLandscapeSummary maps snapshots and degrades on error", async () => {
    mocks.buildLandscapeSnapshot.mockResolvedValue(landscapeSnapshot);
    mocks.buildLandscapeReplayComparison.mockResolvedValue(landscapeReplay);

    const ok = await buildOverviewLandscapeSummary();
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.snapshot.topRiskCount).toBe(1);
      expect(ok.replay.promotionGateMode).toBe("normal");
    }

    mocks.buildLandscapeSnapshot.mockRejectedValue(new Error("boom"));
    const unavailable = await buildOverviewLandscapeSummary();
    expect(unavailable).toEqual({
      status: "unavailable",
      windowDays: 30,
      error: "boom",
    });

    mocks.buildLandscapeSnapshot.mockRejectedValue("plain");
    const fallback = await buildOverviewLandscapeSummary();
    expect(fallback.status).toBe("unavailable");
    if (fallback.status === "unavailable") {
      expect(fallback.error).toBe("Landscape summary could not be loaded.");
    }
  });
});

describe("overview repository fetchers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backendKind = "postgres";
    mocks.ensureRuntimeSettingsLoaded.mockResolvedValue(undefined);
    mocks.ensureContentRoot.mockResolvedValue(undefined);
    mocks.listPages.mockResolvedValue([{ slug: "home" }]);
    mocks.inspectCompileRuns.mockResolvedValue({ runs: compileRunHealth });
    mocks.buildGraphSnapshot.mockResolvedValue(graphSnapshot);
    mocks.buildLandscapeSnapshot.mockResolvedValue(landscapeSnapshot);
    mocks.buildLandscapeReplayComparison.mockResolvedValue(landscapeReplay);
    stubPostgresExecute();
    stubSqliteQueries();
  });

  test("fetchOverviewKnowledgeAssetsDomainForApi maps aggregate rows", async () => {
    const domain = await fetchOverviewKnowledgeAssetsDomainForApi("UTC");
    expect(domain.kpis.knowledgeTotal).toBe(10);
    expect(domain.kpis.unlinkedKnowledge).toBe(5);
    expect(domain.kpis.originLinksByKind.vibe_memory).toBe(3);
    expect(domain.kpis.sourceCoveredCommunities).toBe(1);
    expect(domain.kpis.wikiPages).toBe(1);
    expect(domain.charts.knowledgeByStatusType[0]?.rule).toBe(4);
    expect(domain.charts.vibeRecordsByDay[0]?.day).toBe("2026-05-20");
  });

  test("fetchOverviewSystemQualityDomainForApi maps compile and search aggregates", async () => {
    const domain = await fetchOverviewSystemQualityDomainForApi();
    expect(domain.kpis.compileRuns).toBe(4);
    expect(domain.compileRunHealth.totalRuns).toBe(4);
    expect(domain.compileEvalStats.averageAvg).toBe(80);
    expect(domain.productValueStats.evidence.compileRunCount).toBe(4);
    expect(domain.searchApiStatus.brave.status).toBe("cooldown");
    expect(domain.charts.compileRunsByDay[0]?.ok).toBe(2);
  });

  test("fetchOverviewLlmResourcesDomainForApi maps usage aggregates and zero-call coverage", async () => {
    const domain = await fetchOverviewLlmResourcesDomainForApi();
    expect(domain.llmUsage.kpis.totalCalls30d).toBe(10);
    expect(domain.llmUsage.kpis.measuredCoveragePercent30d).toBe(60);
    expect(domain.llmUsage.kpis.cloudModel).toBe("gpt-4o");
    expect(domain.llmUsage.daily[0]?.totalTokens).toBe(43);
    expect(domain.llmUsage.bySource[0]?.source).toBe("compile");

    mocks.execute.mockImplementation(async (query: unknown) => {
      const text = queryText(query);
      if (text.includes("total_calls_30d")) return { rows: [{}] };
      return { rows: [] };
    });
    const empty = await fetchOverviewLlmResourcesDomainForApi("not/a/zone");
    expect(empty.llmUsage.kpis.measuredCoveragePercent30d).toBe(0);
    expect(empty.llmUsage.kpis.cloudModel.length).toBeGreaterThan(0);
  });

  test("fetchOverviewLandscapeHealthDomainForApi uses landscape helpers", async () => {
    const domain = await fetchOverviewLandscapeHealthDomainForApi();
    expect(domain.landscape.status).toBe("ok");
  });

  test("fetchOverviewDomainForApi and dashboard cover postgres domains", async () => {
    await expect(fetchOverviewDomainForApi("knowledge-assets")).resolves.toMatchObject({
      kpis: { knowledgeTotal: 10 },
    });
    await expect(fetchOverviewDomainForApi("landscape-health")).resolves.toMatchObject({
      landscape: { status: "ok" },
    });
    await expect(fetchOverviewDomainForApi("system-quality")).resolves.toMatchObject({
      kpis: { compileRuns: 4 },
    });
    await expect(fetchOverviewDomainForApi("llm-resources")).resolves.toMatchObject({
      llmUsage: { kpis: { totalCalls30d: 10 } },
    });

    const dashboard = await fetchOverviewDashboardForApi("UTC");
    expect(dashboard.kpis.knowledgeTotal).toBe(10);
    expect(dashboard.kpis.compileRuns).toBe(4);
    expect(dashboard.landscape.status).toBe("ok");
    expect(dashboard.llmUsage.kpis.cloudModel).toBe("gpt-4o");
  });

  test("sqlite domain and dashboard paths map sqlite aggregate rows", async () => {
    mocks.backendKind = "sqlite";

    const knowledge = await fetchOverviewDomainForApi("knowledge-assets", "Asia/Tokyo");
    expect(knowledge).toMatchObject({ kpis: { knowledgeTotal: 10, wikiPages: 1 } });

    const landscape = await fetchOverviewDomainForApi("landscape-health");
    expect(landscape).toMatchObject({ landscape: { status: "ok" } });

    const quality = await fetchOverviewDomainForApi("system-quality");
    expect(quality).toMatchObject({ kpis: { compileRuns: 4 } });

    const llm = await fetchOverviewDomainForApi("llm-resources");
    expect(llm).toMatchObject({
      llmUsage: { kpis: { totalCalls30d: 0, measuredCoveragePercent30d: 0 } },
    });

    const dashboard = await fetchOverviewDashboardForApi();
    expect(dashboard.kpis.knowledgeTotal).toBe(10);
    expect(dashboard.charts.compileRunsByDay.length).toBe(14);
    expect(dashboard.landscape.status).toBe("ok");
  });

  test("sqlite landscape falls back to graph health then unavailable", async () => {
    mocks.backendKind = "sqlite";
    mocks.sqliteGet.mockImplementation((sql: string) => {
      if (sql.includes("landscape_")) return {};
      return {};
    });

    const fromGraph = await fetchOverviewDomainForApi("landscape-health");
    expect(fromGraph).toMatchObject({ landscape: { status: "ok" } });
    if ("landscape" in fromGraph && fromGraph.landscape.status === "ok") {
      expect(fromGraph.landscape.snapshot.totalCommunities).toBe(3);
      expect(fromGraph.landscape.replay.promotionGateMode).toBe("normal");
    }

    mocks.buildGraphSnapshot.mockResolvedValue({
      ...graphSnapshot,
      communities: [],
    });
    const unavailable = await fetchOverviewDomainForApi("landscape-health");
    expect(unavailable).toMatchObject({
      landscape: {
        status: "unavailable",
        error:
          "SQLite landscape summary has no ready landscape snapshot cache or graph health data yet.",
      },
    });
  });

  test("sqlite landscape replay promotion gate uses review_required when present", async () => {
    mocks.backendKind = "sqlite";
    mocks.sqliteGet.mockImplementation((sql: string) => {
      if (sql.includes("landscape_snapshot'")) {
        return { payload: JSON.stringify({ stats: landscapeSnapshot.stats, risks: [] }) };
      }
      if (sql.includes("landscape_replay_comparison")) {
        return {
          payload: JSON.stringify({
            ...landscapeReplay,
            promotionGateSummary: { gateMode: "review_required" },
          }),
        };
      }
      return {};
    });

    const domain = await fetchOverviewDomainForApi("landscape-health");
    expect(domain).toMatchObject({
      landscape: { status: "ok", replay: { promotionGateMode: "review_required" } },
    });
  });
});
