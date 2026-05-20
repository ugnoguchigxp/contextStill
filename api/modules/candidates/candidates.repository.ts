import { and, sql, type SQL } from "drizzle-orm";
import { db } from "../../../src/db/index.js";

export const candidateOutcomeValues = [
  "stored",
  "ready_not_finalized",
  "rejected",
  "retryable",
  "candidate_only",
  "target_pending",
] as const;

export type CandidateOutcome = (typeof candidateOutcomeValues)[number];

export type CandidateListQuery = {
  page: number;
  limit: number;
  query?: string;
  targetKind?: "all" | "wiki_file" | "vibe_memory";
  outcome?: "all" | CandidateOutcome;
  hasKnowledge?: "all" | "yes" | "no";
  targetStateId?: string;
};

export type CandidateDiffSummary = {
  titleChanged: boolean;
  bodyChanged: boolean;
  typeChanged: boolean;
  importanceDelta: number | null;
  confidenceDelta: number | null;
  bodySimilarity: number;
  summary: string[];
};

export type CandidateListItem = {
  id: string;
  targetStateId: string;
  candidateIndex: number;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  sourceUri: string;
  finalizeSourceUri: string;
  targetStatus: string;
  targetPhase: string;
  targetOutcomeKind: string | null;
  targetLastError: string | null;
  latestUpdatedAt: string;
  original: {
    title: string;
    body: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  cover: null | {
    status: string;
    stage: string;
    type: "rule" | "procedure" | null;
    title: string | null;
    body: string | null;
    importance: number | null;
    confidence: number | null;
    reason: string | null;
    referencesCount: number;
    duplicateRefsCount: number;
    toolEventsCount: number;
    updatedAt: string;
  };
  knowledge: null | {
    id: string;
    type: string;
    status: string;
    scope: string;
    title: string;
    body: string;
    importance: number | null;
    confidence: number | null;
    updatedAt: string;
  };
  outcome: CandidateOutcome;
  diff: {
    originalToCover: CandidateDiffSummary | null;
    coverToKnowledge: CandidateDiffSummary | null;
    originalToKnowledge: CandidateDiffSummary | null;
  };
};

export type CandidateListStats = {
  total: number;
  stored: number;
  readyNotFinalized: number;
  rejected: number;
  retryable: number;
  targetPending: number;
  candidateOnly: number;
};

export type CandidateListResult = {
  items: CandidateListItem[];
  total: number;
  stats: CandidateListStats;
};

type CandidateSqlRow = {
  id: string;
  target_state_id: string;
  candidate_index: number | string;
  target_kind: string;
  target_key: string;
  source_uri: string;
  finalize_source_uri: string;
  target_status: string;
  target_phase: string;
  target_outcome_kind: string | null;
  target_last_error: string | null;
  latest_updated_at: Date | string;
  original_title: string;
  original_body: string;
  original_status: string;
  original_created_at: Date | string;
  original_updated_at: Date | string;
  cover_status: string | null;
  cover_stage: string | null;
  cover_type: string | null;
  cover_title: string | null;
  cover_body: string | null;
  cover_importance: number | string | null;
  cover_confidence: number | string | null;
  cover_reason: string | null;
  cover_references_count: number | string | null;
  cover_duplicate_refs_count: number | string | null;
  cover_tool_events_count: number | string | null;
  cover_updated_at: Date | string | null;
  knowledge_id: string | null;
  knowledge_type: string | null;
  knowledge_status: string | null;
  knowledge_scope: string | null;
  knowledge_title: string | null;
  knowledge_body: string | null;
  knowledge_importance: number | string | null;
  knowledge_confidence: number | string | null;
  knowledge_updated_at: Date | string | null;
  outcome: CandidateOutcome;
};

const CANDIDATE_CTE = sql`
with candidate_base as (
  select
    f.id::text as id,
    f.target_state_id::text as target_state_id,
    f.candidate_index,
    f.title as original_title,
    f.content as original_body,
    f.status as original_status,
    f.created_at as original_created_at,
    f.updated_at as original_updated_at,
    t.target_kind,
    t.target_key,
    t.source_uri,
    t.status as target_status,
    t.phase as target_phase,
    t.last_outcome_kind as target_outcome_kind,
    t.last_error as target_last_error,
    t.updated_at as target_updated_at,
    c.status as cover_status,
    c.stage as cover_stage,
    c.type as cover_type,
    c.title as cover_title,
    c.body as cover_body,
    c.importance as cover_importance,
    c.confidence as cover_confidence,
    c.reason as cover_reason,
    c.updated_at as cover_updated_at,
    case
      when c.id is null then 0
      else jsonb_array_length(coalesce(c.references, '[]'::jsonb))
    end::int as cover_references_count,
    case
      when c.id is null then 0
      else jsonb_array_length(coalesce(c.duplicate_refs, '[]'::jsonb))
    end::int as cover_duplicate_refs_count,
    case
      when c.id is null then 0
      else jsonb_array_length(coalesce(c.tool_events, '[]'::jsonb))
    end::int as cover_tool_events_count
  from find_candidate_results f
  inner join distillation_target_states t on t.id = f.target_state_id
  left join cover_evidence_results c on c.id = f.id
),
candidate_with_knowledge as (
  select
    b.*,
    k.knowledge_id,
    k.knowledge_type,
    k.knowledge_status,
    k.knowledge_scope,
    k.knowledge_title,
    k.knowledge_body,
    k.knowledge_importance,
    k.knowledge_confidence,
    k.knowledge_updated_at
  from candidate_base b
  left join lateral (
    select
      ki.id::text as knowledge_id,
      ki.type as knowledge_type,
      ki.status as knowledge_status,
      ki.scope as knowledge_scope,
      ki.title as knowledge_title,
      ki.body as knowledge_body,
      ki.importance as knowledge_importance,
      ki.confidence as knowledge_confidence,
      ki.updated_at as knowledge_updated_at
    from knowledge_items ki
    where
      ki.metadata ->> 'coverEvidenceResultId' = b.id
      or ki.metadata ->> 'sourceUri' = concat('cover-evidence-result://', b.id)
    order by
      case
        when ki.metadata ->> 'coverEvidenceResultId' = b.id then 0
        else 1
      end asc,
      ki.updated_at desc
    limit 1
  ) k on true
),
candidate_with_outcome as (
  select
    ck.*,
    concat('cover-evidence-result://', ck.id) as finalize_source_uri,
    case
      when ck.knowledge_id is not null then 'stored'
      when ck.cover_status = 'knowledge_ready' and ck.knowledge_id is null then 'ready_not_finalized'
      when ck.cover_status in ('duplicate', 'near_duplicate', 'insufficient') then 'rejected'
      when ck.cover_status in ('tool_failed', 'provider_failed', 'parse_failed') then 'retryable'
      when ck.cover_status is null and ck.target_status in ('pending', 'running') then 'target_pending'
      when ck.cover_status is null then 'candidate_only'
      else 'candidate_only'
    end::text as outcome,
    greatest(
      ck.target_updated_at,
      ck.original_updated_at,
      coalesce(ck.cover_updated_at, ck.original_updated_at),
      coalesce(ck.knowledge_updated_at, ck.original_updated_at)
    ) as latest_updated_at
  from candidate_with_knowledge ck
)
`;

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function bodySimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = normalizeText(a).toLowerCase();
  const right = normalizeText(b).toLowerCase();
  if (!left && !right) return 1;
  if (!left || !right) return 0;

  const toBigrams = (input: string): Set<string> => {
    const chars = [...input];
    if (chars.length < 2) return new Set([input]);
    const set = new Set<string>();
    for (let index = 0; index < chars.length - 1; index += 1) {
      const current = chars[index];
      const next = chars[index + 1];
      if (!current || !next) continue;
      set.add(`${current}${next}`);
    }
    return set;
  };

  const leftSet = toBigrams(left);
  const rightSet = toBigrams(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;

  let intersectionCount = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersectionCount += 1;
  }
  return Number((intersectionCount / union.size).toFixed(4));
}

function buildDiff(params: {
  from: {
    title: string | null;
    body: string | null;
    type: string | null;
    importance: number | null;
    confidence: number | null;
  };
  to: {
    title: string | null;
    body: string | null;
    type: string | null;
    importance: number | null;
    confidence: number | null;
  };
}): CandidateDiffSummary {
  const titleChanged = normalizeText(params.from.title) !== normalizeText(params.to.title);
  const bodyChanged = normalizeText(params.from.body) !== normalizeText(params.to.body);
  const typeChanged = normalizeText(params.from.type) !== normalizeText(params.to.type);
  const importanceDelta =
    params.from.importance === null || params.to.importance === null
      ? null
      : Number((params.to.importance - params.from.importance).toFixed(2));
  const confidenceDelta =
    params.from.confidence === null || params.to.confidence === null
      ? null
      : Number((params.to.confidence - params.from.confidence).toFixed(2));

  const summary: string[] = [];
  if (titleChanged) summary.push("title changed");
  if (bodyChanged) summary.push("body changed");
  if (typeChanged) summary.push("type changed");
  if (importanceDelta !== null && importanceDelta !== 0) {
    summary.push(`importance ${importanceDelta > 0 ? "+" : ""}${importanceDelta}`);
  }
  if (confidenceDelta !== null && confidenceDelta !== 0) {
    summary.push(`confidence ${confidenceDelta > 0 ? "+" : ""}${confidenceDelta}`);
  }
  if (summary.length === 0) summary.push("no visible change");

  return {
    titleChanged,
    bodyChanged,
    typeChanged,
    importanceDelta,
    confidenceDelta,
    bodySimilarity: bodySimilarity(params.from.body, params.to.body),
    summary,
  };
}

function mapRowToItem(row: CandidateSqlRow): CandidateListItem {
  const coverImportance = row.cover_importance === null ? null : toNumber(row.cover_importance);
  const coverConfidence = row.cover_confidence === null ? null : toNumber(row.cover_confidence);
  const knowledgeImportance =
    row.knowledge_importance === null ? null : toNumber(row.knowledge_importance);
  const knowledgeConfidence =
    row.knowledge_confidence === null ? null : toNumber(row.knowledge_confidence);

  const original = {
    title: row.original_title,
    body: row.original_body,
    status: row.original_status,
    createdAt: toIso(row.original_created_at),
    updatedAt: toIso(row.original_updated_at),
  };

  const cover: CandidateListItem["cover"] =
    row.cover_status === null || row.cover_stage === null
      ? null
      : {
          status: row.cover_status,
          stage: row.cover_stage,
          type: row.cover_type === "rule" || row.cover_type === "procedure" ? row.cover_type : null,
          title: row.cover_title,
          body: row.cover_body,
          importance: coverImportance,
          confidence: coverConfidence,
          reason: row.cover_reason,
          referencesCount: toNumber(row.cover_references_count),
          duplicateRefsCount: toNumber(row.cover_duplicate_refs_count),
          toolEventsCount: toNumber(row.cover_tool_events_count),
          updatedAt: toIso(row.cover_updated_at),
        };

  const knowledge =
    row.knowledge_id === null
      ? null
      : {
          id: row.knowledge_id,
          type: row.knowledge_type ?? "rule",
          status: row.knowledge_status ?? "draft",
          scope: row.knowledge_scope ?? "repo",
          title: row.knowledge_title ?? "",
          body: row.knowledge_body ?? "",
          importance: knowledgeImportance,
          confidence: knowledgeConfidence,
          updatedAt: toIso(row.knowledge_updated_at),
        };

  const originalToCover = cover
    ? buildDiff({
        from: {
          title: original.title,
          body: original.body,
          type: null,
          importance: null,
          confidence: null,
        },
        to: {
          title: cover.title,
          body: cover.body,
          type: cover.type,
          importance: cover.importance,
          confidence: cover.confidence,
        },
      })
    : null;

  const coverToKnowledge =
    cover && knowledge
      ? buildDiff({
          from: {
            title: cover.title,
            body: cover.body,
            type: cover.type,
            importance: cover.importance,
            confidence: cover.confidence,
          },
          to: {
            title: knowledge.title,
            body: knowledge.body,
            type: knowledge.type,
            importance: knowledge.importance,
            confidence: knowledge.confidence,
          },
        })
      : null;

  const originalToKnowledge = knowledge
    ? buildDiff({
        from: {
          title: original.title,
          body: original.body,
          type: null,
          importance: null,
          confidence: null,
        },
        to: {
          title: knowledge.title,
          body: knowledge.body,
          type: knowledge.type,
          importance: knowledge.importance,
          confidence: knowledge.confidence,
        },
      })
    : null;

  return {
    id: row.id,
    targetStateId: row.target_state_id,
    candidateIndex: toNumber(row.candidate_index),
    targetKind: row.target_kind === "vibe_memory" ? "vibe_memory" : "wiki_file",
    targetKey: row.target_key,
    sourceUri: row.source_uri,
    finalizeSourceUri: row.finalize_source_uri,
    targetStatus: row.target_status,
    targetPhase: row.target_phase,
    targetOutcomeKind: row.target_outcome_kind,
    targetLastError: row.target_last_error,
    latestUpdatedAt: toIso(row.latest_updated_at),
    original,
    cover,
    knowledge,
    outcome: row.outcome,
    diff: {
      originalToCover,
      coverToKnowledge,
      originalToKnowledge,
    },
  };
}

function buildFilters(params: CandidateListQuery, includeOutcome: boolean): SQL | undefined {
  const conditions: SQL[] = [];
  const query = params.query?.trim();
  const targetStateId = params.targetStateId?.trim();

  if (params.targetKind && params.targetKind !== "all") {
    conditions.push(sql`target_kind = ${params.targetKind}`);
  }

  if (params.hasKnowledge === "yes") {
    conditions.push(sql`knowledge_id is not null`);
  }
  if (params.hasKnowledge === "no") {
    conditions.push(sql`knowledge_id is null`);
  }

  if (includeOutcome && params.outcome && params.outcome !== "all") {
    conditions.push(sql`outcome = ${params.outcome}`);
  }

  if (targetStateId) {
    conditions.push(sql`target_state_id = ${targetStateId}`);
  }

  if (query) {
    const pattern = `%${query}%`;
    conditions.push(
      sql`(
        target_key ilike ${pattern}
        or original_title ilike ${pattern}
        or original_body ilike ${pattern}
        or coalesce(cover_title, '') ilike ${pattern}
        or coalesce(cover_body, '') ilike ${pattern}
        or coalesce(knowledge_title, '') ilike ${pattern}
        or coalesce(knowledge_body, '') ilike ${pattern}
      )`,
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listCandidateItems(params: CandidateListQuery): Promise<CandidateListResult> {
  const offset = Math.max(0, params.page - 1) * params.limit;
  const listWhere = buildFilters(params, true);
  const statsWhere = buildFilters(params, false);

  const [itemsResult, totalResult, statsResult] = await Promise.all([
    db.execute(sql`
      ${CANDIDATE_CTE}
      select *
      from candidate_with_outcome
      ${listWhere ? sql`where ${listWhere}` : sql``}
      order by latest_updated_at desc, candidate_index asc
      limit ${params.limit}
      offset ${offset}
    `),
    db.execute(sql`
      ${CANDIDATE_CTE}
      select count(*)::int as total
      from candidate_with_outcome
      ${listWhere ? sql`where ${listWhere}` : sql``}
    `),
    db.execute(sql`
      ${CANDIDATE_CTE}
      select
        count(*)::int as total,
        count(*) filter (where outcome = 'stored')::int as stored,
        count(*) filter (where outcome = 'ready_not_finalized')::int as ready_not_finalized,
        count(*) filter (where outcome = 'rejected')::int as rejected,
        count(*) filter (where outcome = 'retryable')::int as retryable,
        count(*) filter (where outcome = 'target_pending')::int as target_pending,
        count(*) filter (where outcome = 'candidate_only')::int as candidate_only
      from candidate_with_outcome
      ${statsWhere ? sql`where ${statsWhere}` : sql``}
    `),
  ]);

  const rows = itemsResult.rows as CandidateSqlRow[];
  const totalRow = (totalResult.rows[0] ?? {}) as Record<string, unknown>;
  const statsRow = (statsResult.rows[0] ?? {}) as Record<string, unknown>;

  return {
    items: rows.map(mapRowToItem),
    total: toNumber(totalRow.total),
    stats: {
      total: toNumber(statsRow.total),
      stored: toNumber(statsRow.stored),
      readyNotFinalized: toNumber(statsRow.ready_not_finalized),
      rejected: toNumber(statsRow.rejected),
      retryable: toNumber(statsRow.retryable),
      targetPending: toNumber(statsRow.target_pending),
      candidateOnly: toNumber(statsRow.candidate_only),
    },
  };
}
