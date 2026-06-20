import { type SQL, and, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { db } from "../../../src/db/index.js";
import type { SqliteCoreDatabase } from "../../../src/db/sqlite/index.js";
import {
  type CandidateDiffSummary,
  type CandidateListItem,
  type CandidateListQuery,
  type CandidateListResult,
  type CandidateListSortBy,
  type CandidateListSortDir,
  type CandidateListStats,
  type CandidateOutcome,
  type LandscapeLinkStatus,
  candidateListSortByValues,
  candidateOutcomeValues,
  landscapeLinkStatusValues,
} from "./candidates.types.js";

export {
  candidateListSortByValues,
  candidateOutcomeValues,
  landscapeLinkStatusValues,
  type CandidateDiffSummary,
  type CandidateListItem,
  type CandidateListQuery,
  type CandidateListResult,
  type CandidateListSortBy,
  type CandidateListSortDir,
  type CandidateListStats,
  type CandidateOutcome,
  type LandscapeLinkStatus,
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
  candidate_origin_source: string | null;
  landscape_link_id: string | null;
  landscape_review_item_id: string | null;
  landscape_review_item_reason: string | null;
  landscape_review_item_evidence: unknown;
  landscape_link_status: string | null;
  outcome: CandidateOutcome;
};

async function getSqliteCoreDatabase(): Promise<SqliteCoreDatabase> {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

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
    coalesce(c.status, ecr.status) as cover_status,
    coalesce(c.stage, ecr.stage) as cover_stage,
    coalesce(c.type, ecr.type) as cover_type,
    coalesce(c.title, ecr.title) as cover_title,
    coalesce(c.body, ecr.body) as cover_body,
    coalesce(c.importance, ecr.importance) as cover_importance,
    coalesce(c.confidence, ecr.confidence) as cover_confidence,
    coalesce(c.reason, ecr.reason) as cover_reason,
    coalesce(c.updated_at, ecr.updated_at) as cover_updated_at,
    f.origin ->> 'source' as candidate_origin_source,
    l.id::text as landscape_link_id,
    coalesce(l.review_item_id::text, f.origin ->> 'reviewItemId') as landscape_review_item_id,
    coalesce(ri.reason, f.origin ->> 'reason') as landscape_review_item_reason,
    coalesce(ri.evidence, f.origin -> 'evidence', '[]'::jsonb) as landscape_review_item_evidence,
    l.status as landscape_link_status,
    case
      when c.id is null and ecr.id is null then 0
      else jsonb_array_length(coalesce(c.references, ecr.references, '[]'::jsonb))
    end::int as cover_references_count,
    case
      when c.id is null and ecr.id is null then 0
      else jsonb_array_length(coalesce(c.duplicate_refs, ecr.duplicate_refs, '[]'::jsonb))
    end::int as cover_duplicate_refs_count,
    case
      when c.id is null and ecr.id is null then 0
      else jsonb_array_length(coalesce(c.tool_events, ecr.tool_events, '[]'::jsonb))
    end::int as cover_tool_events_count
  from find_candidate_results f
  inner join distillation_target_states t on t.id = f.target_state_id
  left join cover_evidence_results c on c.id = f.id
  left join finding_candidate_queue fq
    on fq.source_kind = t.target_kind
    and fq.source_key = t.target_key
    and fq.distillation_version = t.distillation_version
  left join found_candidates fc
    on fc.finding_job_id = fq.id
    and fc.candidate_index = f.candidate_index
  left join evidence_coverage_results ecr on ecr.found_candidate_id = fc.id
  left join landscape_review_item_candidate_links l on l.find_candidate_result_id = f.id
  left join landscape_review_items ri on ri.id = l.review_item_id
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
      when ck.cover_status in ('reprocess_requested', 'tool_failed', 'provider_failed', 'parse_failed')
        and (
          ck.target_status in ('pending', 'running')
          or (
            ck.target_status = 'paused'
            and ck.target_outcome_kind in ('cover_evidence_retryable', 'cover_evidence_checkpoint')
          )
        ) then 'retryable'
      when ck.cover_status in ('reprocess_requested', 'tool_failed', 'provider_failed', 'parse_failed') then 'retained_failure'
      when ck.cover_status is null and ck.target_status in ('pending', 'running') then 'target_pending'
      when ck.cover_status is null then 'candidate_only'
      else 'candidate_only'
    end::text as outcome,
    greatest(
      ck.original_updated_at,
      coalesce(ck.cover_updated_at, ck.original_updated_at),
      coalesce(ck.target_updated_at, ck.original_updated_at),
      coalesce(ck.knowledge_updated_at, ck.original_updated_at)
    ) as latest_updated_at
  from candidate_with_knowledge ck
)
`;

function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toTargetKind(
  value: unknown,
): "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest" {
  if (value === "vibe_memory" || value === "knowledge_candidate" || value === "web_ingest") {
    return value;
  }
  return "wiki_file";
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    let str = value.trim();
    if (!str.endsWith("Z") && !str.includes("+") && !/[-+]\d{2}:?\d{2}$/.test(str)) {
      str = str.replace(" ", "T");
      if (!str.includes("T")) {
        str += "T00:00:00Z";
      } else {
        str += "Z";
      }
    }
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return normalizeStringArray(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return [...deduped];
}

function toLandscapeLinkStatus(value: unknown): LandscapeLinkStatus | null {
  if (typeof value !== "string") return null;
  return landscapeLinkStatusValues.includes(value as LandscapeLinkStatus)
    ? (value as LandscapeLinkStatus)
    : null;
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

function buildLandscapeWarning(row: CandidateSqlRow): CandidateListItem["landscapeWarning"] {
  if (row.candidate_origin_source !== "landscape_review_item") return null;
  const linkStatus = toLandscapeLinkStatus(row.landscape_link_status);
  const reason = normalizeText(row.landscape_review_item_reason);
  const hasPromotionGateReason = reason === "promotion_gate_review";
  const hasReviewRequiredStatus = linkStatus === "review_required";
  if (!hasPromotionGateReason && !hasReviewRequiredStatus) return null;
  return {
    source: "landscape_review_item",
    linkId: row.landscape_link_id,
    reviewItemId: row.landscape_review_item_id,
    reason: reason || null,
    evidence: normalizeStringArray(row.landscape_review_item_evidence),
    linkStatus,
    requiresManualApproval: true,
    warningReason: hasPromotionGateReason ? "promotion_gate_review" : "review_required",
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
    targetKind: toTargetKind(row.target_kind),
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
    landscapeWarning: buildLandscapeWarning(row),
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
  const shouldIncludeStored =
    params.includeStored === true || params.outcome === "stored" || params.hasKnowledge === "yes";

  if (params.targetKind && params.targetKind !== "all") {
    conditions.push(sql`target_kind = ${params.targetKind}`);
  }

  if (!shouldIncludeStored) {
    conditions.push(sql`outcome <> 'stored'`);
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

function buildOrderBy(params: Pick<CandidateListQuery, "sortBy" | "sortDir">): SQL {
  const sortBy = params.sortBy ?? "latestUpdatedAt";
  const direction = params.sortDir === "asc" ? sql`asc` : sql`desc`;
  const sortableColumns = {
    targetKey: sql`lower(target_key)`,
    candidateTitle: sql`lower(original_title)`,
    coverageStatus: sql`coalesce(cover_status, '')`,
    knowledgeStatus: sql`coalesce(knowledge_status, '')`,
    outcome: sql`outcome`,
    qualityScore: sql`(
      coalesce(cover_importance, knowledge_importance, 0) * 0.6
      + coalesce(cover_confidence, knowledge_confidence, 0) * 0.4
    )`,
    latestUpdatedAt: sql`latest_updated_at`,
  } satisfies Record<CandidateListSortBy, SQL>;
  const selected = sortableColumns[sortBy] ?? sortableColumns.latestUpdatedAt;
  return sql`${selected} ${direction}, latest_updated_at desc, candidate_index asc, id asc`;
}

const SQLITE_CANDIDATE_QUERY = `
with candidate_base as (
  select
    f.id as id,
    f.target_state_id as target_state_id,
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
    coalesce(c.status, ecr.status) as cover_status,
    coalesce(c.stage, ecr.stage) as cover_stage,
    coalesce(c.type, ecr.type) as cover_type,
    coalesce(c.title, ecr.title) as cover_title,
    coalesce(c.body, ecr.body) as cover_body,
    coalesce(c.importance, ecr.importance) as cover_importance,
    coalesce(c.confidence, ecr.confidence) as cover_confidence,
    coalesce(c.reason, ecr.reason) as cover_reason,
    coalesce(c.updated_at, ecr.updated_at) as cover_updated_at,
    json_extract(f.origin, '$.source') as candidate_origin_source,
    l.id as landscape_link_id,
    coalesce(l.review_item_id, json_extract(f.origin, '$.reviewItemId')) as landscape_review_item_id,
    coalesce(ri.reason, json_extract(f.origin, '$.reason')) as landscape_review_item_reason,
    coalesce(ri.evidence, json_extract(f.origin, '$.evidence'), '[]') as landscape_review_item_evidence,
    l.status as landscape_link_status,
    case
      when c.id is null and ecr.id is null then 0
      else coalesce(json_array_length(coalesce(c."references", ecr."references", '[]')), 0)
    end as cover_references_count,
    case
      when c.id is null and ecr.id is null then 0
      else coalesce(json_array_length(coalesce(c.duplicate_refs, ecr.duplicate_refs, '[]')), 0)
    end as cover_duplicate_refs_count,
    case
      when c.id is null and ecr.id is null then 0
      else coalesce(json_array_length(coalesce(c.tool_events, ecr.tool_events, '[]')), 0)
    end as cover_tool_events_count
  from find_candidate_results f
  inner join distillation_target_states t on t.id = f.target_state_id
  left join cover_evidence_results c on c.id = f.id
  left join finding_candidate_queue fq
    on fq.source_kind = t.target_kind
    and fq.source_key = t.target_key
    and fq.distillation_version = t.distillation_version
  left join found_candidates fc
    on fc.finding_job_id = fq.id
    and fc.candidate_index = f.candidate_index
  left join evidence_coverage_results ecr on ecr.found_candidate_id = fc.id
  left join landscape_review_item_candidate_links l on l.find_candidate_result_id = f.id
  left join landscape_review_items ri on ri.id = l.review_item_id
),
candidate_with_outcome as (
  select
    cb.*,
    'cover-evidence-result://' || cb.id as finalize_source_uri,
    null as knowledge_id,
    null as knowledge_type,
    null as knowledge_status,
    null as knowledge_scope,
    null as knowledge_title,
    null as knowledge_body,
    null as knowledge_importance,
    null as knowledge_confidence,
    null as knowledge_updated_at,
    'candidate_only' as outcome,
    max(
      cb.original_updated_at,
      coalesce(cb.cover_updated_at, cb.original_updated_at),
      coalesce(cb.target_updated_at, cb.original_updated_at)
    ) as latest_updated_at
  from candidate_base cb
)
select *
from candidate_with_outcome
`;

type SqliteKnowledgeCandidateRow = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  importance: number | string | null;
  confidence: number | string | null;
  updated_at: string;
  metadata: string;
};

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function recomputeCandidateOutcome(row: CandidateSqlRow): CandidateOutcome {
  if (row.knowledge_id !== null) return "stored";
  if (row.cover_status === "knowledge_ready") return "ready_not_finalized";
  if (
    row.cover_status === "duplicate" ||
    row.cover_status === "near_duplicate" ||
    row.cover_status === "insufficient"
  ) {
    return "rejected";
  }
  if (
    row.cover_status === "reprocess_requested" ||
    row.cover_status === "tool_failed" ||
    row.cover_status === "provider_failed" ||
    row.cover_status === "parse_failed"
  ) {
    if (
      row.target_status === "pending" ||
      row.target_status === "running" ||
      (row.target_status === "paused" &&
        (row.target_outcome_kind === "cover_evidence_retryable" ||
          row.target_outcome_kind === "cover_evidence_checkpoint"))
    ) {
      return "retryable";
    }
    return "retained_failure";
  }
  if (
    row.cover_status === null &&
    (row.target_status === "pending" || row.target_status === "running")
  ) {
    return "target_pending";
  }
  return "candidate_only";
}

function applyKnowledgeToCandidateRows(
  rows: CandidateSqlRow[],
  knowledgeRows: SqliteKnowledgeCandidateRow[],
): CandidateSqlRow[] {
  const byCandidateId = new Map<string, SqliteKnowledgeCandidateRow>();
  const bySourceUri = new Map<string, SqliteKnowledgeCandidateRow>();
  for (const knowledge of knowledgeRows) {
    const metadata = parseJsonRecord(knowledge.metadata);
    const coverEvidenceResultId =
      typeof metadata.coverEvidenceResultId === "string" ? metadata.coverEvidenceResultId : null;
    const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri : null;
    if (coverEvidenceResultId && !byCandidateId.has(coverEvidenceResultId)) {
      byCandidateId.set(coverEvidenceResultId, knowledge);
    }
    if (sourceUri && !bySourceUri.has(sourceUri)) {
      bySourceUri.set(sourceUri, knowledge);
    }
  }

  return rows.map((row) => {
    const knowledge = byCandidateId.get(row.id) ?? bySourceUri.get(row.finalize_source_uri);
    const next: CandidateSqlRow = knowledge
      ? {
          ...row,
          knowledge_id: knowledge.id,
          knowledge_type: knowledge.type,
          knowledge_status: knowledge.status,
          knowledge_scope: knowledge.scope,
          knowledge_title: knowledge.title,
          knowledge_body: knowledge.body,
          knowledge_importance: knowledge.importance,
          knowledge_confidence: knowledge.confidence,
          knowledge_updated_at: knowledge.updated_at,
        }
      : row;
    next.outcome = recomputeCandidateOutcome(next);
    if (
      next.knowledge_updated_at !== null &&
      Date.parse(toIso(next.knowledge_updated_at)) > Date.parse(toIso(next.latest_updated_at))
    ) {
      next.latest_updated_at = next.knowledge_updated_at;
    }
    return next;
  });
}

function matchesCandidateFilters(
  row: CandidateSqlRow,
  params: CandidateListQuery,
  includeOutcome: boolean,
): boolean {
  const query = params.query?.trim().toLowerCase();
  const targetStateId = params.targetStateId?.trim();
  const shouldIncludeStored =
    params.includeStored === true || params.outcome === "stored" || params.hasKnowledge === "yes";

  if (params.targetKind && params.targetKind !== "all" && row.target_kind !== params.targetKind) {
    return false;
  }
  if (!shouldIncludeStored && row.outcome === "stored") {
    return false;
  }
  if (params.hasKnowledge === "yes" && row.knowledge_id === null) {
    return false;
  }
  if (params.hasKnowledge === "no" && row.knowledge_id !== null) {
    return false;
  }
  if (
    includeOutcome &&
    params.outcome &&
    params.outcome !== "all" &&
    row.outcome !== params.outcome
  ) {
    return false;
  }
  if (targetStateId && row.target_state_id !== targetStateId) {
    return false;
  }
  if (!query) return true;

  return [
    row.target_key,
    row.original_title,
    row.original_body,
    row.cover_title,
    row.cover_body,
    row.knowledge_title,
    row.knowledge_body,
  ].some((value) => normalizeText(value).toLowerCase().includes(query));
}

function candidateQualityScore(row: CandidateSqlRow): number {
  return (
    toNumber(row.cover_importance ?? row.knowledge_importance, 0) * 0.6 +
    toNumber(row.cover_confidence ?? row.knowledge_confidence, 0) * 0.4
  );
}

function compareCandidateRows(
  params: Pick<CandidateListQuery, "sortBy" | "sortDir">,
  left: CandidateSqlRow,
  right: CandidateSqlRow,
): number {
  const direction = params.sortDir === "asc" ? 1 : -1;
  const sortBy = params.sortBy ?? "latestUpdatedAt";
  const stringValue = (row: CandidateSqlRow): string => {
    if (sortBy === "targetKey") return normalizeText(row.target_key).toLowerCase();
    if (sortBy === "candidateTitle") return normalizeText(row.original_title).toLowerCase();
    if (sortBy === "coverageStatus") return normalizeText(row.cover_status);
    if (sortBy === "knowledgeStatus") return normalizeText(row.knowledge_status);
    if (sortBy === "outcome") return normalizeText(row.outcome);
    return toIso(row.latest_updated_at);
  };
  const numberValue = (row: CandidateSqlRow): number => {
    if (sortBy === "qualityScore") return candidateQualityScore(row);
    return Date.parse(toIso(row.latest_updated_at));
  };

  let primary = 0;
  if (sortBy === "qualityScore" || sortBy === "latestUpdatedAt") {
    primary =
      numberValue(left) === numberValue(right)
        ? 0
        : numberValue(left) > numberValue(right)
          ? 1
          : -1;
  } else {
    primary = stringValue(left).localeCompare(stringValue(right));
  }
  if (primary !== 0) return primary * direction;

  const updatedTie =
    Date.parse(toIso(right.latest_updated_at)) - Date.parse(toIso(left.latest_updated_at));
  if (updatedTie !== 0) return updatedTie;
  const indexTie = toNumber(left.candidate_index) - toNumber(right.candidate_index);
  if (indexTie !== 0) return indexTie;
  return left.id.localeCompare(right.id);
}

async function listCandidateItemsSqlite(params: CandidateListQuery): Promise<CandidateListResult> {
  const sqlite = await getSqliteCoreDatabase();
  const candidateRows = sqlite.db.query<CandidateSqlRow, []>(SQLITE_CANDIDATE_QUERY).all();
  const knowledgeRows = sqlite.db
    .query<SqliteKnowledgeCandidateRow, []>(
      `
      select
        id,
        type,
        status,
        scope,
        title,
        body,
        importance,
        confidence,
        updated_at,
        metadata
      from knowledge_items
      where json_extract(metadata, '$.coverEvidenceResultId') is not null
        or json_extract(metadata, '$.sourceUri') like 'cover-evidence-result://%'
      order by updated_at desc
    `,
    )
    .all();
  const rows = applyKnowledgeToCandidateRows(candidateRows, knowledgeRows);
  const listRows = rows
    .filter((row) => matchesCandidateFilters(row, params, true))
    .sort((left, right) => compareCandidateRows(params, left, right));
  const statsRows = rows.filter((row) => matchesCandidateFilters(row, params, false));
  const offset = Math.max(0, params.page - 1) * params.limit;
  const pageRows = listRows.slice(offset, offset + params.limit);

  const stats: CandidateListStats = {
    total: statsRows.length,
    stored: 0,
    readyNotFinalized: 0,
    rejected: 0,
    retryable: 0,
    retainedFailure: 0,
    targetPending: 0,
    candidateOnly: 0,
  };
  for (const row of statsRows) {
    if (row.outcome === "stored") stats.stored += 1;
    if (row.outcome === "ready_not_finalized") stats.readyNotFinalized += 1;
    if (row.outcome === "rejected") stats.rejected += 1;
    if (row.outcome === "retryable") stats.retryable += 1;
    if (row.outcome === "retained_failure") stats.retainedFailure += 1;
    if (row.outcome === "target_pending") stats.targetPending += 1;
    if (row.outcome === "candidate_only") stats.candidateOnly += 1;
  }

  return {
    items: pageRows.map(mapRowToItem),
    total: listRows.length,
    stats,
  };
}

export async function listCandidateItems(params: CandidateListQuery): Promise<CandidateListResult> {
  if (isSqliteBackend()) {
    return listCandidateItemsSqlite(params);
  }

  const offset = Math.max(0, params.page - 1) * params.limit;
  const listWhere = buildFilters(params, true);
  const statsWhere = buildFilters(params, false);
  const orderBy = buildOrderBy(params);

  const [itemsResult, totalResult, statsResult] = await Promise.all([
    db.execute(sql`
      ${CANDIDATE_CTE}
      select *
      from candidate_with_outcome
      ${listWhere ? sql`where ${listWhere}` : sql``}
      order by ${orderBy}
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
        count(*) filter (where outcome = 'retained_failure')::int as retained_failure,
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
      retainedFailure: toNumber(statsRow.retained_failure),
      targetPending: toNumber(statsRow.target_pending),
      candidateOnly: toNumber(statsRow.candidate_only),
    },
  };
}
