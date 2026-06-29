import { createHash } from "node:crypto";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import { asRecord, asStringArray } from "../../shared/utils/normalize.js";

export type UtilityRetrievalLane = "co_selection" | "exploration" | "negative_inverse";

export type UtilityTraceCandidate = {
  itemKind: "rule" | "procedure";
  itemId: string;
  score: number;
  lane: UtilityRetrievalLane;
  rankingReason: string;
  evidence: Record<string, unknown>;
};

export type UtilityRetrievalInput = {
  input: CompileInput;
  retrievalMode: RetrievalMode;
  selectedKnowledgeIds: string[];
  existingCandidateIds: string[];
  facets: {
    technologies: string[];
    changeTypes: string[];
    domains: string[];
  };
};

export type UtilityRetrievalReportMode = "baseline" | "observation" | "promotion-dry-run";

export type UtilityRetrievalReportOptions = {
  mode: UtilityRetrievalReportMode;
  sinceDays: number;
  limit: number;
};

type SqliteKnowledgeRow = {
  id: string;
  type: string;
  status: string;
  polarity: string;
  intent_tags: string;
  title: string;
  body: string;
  applies_to: string;
  confidence: number;
  importance: number;
  compile_select_count: number;
  explicit_downvote_count: number;
  metadata: string;
};

type CoSelectionRow = {
  seed_id: string;
  candidate_id: string;
  item_kind: string;
  outcome: string | null;
  pair_count: number;
};

type CountRow = { count: number };

type CandidateTraceReportRow = {
  item_id: string;
  item_kind: string;
  selected: number;
  suppressed: number;
  suppression_reason: string | null;
  agentic_decision: string;
  final_rank: number | null;
  evidence: string;
  created_at: string;
};

type EvalReportRow = {
  outcome: string;
  relevance: number | null;
  actionability: number | null;
  coverage: number | null;
  specificity: number | null;
};

type UsageReportRow = {
  verdict: string;
  count: number;
};

type UtilityLaneSummary = {
  traceCount: number;
  selectedSameRunCount: number;
  wrongCount: number;
  offTopicCount: number;
  laterSelectedCount: number;
};

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

async function getSqliteDb() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  return sqlite.db;
}

function parseJson(value: unknown): unknown {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return asStringArray(parseJson(value) ?? value).map((item) => item.toLowerCase());
}

function finite(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function int(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(finite(value, fallback)));
}

function enabledEnv(value: string | undefined, defaultEnabled: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultEnabled;
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export function isUtilityTraceEnabled(): boolean {
  return enabledEnv(process.env.CONTEXT_COMPILE_UTILITY_TRACE, true);
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function normalizeKind(value: string): "rule" | "procedure" {
  return value === "procedure" ? "procedure" : "rule";
}

function hashUnit(value: string): number {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return Number.parseInt(digest, 16) / 0xffffffffffff;
}

function utilityEvidence(params: {
  lane: UtilityRetrievalLane;
  adoptionReason: string;
  rejectIf?: string[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    utilityLane: params.lane,
    traceOnly: true,
    dropStage: "trace_only",
    dropReason: "utility_trace_only",
    adoptionReason: params.adoptionReason,
    rejectIf: params.rejectIf ?? [
      "goal に対して Workflow / Verification / Avoid のいずれにも接続できない",
      "wrong または off_topic の履歴がある",
    ],
    ...(params.extra ?? {}),
  };
}

function inferConstrainedIntents(input: CompileInput): string[] {
  const haystack = [
    input.goal,
    ...(input.changeTypes ?? []),
    ...(input.domains ?? []),
    ...(input.technologies ?? []),
  ]
    .join(" ")
    .toLowerCase();
  const intents = new Set<string>();
  const addIf = (intent: string, patterns: RegExp[]) => {
    if (patterns.some((pattern) => pattern.test(haystack))) intents.add(intent);
  };
  addIf("modify_schema", [/schema|migration|migrate|table|column|カラム|テーブル|スキーマ/]);
  addIf("production_change", [/prod|production|本番|release|deploy/]);
  addIf("requeue", [/requeue|queue|retry|再キュー|再実行/]);
  addIf("delete_or_reset", [/delete|remove|reset|drop|削除|リセット/]);
  addIf("restart_owner", [/restart|launchagent|daemon|worker|再起動/]);
  addIf("provider_change", [/provider|model|llm|azure|openai|qwen/]);
  addIf("runtime_truth_check", [/runtime|process|sqlite|db|truth|実体|プロセス/]);
  return [...intents];
}

function hasRecentBadFeedbackClause(alias = "ki"): string {
  return `NOT EXISTS (
    SELECT 1
    FROM knowledge_usage_events bad
    WHERE bad.knowledge_id = ${alias}.id
      AND bad.verdict IN ('off_topic', 'wrong')
      AND datetime(bad.created_at) >= datetime('now', '-30 days')
  )`;
}

async function collectCoSelectionCandidates(
  params: UtilityRetrievalInput,
): Promise<UtilityTraceCandidate[]> {
  const seeds = [...new Set(params.selectedKnowledgeIds)].filter(Boolean);
  if (seeds.length === 0) return [];
  const existing = new Set(seeds);
  const db = await getSqliteDb();
  const rows = db
    .query<CoSelectionRow, unknown[]>(
      `
      SELECT
        seed.item_id AS seed_id,
        candidate.item_id AS candidate_id,
        candidate.item_kind AS item_kind,
        eval.outcome AS outcome,
        count(*) AS pair_count
      FROM context_pack_items seed
      JOIN context_pack_items candidate
        ON candidate.run_id = seed.run_id
       AND candidate.item_id != seed.item_id
       AND candidate.item_kind IN ('rule', 'procedure')
      JOIN knowledge_items ki
        ON ki.id = candidate.item_id
       AND ki.status = 'active'
      LEFT JOIN context_compile_evals eval
        ON eval.id = (
          SELECT latest_eval.id
          FROM context_compile_evals latest_eval
          WHERE latest_eval.run_id = seed.run_id
          ORDER BY datetime(latest_eval.created_at) DESC, latest_eval.id DESC
          LIMIT 1
        )
      WHERE seed.item_id IN (${placeholders(seeds)})
        AND seed.item_kind IN ('rule', 'procedure')
        AND ${hasRecentBadFeedbackClause("ki")}
      GROUP BY seed.item_id, candidate.item_id, candidate.item_kind, eval.outcome
      `,
    )
    .all(...seeds);

  const byCandidate = new Map<
    string,
    {
      itemKind: "rule" | "procedure";
      seedIds: Set<string>;
      useful: number;
      partial: number;
      misleading: number;
      other: number;
    }
  >();
  for (const row of rows) {
    if (existing.has(row.candidate_id)) continue;
    const current = byCandidate.get(row.candidate_id) ?? {
      itemKind: normalizeKind(row.item_kind),
      seedIds: new Set<string>(),
      useful: 0,
      partial: 0,
      misleading: 0,
      other: 0,
    };
    current.seedIds.add(row.seed_id);
    const count = int(row.pair_count);
    if (row.outcome === "useful") current.useful += count;
    else if (row.outcome === "partial") current.partial += count;
    else if (row.outcome === "misleading") current.misleading += count;
    else current.other += count;
    byCandidate.set(row.candidate_id, current);
  }

  return [...byCandidate.entries()]
    .map(([itemId, value]) => {
      const score = value.useful * 3 + value.partial - value.misleading * 2;
      return {
        itemKind: value.itemKind,
        itemId,
        score,
        lane: "co_selection" as const,
        rankingReason: "utility_trace_only:co_selection",
        evidence: utilityEvidence({
          lane: "co_selection",
          adoptionReason: "selected direct Knowledge と過去の useful / partial compile で共起した",
          extra: {
            seedKnowledgeIds: [...value.seedIds],
            coSelectionScore: score,
            supportingRunCount: value.useful + value.partial + value.misleading + value.other,
            outcomeBreakdown: {
              useful: value.useful,
              partial: value.partial,
              misleading: value.misleading,
              other: value.other,
            },
          },
        }),
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.itemId.localeCompare(right.itemId))
    .slice(0, 5);
}

async function collectExplorationCandidate(
  params: UtilityRetrievalInput,
): Promise<UtilityTraceCandidate[]> {
  const existing = new Set(params.selectedKnowledgeIds);
  const db = await getSqliteDb();
  const rows = db
    .query<SqliteKnowledgeRow, []>(
      `
      SELECT id, type, status, polarity, intent_tags, title, body, applies_to, confidence,
             importance, compile_select_count, explicit_downvote_count, metadata
      FROM knowledge_items ki
      WHERE status = 'active'
        AND compile_select_count <= 2
        AND importance >= 40
        AND confidence >= 50
        AND explicit_downvote_count <= 0
        AND ${hasRecentBadFeedbackClause("ki")}
      ORDER BY updated_at DESC
      LIMIT 200
      `,
    )
    .all();
  const candidates = rows
    .filter((row) => !existing.has(row.id))
    .map((row) => {
      const weight = finite(row.importance) * 0.6 + finite(row.confidence) * 0.4;
      const random = hashUnit(`${params.input.goal}:${params.retrievalMode}:${row.id}`);
      return { row, orderingScore: weight * (0.2 + random) };
    })
    .sort((left, right) => right.orderingScore - left.orderingScore);
  const selected = candidates[0]?.row;
  if (!selected) return [];
  return [
    {
      itemKind: normalizeKind(selected.type),
      itemId: selected.id,
      score: finite(selected.importance) * 0.6 + finite(selected.confidence) * 0.4,
      lane: "exploration",
      rankingReason: "utility_trace_only:exploration",
      evidence: utilityEvidence({
        lane: "exploration",
        adoptionReason: "未選出または低選出だが importance / confidence が一定以上ある",
        extra: {
          compileSelectCount: int(selected.compile_select_count),
          importance: finite(selected.importance),
          confidence: finite(selected.confidence),
          selectionStrategy: "deterministic_weighted_random",
        },
      }),
    },
  ];
}

function facetOverlapScore(row: SqliteKnowledgeRow, params: UtilityRetrievalInput): number {
  const appliesTo = asRecord(parseJson(row.applies_to));
  const score = (key: "technologies" | "changeTypes" | "domains") => {
    const expected = new Set(params.facets[key].map((item) => item.toLowerCase()));
    if (expected.size === 0) return 0;
    return asStringArray(appliesTo[key]).filter((item) => expected.has(item.toLowerCase())).length;
  };
  return score("technologies") * 2 + score("changeTypes") * 2 + score("domains");
}

async function collectNegativeInverseCandidate(
  params: UtilityRetrievalInput,
): Promise<UtilityTraceCandidate[]> {
  const intents = inferConstrainedIntents(params.input);
  if (intents.length === 0) return [];
  const existing = new Set(params.selectedKnowledgeIds);
  const db = await getSqliteDb();
  const rows = db
    .query<SqliteKnowledgeRow, []>(
      `
      SELECT id, type, status, polarity, intent_tags, title, body, applies_to, confidence,
             importance, compile_select_count, explicit_downvote_count, metadata
      FROM knowledge_items ki
      WHERE status = 'active'
        AND polarity = 'negative'
        AND ${hasRecentBadFeedbackClause("ki")}
      ORDER BY importance DESC, updated_at DESC
      LIMIT 200
      `,
    )
    .all();

  const intentSet = new Set(intents);
  const candidates = rows
    .filter((row) => !existing.has(row.id))
    .map((row) => {
      const tags = new Set(stringArray(row.intent_tags));
      const metadata = asRecord(parseJson(row.metadata));
      const constrained = new Set(
        asStringArray(metadata.constrainedIntents).map((item) => item.toLowerCase()),
      );
      const tagMatches = [...intentSet].filter(
        (intent) => tags.has(intent) || constrained.has(intent),
      );
      const facetScore = facetOverlapScore(row, params);
      const score = tagMatches.length * 10 + facetScore + finite(row.importance) / 100;
      return { row, score, tagMatches, facetScore };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id));

  const selected = candidates[0];
  if (!selected) return [];
  return [
    {
      itemKind: normalizeKind(selected.row.type),
      itemId: selected.row.id,
      score: selected.score,
      lane: "negative_inverse",
      rankingReason: "utility_trace_only:negative_inverse",
      evidence: utilityEvidence({
        lane: "negative_inverse",
        adoptionReason:
          "goal から推定した constrained intent に negative knowledge が逆引きで一致した",
        rejectIf: [
          "negative guardrail として Avoid / Prefer に変換できない",
          "現在の goal の制約や確認条件に接続できない",
          "wrong または off_topic の履歴がある",
        ],
        extra: {
          inferredConstrainedIntents: intents,
          matchedConstrainedIntents: selected.tagMatches,
          facetScore: selected.facetScore,
        },
      }),
    },
  ];
}

export async function collectUtilityTraceCandidates(
  params: UtilityRetrievalInput,
): Promise<UtilityTraceCandidate[]> {
  if (!isUtilityTraceEnabled()) return [];
  if (!isSqliteBackend()) return [];
  try {
    const laneResults = await Promise.all([
      collectCoSelectionCandidates(params),
      collectExplorationCandidate(params),
      collectNegativeInverseCandidate(params),
    ]);
    const seen = new Set<string>();
    const result: UtilityTraceCandidate[] = [];
    for (const candidate of laneResults.flat()) {
      const key = `${candidate.itemKind}:${candidate.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
    return result;
  } catch {
    return [];
  }
}

function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number");
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function extractDropStage(row: CandidateTraceReportRow): string {
  const evidence = asRecord(parseJson(row.evidence));
  const direct = typeof evidence.dropStage === "string" ? evidence.dropStage : null;
  if (direct) return direct;
  if (row.selected) return "selected";
  if (row.suppression_reason === "agentic_rejected") return "agentic_rejected";
  if (row.suppression_reason === "token_budget_section_limit") return "ranked_but_budgeted_out";
  if (row.suppression_reason === "near_duplicate_suppressed") return "suppressed_duplicate";
  return "retrieved_but_ranked_out";
}

function isUtilityRetrievalLane(value: string): value is UtilityRetrievalLane {
  return value === "co_selection" || value === "exploration" || value === "negative_inverse";
}

function extractUtilityLanes(row: CandidateTraceReportRow): UtilityRetrievalLane[] {
  const evidence = asRecord(parseJson(row.evidence));
  const lane = typeof evidence.utilityLane === "string" ? evidence.utilityLane : null;
  const lanes = new Set<UtilityRetrievalLane>();
  if (lane && isUtilityRetrievalLane(lane)) {
    lanes.add(lane);
  }
  const utilitySignals = asRecord(evidence.utilitySignals);
  for (const key of Object.keys(utilitySignals)) {
    if (isUtilityRetrievalLane(key)) lanes.add(key);
  }
  return [...lanes];
}

function uniqueRunIdsClause(runIds: string[]): string {
  return runIds.length > 0 ? placeholders(runIds) : "''";
}

export async function generateUtilityRetrievalReport(options: UtilityRetrievalReportOptions) {
  if (!isSqliteBackend()) {
    return {
      mode: options.mode,
      backend: resolveDatabaseBackendConfig().kind,
      unsupported: true,
      reason: "utility retrieval report is implemented for sqlite first",
    };
  }

  const sinceDays = Math.max(1, Math.trunc(options.sinceDays));
  const limit = Math.max(1, Math.trunc(options.limit));
  const db = await getSqliteDb();
  const runRows = db
    .query<{ id: string }, [string, number]>(
      `SELECT id
       FROM context_compile_runs
       WHERE datetime(created_at) >= datetime('now', ?)
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`,
    )
    .all(`-${sinceDays} days`, limit);
  const runIds = runRows.map((row) => row.id);
  const runCount = runIds.length;

  const activeKnowledge = db
    .query<{ total: number; activated: number; cold: number }, []>(
      `SELECT
        count(*) AS total,
        sum(CASE WHEN compile_select_count > 0 THEN 1 ELSE 0 END) AS activated,
        sum(CASE WHEN compile_select_count = 0 THEN 1 ELSE 0 END) AS cold
       FROM knowledge_items
       WHERE status = 'active'`,
    )
    .get() ?? { total: 0, activated: 0, cold: 0 };

  const traceRows =
    runIds.length > 0
      ? db
          .query<CandidateTraceReportRow, string[]>(
            `SELECT item_id, item_kind, selected, suppressed, suppression_reason, agentic_decision,
                    final_rank, evidence, created_at
             FROM context_compile_candidate_traces
             WHERE run_id IN (${uniqueRunIdsClause(runIds)})`,
          )
          .all(...runIds)
      : [];
  const tracedItemIds = new Set(traceRows.map((row) => row.item_id));
  const notRetrieved = Math.max(0, int(activeKnowledge.total) - tracedItemIds.size);
  const dropByStage: Record<string, number> = { not_retrieved: notRetrieved };
  const utilityByLane: Record<UtilityRetrievalLane, UtilityLaneSummary> = {
    co_selection: {
      traceCount: 0,
      selectedSameRunCount: 0,
      wrongCount: 0,
      offTopicCount: 0,
      laterSelectedCount: 0,
    },
    exploration: {
      traceCount: 0,
      selectedSameRunCount: 0,
      wrongCount: 0,
      offTopicCount: 0,
      laterSelectedCount: 0,
    },
    negative_inverse: {
      traceCount: 0,
      selectedSameRunCount: 0,
      wrongCount: 0,
      offTopicCount: 0,
      laterSelectedCount: 0,
    },
  };

  for (const row of traceRows) {
    const stage = extractDropStage(row);
    dropByStage[stage] = (dropByStage[stage] ?? 0) + 1;
    for (const lane of extractUtilityLanes(row)) {
      utilityByLane[lane].traceCount += 1;
      if (row.selected) utilityByLane[lane].selectedSameRunCount += 1;
    }
  }

  const evalRows =
    runIds.length > 0
      ? db
          .query<EvalReportRow, string[]>(
            `SELECT outcome, relevance, actionability, coverage, specificity
             FROM context_compile_evals
             WHERE run_id IN (${uniqueRunIdsClause(runIds)})`,
          )
          .all(...runIds)
      : [];
  const outcomeDistribution: Record<string, number> = {};
  for (const row of evalRows) {
    outcomeDistribution[row.outcome] = (outcomeDistribution[row.outcome] ?? 0) + 1;
  }

  const usageRows =
    runIds.length > 0
      ? db
          .query<UsageReportRow, string[]>(
            `SELECT verdict, count(*) AS count
             FROM knowledge_usage_events
             WHERE run_id IN (${uniqueRunIdsClause(runIds)})
             GROUP BY verdict`,
          )
          .all(...runIds)
      : [];
  const usageDistribution: Record<string, number> = {};
  for (const row of usageRows) usageDistribution[row.verdict] = int(row.count);
  const totalUsage = Object.values(usageDistribution).reduce((sum, value) => sum + value, 0);

  const utilityTraceRecords: Array<{
    itemId: string;
    lane: UtilityRetrievalLane;
    createdAt: string;
  }> = [];
  for (const row of traceRows) {
    for (const lane of extractUtilityLanes(row)) {
      utilityTraceRecords.push({ itemId: row.item_id, lane, createdAt: row.created_at });
    }
  }
  for (const record of utilityTraceRecords) {
    const laterSelectedCount =
      db
        .query<CountRow, [string, string]>(
          `SELECT count(*) AS count
           FROM context_pack_items
           WHERE item_id = ?
             AND datetime(created_at) > datetime(?)`,
        )
        .get(record.itemId, record.createdAt)?.count ?? 0;
    utilityByLane[record.lane].laterSelectedCount += int(laterSelectedCount);

    const badRows = db
      .query<UsageReportRow, [string, string]>(
        `SELECT verdict, count(*) AS count
         FROM knowledge_usage_events
         WHERE knowledge_id = ?
           AND verdict IN ('off_topic', 'wrong')
           AND datetime(created_at) > datetime(?)
         GROUP BY verdict`,
      )
      .all(record.itemId, record.createdAt);
    for (const row of badRows) {
      if (row.verdict === "wrong") utilityByLane[record.lane].wrongCount += int(row.count);
      if (row.verdict === "off_topic") utilityByLane[record.lane].offTopicCount += int(row.count);
    }
  }

  const selectedRows =
    runIds.length > 0
      ? db
          .query<{ item_kind: string; count: number }, string[]>(
            `SELECT item_kind, count(*) AS count
             FROM context_pack_items
             WHERE run_id IN (${uniqueRunIdsClause(runIds)})
             GROUP BY item_kind`,
          )
          .all(...runIds)
      : [];
  const selectedCounts: Record<string, number> = {};
  for (const row of selectedRows) selectedCounts[row.item_kind] = int(row.count);
  const selectedKnowledge = (selectedCounts.rule ?? 0) + (selectedCounts.procedure ?? 0);
  const negativeSelected =
    runIds.length > 0
      ? (db
          .query<CountRow, string[]>(
            `SELECT count(*) AS count
             FROM context_pack_items pack
             JOIN knowledge_items ki ON ki.id = pack.item_id
             WHERE pack.run_id IN (${uniqueRunIdsClause(runIds)})
               AND pack.item_kind IN ('rule', 'procedure')
               AND ki.polarity = 'negative'`,
          )
          .get(...runIds)?.count ?? 0)
      : 0;

  return {
    mode: options.mode,
    backend: "sqlite",
    window: { sinceDays, limit, runCount },
    activationRate: pct(int(activeKnowledge.activated), int(activeKnowledge.total)),
    coldKnowledgeRate: pct(int(activeKnowledge.cold), int(activeKnowledge.total)),
    activeKnowledge: {
      total: int(activeKnowledge.total),
      activated: int(activeKnowledge.activated),
      cold: int(activeKnowledge.cold),
    },
    negativeSelectionRate: pct(int(negativeSelected), selectedKnowledge),
    episodeSelectionRate: pct(
      (selectedCounts.episode_card ?? 0) + (selectedCounts.episode ?? 0),
      runCount,
    ),
    candidateDropByStage: dropByStage,
    evalBaseline: {
      count: evalRows.length,
      averageRelevance: average(evalRows.map((row) => row.relevance)),
      averageActionability: average(evalRows.map((row) => row.actionability)),
      averageCoverage: average(evalRows.map((row) => row.coverage)),
      averageSpecificity: average(evalRows.map((row) => row.specificity)),
      outcomeDistribution,
    },
    offTopicWrongRate: pct(
      (usageDistribution.off_topic ?? 0) + (usageDistribution.wrong ?? 0),
      totalUsage,
    ),
    usageDistribution,
    utilityLanes: utilityByLane,
    promotionDryRun:
      options.mode === "promotion-dry-run"
        ? Object.fromEntries(
            Object.entries(utilityByLane).map(([lane, summary]) => [
              lane,
              {
                eligible:
                  summary.traceCount > 0 &&
                  summary.wrongCount === 0 &&
                  summary.offTopicCount === 0 &&
                  pct(summary.laterSelectedCount, summary.traceCount) >= 0.25,
                utilityHitRate: pct(summary.laterSelectedCount, summary.traceCount),
              },
            ]),
          )
        : undefined,
  };
}
