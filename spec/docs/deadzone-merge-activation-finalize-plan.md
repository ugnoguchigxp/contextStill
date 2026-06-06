# DeadZone Merge Activation Finalize Plan

Status: planned  
Created: 2026-06-06  
Owner: ContextStill admin / Knowledge Landscape

## Purpose

DeadZone merge review で作った merged knowledge を、単なる body 統合で終わらせず、retrieval-ready な knowledge として仕上げる。

現状の `deadZoneMergeReview` は LLM に merge 可否と proposed canonical body を作らせ、apply 時に canonical body を更新し、DeadZone knowledge を `deprecated` にする。ただし `appliesTo.technologies`、`appliesTo.changeTypes`、`appliesTo.domains` は再評価されない。これでは、せっかく merge した知識が検索されないまま残る可能性がある。

一方で、DeadZone は必ずしも「価値があるが届いていない知識」だけではない。ユーザーの実タスク分布では単に使われにくい知識、一般知識としては有効だが個人化された retrieval では不要な知識、scope が広すぎる/狭すぎる知識が混ざる。

この計画では、Merge Review の後段に `merge_activation_finalize` を置き、Queue UI 上は `Finalize` に統合する。Finalize を「新規 knowledge 登録専用」ではなく、「knowledge を retrieval-ready に仕上げる最終段」として拡張する。

## Decision

Queue UI では `Finalize` に統合する。

Implementation では job type を分ける。Visible lane と storage/worker boundary を混同しない。

- `candidate_finalize`
  - existing `coveringEvidence -> finalizeDistille`
  - `evidence_coverage_results` 起点
  - draft knowledge 作成、source links、embedding を担当
- `merge_activation_finalize`
  - `deadZoneMergeReview -> finalize`
  - existing knowledge 起点
  - canonical body / appliesTo / metadata / embedding 更新と DeadZone の merged deprecation を担当

`deadZoneMergeReview` は review/decision/proposed body までを担当する。実際の knowledge mutation と retrieval-ready 化は Finalize 側へ移す。

Do not force `merge_activation_finalize` into the current `finalize_distille_queue` row shape without schema changes. Current `finalize_distille_queue.evidence_result_id` is `not null` and semantically tied to candidate finalization. Reusing it with dummy evidence rows would hide the real source of the operation and make queue diagnostics misleading.

Adopt the minimal safe storage model: keep `finalize_distille_queue` unchanged for `candidate_finalize`, add `merge_activation_finalize_queue` for `merge_activation_finalize`, and make Queue API/UI present both as the visible `Finalize` lane. This avoids a broad migration of existing finalize jobs while still giving operators one finalization surface.

## Conceptual Flow

```txt
CoveringEvidence
  -> Finalize(candidate_finalize)
      -> draft knowledge + source links + embedding

DeadZoneMergeReview
  -> Finalize(merge_activation_finalize)
      -> activation review using landscape/community/replay/usage context
      -> canonical update + appliesTo refinement + metadata.merged + embedding
      -> deadZone deprecated + metadata.mergedInto
```

## Activation Outcomes

`merge_activation_finalize` must not assume every merge should become more active. It should classify the merged result.

```ts
type MergeActivationOutcome =
  | "personalized_active"
  | "general_active"
  | "scope_refined"
  | "dormant_valid"
  | "merged_deprecated"
  | "needs_evidence"
  | "blocked";
```

Meaning:

- `personalized_active`: useful for the user's current task/repo patterns; keep active and tune appliesTo toward those patterns.
- `general_active`: valid general knowledge; keep active with broad but normalized appliesTo.
- `scope_refined`: valid only after narrowing or correcting technologies/changeTypes/domains.
- `dormant_valid`: still valid, but not currently worth active retrieval pressure.
- `merged_deprecated`: canonical absorbed enough value; DeadZone can disappear from normal view.
- `needs_evidence`: merge may be useful but source support is too weak.
- `blocked`: contradiction, stale snapshot, missing rows, status drift, or invalid LLM output.

Only `personalized_active`, `general_active`, and `scope_refined` should update canonical body/title/appliesTo as an active retrieval target. `merged_deprecated` may update metadata only when the canonical body already contains the useful content from the merge review. `dormant_valid` should preserve auditability without pretending the knowledge should be selected often.

## Data Model

Prefer adding a typed finalize work table over overloading `finalize_distille_queue` with nullable foreign keys.

Chosen migration path: keep existing `finalize_distille_queue` for `candidate_finalize` and add a separate table for merge activation, while Queue repository presents both as the `Finalize` lane.

New table: `merge_activation_finalize_queue`

Core columns:

- common queue columns: `id`, `status`, `priority`, `attempt_count`, `max_attempts`, `next_run_at`, `locked_by`, `locked_at`, `heartbeat_at`, `last_error`, `last_outcome_kind`, `payload`, `metadata`, `created_at`, `updated_at`, `completed_at`
- `merge_review_job_id uuid not null references dead_zone_merge_review_queue(id)`
- `dead_zone_knowledge_id uuid not null references knowledge_items(id)`
- `canonical_knowledge_id uuid not null references knowledge_items(id)`
- `review_item_id uuid references landscape_review_items(id) on delete set null`
- `idempotency_key text not null unique`
- `provider text not null default 'local-llm'`
- `model text`
- `input_snapshot jsonb not null default {}`
- `activation_result jsonb not null default {}`
- `knowledge_id uuid`

Indexes:

- `(status, priority, created_at)`
- `(merge_review_job_id)`
- `(dead_zone_knowledge_id, status)`
- `(canonical_knowledge_id, status)`
- `(review_item_id, status)`

Checks:

- `status in distillationQueueStatusValues`
- `jsonb_typeof(payload) = 'object'`
- `jsonb_typeof(metadata) = 'object'`
- `jsonb_typeof(input_snapshot) = 'object'`
- `jsonb_typeof(activation_result) = 'object'`
- `dead_zone_knowledge_id <> canonical_knowledge_id`

The visible queue name can remain `finalizeDistille` for compatibility, but queue list rows must expose `jobType`.

```ts
type FinalizeQueueJobType = "candidate_finalize" | "merge_activation_finalize";
```

`QueueListItem` should also expose a stable backend discriminator so row-level controls can address the correct table.

```ts
type QueueBackendKind =
  | "finding_candidate_queue"
  | "covering_evidence_queue"
  | "dead_zone_merge_review_queue"
  | "finalize_distille_queue"
  | "merge_activation_finalize_queue";

type QueueListItem = {
  queueName: DistillationQueueName;
  visibleQueueName: DistillationQueueName;
  jobType?: FinalizeQueueJobType;
  backendKind: QueueBackendKind;
  id: string;
};
```

This is required because existing queue controls resolve a table from `queueName`. Once `Finalize` is a union view, row-level retry/pause/resume cannot safely use only `queue=finalizeDistille&id=...`; it must either pass `backendKind`/`jobType` or call a typed endpoint.

## Input Snapshot

The finalize job must be reproducible and must detect stale apply attempts.

```ts
type MergeActivationFinalizeInputSnapshot = {
  mergeReviewJob: {
    id: string;
    decision: "merge_recommended";
    proposedCanonicalBody: string;
    proposedSummary: string | null;
    resultHash: string;
  };
  deadZone: {
    id: string;
    title: string;
    body: string;
    status: string;
    appliesTo: Record<string, unknown>;
    metadata: Record<string, unknown>;
    bodyHash: string;
  };
  canonical: {
    id: string;
    title: string;
    body: string;
    status: string;
    appliesTo: Record<string, unknown>;
    metadata: Record<string, unknown>;
    bodyHash: string;
  };
  landscape: {
    communityKey: string | null;
    communityLabel: string | null;
    classification: string | null;
    indicators: Record<string, unknown>;
    badges: string[];
    graphHealth: string | null;
    evidenceStrength: string | null;
    usageStrength: string | null;
    structureQuality: string | null;
  };
  replay: {
    selectedCount: number;
    offTopicCount: number;
    usefulRuns: Array<{
      runId: string;
      technologies: string[];
      changeTypes: string[];
      domains: string[];
    }>;
    appliesToRefineCandidates: Array<Record<string, unknown>>;
  };
};
```

## LLM Contract

The LLM should read Landscape, Community, replay, usage, canonical/deadZone appliesTo, and the proposed merged body. It should decide whether the merged knowledge should be activated, narrowed, kept dormant, or blocked.

Required JSON:

```ts
type MergeActivationFinalizeResult = {
  outcome: MergeActivationOutcome;
  confidence: "low" | "medium" | "high";
  rationale: string[];
  blockers: string[];
  proposedTitle: string | null;
  proposedBody: string | null;
  proposedAppliesTo: {
    general?: boolean;
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
    repoPath?: string;
    repoKey?: string;
  } | null;
  deprecatedDeadZoneMetadata: {
    deprecatedReason: "merged";
    mergedIntoKnowledgeId: string;
    mergeReviewJobId: string;
  };
  activationMetadata: {
    personalizationBasis: string[];
    generalizationBasis: string[];
    scopeWarnings: string[];
  };
  rawOutputExcerpt: string;
  parseStatus: "parsed" | "recovered" | "failed";
};
```

Rules:

- Do not invent evidence.
- Do not create new tag vocabulary outside existing normalizer expectations.
- Prefer canonical appliesTo when conflict is unresolved.
- Union technologies/changeTypes/domains only when both sides are compatible.
- Narrow scope when replay indicates off-topic retrieval risk.
- Return `dormant_valid` when the knowledge is valid but not useful for current task patterns.
- Return `needs_evidence` when source support is too weak to activate.
- Return `blocked` when body/status hashes drift.

## Deterministic AppliesTo Guardrails

LLM output must be treated as a proposal. Persistence must go through existing `updateKnowledgeItem` normalization.

Workflow:

1. Build deterministic baseline from canonical appliesTo and DeadZone appliesTo.
2. Allow LLM to propose refinements.
3. Intersect proposal with allowed tag shapes and known string-array fields.
4. If proposal is empty, fall back to deterministic baseline.
5. If conflict exists, prefer canonical scope and write warning metadata.
6. Call `updateKnowledgeItem(canonical.id, { title?, body, appliesTo, technologies, changeTypes, domains, metadata })`.
7. Rely on `updateKnowledgeItem` to normalize appliesTo and regenerate embedding when title/body changes.

Metadata should record both the proposal and the persisted decision.

```ts
metadata.deadZoneMergeActivation = {
  finalizeJobId,
  mergeReviewJobId,
  activationOutcome,
  appliedAt,
  mergedDeadZoneKnowledgeId,
  appliesToSource: "llm_refined" | "deterministic_union" | "canonical_preserved",
  appliesToWarnings,
  proposedAppliesTo,
};
```

DeadZone metadata:

```ts
metadata.deprecation = {
  reason: "merged",
  mergedIntoKnowledgeId,
  mergeReviewJobId,
  finalizeJobId,
  deprecatedAt,
};
```

## Queue and Worker Plan

Add a producer from successful merge review apply/request:

- `deadZoneMergeReview` completes with `decision = "merge_recommended"`.
- User action becomes `Send to Finalize` or `Finalize reviewed merge`.
- Producer creates one idempotent `merge_activation_finalize` job.
- The destructive knowledge mutation happens only in Finalize worker.

Claiming model:

- Keep existing `processFinalizeJob` unchanged for rows from `finalize_distille_queue`.
- Add `processMergeActivationFinalizeJob` for rows from `merge_activation_finalize_queue`.
- Queue UI presents both under `Finalize`, but worker dispatch must know the backend table.
- Do not let the generic `finalizeDistille` claim query silently ignore `merge_activation_finalize_queue`; otherwise visible pending jobs would never run.

Implementation options:

- Option 1: introduce an internal queue name such as `mergeActivationFinalize` and mark it `visibleAs: "finalizeDistille"` in API/UI.
- Option 2: keep queue names unchanged and add a typed finalize dispatcher that claims from both finalize tables.

Prefer Option 1 for smaller blast radius. It keeps common queue controls table-driven and avoids special-case union claiming. UI can still hide the internal lane by grouping it under `Finalize`.

Worker steps:

1. Claim `merge_activation_finalize` job through common queue claim semantics.
2. Load merge review job, canonical knowledge, DeadZone knowledge, Landscape row, Community context, and replay/refine candidates.
3. Validate current body hashes and statuses.
4. If stale, mark `skipped` or `failed` with `last_outcome_kind = "stale_input"`.
5. Run activation LLM.
6. Parse/recover JSON.
7. Normalize appliesTo through existing knowledge repository flow.
8. For active outcomes, update canonical title/body/appliesTo/metadata.
9. For dormant or needs-evidence outcomes, do not pretend activation succeeded; record result and leave canonical mutation conservative.
10. Deprecate DeadZone with merged metadata when merge was absorbed.
11. Mark finalize job completed and append queue events.

Failure handling:

- provider unreachable: `failed`, `last_outcome_kind = "provider_failed"`
- timeout: `failed`, `last_outcome_kind = "provider_timeout"`
- parse failed: `failed`, `last_outcome_kind = "parse_failed"`
- stale body/status: `skipped`, `last_outcome_kind = "stale_input"`
- outcome blocked: `skipped`, `last_outcome_kind = "activation_blocked"`
- dormant valid: `completed`, `last_outcome_kind = "dormant_valid"`

## Queue UI Plan

Keep visible tabs:

- Finding
- Covering
- Merge Review
- Finalize

In `Finalize`, show both job types:

- `candidate_finalize`
- `merge_activation_finalize`

The tab count and stats should aggregate both backends. The row model must keep enough backend identity for controls.

Rows should include:

- job type badge
- subject title
- subject detail
- provider/model or provider policy
- status
- outcome
- source queue/job id
- activation outcome for merge finalization
- backend kind, hidden from normal display but used by row actions

For `merge_activation_finalize`, subject should be canonical title, with detail:

```txt
deadZone=<id> | canonical=<id> | mergeReview=<id>
```

Completed drawer:

- activation outcome
- proposed appliesTo
- persisted appliesTo
- scope warnings
- body diff
- Landscape/community/replay summary
- metadata markers

The old `deadZoneMergeReview` completed drawer should no longer directly mutate knowledge. Its primary action should enqueue Finalize.

Row controls:

- lane pause/resume for visible `Finalize` should affect both `candidate_finalize` and `merge_activation_finalize`, or display separate scoped controls.
- row retry/pause/resume must route to the backend table of that row.
- bulk retry from the `Finalize` tab must include job type filters, so candidate finalization is not retried accidentally when the operator only means merge activation.

## API Plan

Add endpoints:

- `POST /api/graph/landscape/dead-zone-knowledge/merge-review-jobs/:id/finalize`
- `GET /api/queue?queue=finalizeDistille&type=merge_activation_finalize`
- `POST /api/queue/:backendKind/:id/retry` or equivalent typed row action route
- `POST /api/queue/:backendKind/:id/pause`
- `POST /api/queue/:backendKind/:id/resume`

Potential internal service names:

- `createMergeActivationFinalizeJob`
- `processMergeActivationFinalizeJob`
- `buildMergeActivationFinalizeSnapshot`
- `runMergeActivationFinalizeLlm`

Do not expose an API that bypasses the finalize queue and directly applies merge activation, except possibly a dry-run endpoint for tests/admin diagnostics.

## Migration Strategy

Milestone 1: Metadata and plan-safe apply boundary

- Stop treating merge review apply as final mutation in the UI.
- Add metadata contract for merged/deprecated markers.
- Keep old direct apply route temporarily for compatibility, but demote from UI.

Milestone 2: Merge activation finalize queue table

- Add `merge_activation_finalize_queue` migration.
- Add Drizzle schema.
- Add repository/service create/list/process functions.
- Add either internal queue name `mergeActivationFinalize` with `visibleAs: "finalizeDistille"` or a typed finalize dispatcher.
- Add queue stats/list union support under visible `Finalize`.
- Add backend-aware row controls before exposing merge activation rows in the UI.

Milestone 3: Producer and UI

- Change completed `merge_recommended` merge review action to enqueue Finalize.
- Add job type badge and filtering in Queue page.
- Show merge activation rows in Finalize.
- Ensure lane-level pause/resume semantics are explicit for both finalize backends.

Milestone 4: Activation LLM and appliesTo normalization

- Add prompt/parser.
- Include Landscape, Community, replay, usage, canonical/deadZone appliesTo.
- Normalize tags through `updateKnowledgeItem`.
- Persist activation and deprecation metadata.

Milestone 5: Remove direct destructive apply

- Remove or restrict direct `applyDeadZoneMergeReviewJob`.
- Ensure all destructive merge application goes through Finalize.
- Keep audit trail and rollback visibility.

## Test Plan

Schema tests:

- `merge_activation_finalize_queue` exists with queue status checks.
- idempotency key prevents duplicate finalize jobs.
- visible Finalize stats include both candidate and merge activation rows.
- queue list rows expose `jobType` and backend discriminator.

Service tests:

- create finalize job rejects non-`merge_recommended` merge review.
- create finalize job snapshots canonical/deadZone body hashes.
- worker rejects stale body/status.
- worker persists `deadZoneMergeActivation` metadata on canonical.
- worker persists merged deprecation metadata on DeadZone.
- worker normalizes technologies/changeTypes/domains through `updateKnowledgeItem`.
- dormant outcome records result without over-activating knowledge.

Queue worker tests:

- `candidate_finalize` continues to use existing finalize behavior.
- `merge_activation_finalize` uses activation worker.
- pause/resume/retry works for both visible Finalize job types.
- row retry/pause/resume routes to the correct backend table.
- visible Finalize lane controls either pause both backends or expose separate scoped controls.
- concurrent claims do not double-apply the same merge.

Component tests:

- Merge Review completed action says `Send to Finalize`.
- Finalize tab shows job type badge.
- Finalize stats aggregate candidate and merge activation jobs.
- Merge activation drawer shows activation outcome and appliesTo diff.
- Direct destructive apply is not the primary path.

## Review Checklist

Before implementation starts:

- Confirm whether Option 1 (`mergeActivationFinalize` internal queue name) or Option 2 (typed finalize dispatcher) is selected.
- Confirm Queue row actions can address separate backend tables before UI union is shipped.
- Confirm `dormant_valid` and `merged_deprecated` mutation semantics with product owner.
- Confirm whether source docs need updates at the same time as implementation:
  - `spec/pub/architecture.md`
  - `spec/pub/operations.md`
  - `spec/pub/cli.md`
- Confirm migration can be smoke-tested on a fresh database and on the current local database.

During implementation review:

- Verify reachability risk and community context are loaded before replay comparison is interpreted.
- Verify LLM proposals are normalized before persistence.
- Verify metadata records both the proposal and the persisted appliesTo decision.
- Verify direct destructive merge apply is not exposed as the primary UI action.

Verification:

```bash
bunx vitest run test/landscape-deadzone-review.service.test.ts test/queue-worker.test.ts test/components/admin/landscape-page.test.tsx test/components/admin/queue-page.test.tsx
bun run verify
```

## Open Questions

- Should `dormant_valid` deprecate the DeadZone item immediately, or keep it active with a low-priority marker until a human confirms?
- Should `general_active` be allowed to broaden `general: true`, or should it require human review?
- Should activation use local-llm only, or allow explicit cloud retry from Queue UI?
- Should replay evidence be mandatory for activation, or optional when Landscape/community signals are strong?

## Recommendation

Proceed with this direction.

The important boundary is not whether the visible tab is called `Finalize`; it should be. The important boundary is that Finalize must become a typed finalization lane rather than a single evidence-result-specific operation.

The safest implementation is to keep the existing candidate finalize path intact, add a typed merge activation finalize table/worker, and make Queue UI present both under `Finalize`. This gives the user-facing model one final stage while preserving clean storage and worker responsibilities.
