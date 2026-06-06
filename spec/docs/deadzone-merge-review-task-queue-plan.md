# DeadZone Merge Review Task Queue Plan

Status: implemented  
Created: 2026-06-06  
Owner: ContextStill admin / Knowledge Landscape

Implemented: 2026-06-06

Implementation notes:

- `deadZoneMergeReview` queue lane, DB table, migration, worker branch, queue controls, Queue UI tab, and CLI script are implemented.
- DeadZone merge actions in the Landscape UI now enqueue LLM review jobs instead of directly applying destructive merges.
- Completed `merge_recommended` jobs can be explicitly applied from the DeadZone review row; apply verifies snapshot body hashes and updates canonical knowledge through `updateKnowledgeItem`.
- Queue retry/pause/resume works through the shared queue controls.

## Purpose

DeadZone Review Queue の destructive merge を、即時適用ではなく local-llm による検証・清書・merge preview 生成へ切り替える。

既存の `premiumCoveringEvidence` は covering-evidence 再処理の premium lane として設計されているが、実体は `coveringEvidence` と同じ処理を別テーブルで走らせるだけになっている。これは DeadZone knowledge maintenance には責務が合わず、Queue UI と保守境界を紛らわしくする。

`premiumCoveringEvidence` は即削除する。Cloud API を使った cover evidence 再処理は `covering_evidence_queue.provider_policy = 'cloud_api'` として残し、premium queue という独立 lane は廃止する。

## Decision

新しい queue name を `deadZoneMergeReview` とする。

- primary provider は `local-llm`
- default fallback は空にする
- cloud API への自動 fallback はしない
- job は merge を自動適用しない
- worker は LLM 検証結果と清書済み proposed body を保存する
- UI は proposed diff を表示し、人間の明示 confirm 後にだけ knowledge を更新する
- canonical body 更新時は既存 `updateKnowledgeItem` による embedding 再生成を使う

`premiumCoveringEvidence` は互換維持しない。削除 migration で table、queue enum、queue events check、evidence producer check、Queue UI tab、worker branch を同時に落とす。

## Delete `premium_covering_evidence_queue`

`premium_covering_evidence_queue` は `found_candidate_id` を必須にしている。DeadZone merge review の主語は `knowledge_items` と `landscape_review_items` なので、同じテーブルへ押し込むと次の歪みが出る。

- `found_candidate_id` が存在しない job を表せない
- Queue page の subject が candidate 前提になる
- worker が `runCoverEvidence` 前提になる
- result が `evidence_coverage_results` 前提になる
- provider policy が `cloud_api` escalation 前提になる

DeadZone merge review は「candidate evidence covering」ではなく「existing knowledge maintenance」なので、別テーブル・別workerで切る。

Deletion boundary:

- Remove `premiumCoveringEvidence` from queue name constants.
- Drop `premium_covering_evidence_queue`.
- Remove worker branch that reuses `processCoveringJob`.
- Remove Queue page Premium tab.
- Remove premium producer value from `evidence_coverage_results`.
- Delete or discard historical premium queue events/results during migration.
- Keep `covering_evidence_queue.provider_policy`.
- Keep `cloud_api` cover evidence reprocess requests.

## Queue Model

Add table: `dead_zone_merge_review_queue`

Required common queue columns:

- `id uuid primary key default gen_random_uuid()`
- `status text default 'pending'`
- `priority integer default 50`
- `attempt_count integer default 0`
- `max_attempts integer default 2`
- `next_run_at timestamp`
- `locked_by text`
- `locked_at timestamp`
- `heartbeat_at timestamp`
- `last_error text`
- `last_outcome_kind text`
- `payload jsonb default {}`
- `metadata jsonb default {}`
- `created_at timestamp default now`
- `updated_at timestamp default now`
- `completed_at timestamp`

DeadZone-specific columns:

- `review_item_id uuid references landscape_review_items(id) on delete set null`
- `dead_zone_knowledge_id uuid references knowledge_items(id) on delete cascade`
- `canonical_knowledge_id uuid references knowledge_items(id) on delete set null`
- `idempotency_key text not null unique`
- `provider text not null default 'local-llm'`
- `model text`
- `input_snapshot jsonb not null default {}`
- `result jsonb not null default {}`

Indexes:

- `(status, priority, created_at)`
- `(dead_zone_knowledge_id, status)`
- `(canonical_knowledge_id, status)`
- `(review_item_id, status)`

Checks:

- `status in distillationQueueStatusValues`
- `jsonb_typeof(payload) = 'object'`
- `jsonb_typeof(metadata) = 'object'`
- `jsonb_typeof(input_snapshot) = 'object'`
- `jsonb_typeof(result) = 'object'`
- `dead_zone_knowledge_id <> canonical_knowledge_id` when canonical is not null

## Queue Name and Routing

Extend queue constants:

```ts
distillationQueueNameValues = [
  "findingCandidate",
  "coveringEvidence",
  "finalizeDistille",
  "deadZoneMergeReview",
]
```

Extend `queueTableNameByQueue`:

```ts
deadZoneMergeReview: "dead_zone_merge_review_queue"
```

Extend queue control default state so pause/resume works uniformly.

Add settings route:

```ts
taskRouting.deadZoneMergeReview = {
  provider: "local-llm",
  model: groupedConfig.localLlm.model,
  fallback: [],
}
```

Add resolver:

```ts
resolveDeadZoneMergeReviewRoute(): RuntimeSettingsRoute
```

The worker should use this route directly. It should not reuse `provider_policy = cloud_api`.

## LLM Review Contract

Input snapshot must be enough to make the job reproducible even if knowledge changes later.

```ts
type DeadZoneMergeReviewInputSnapshot = {
  deadZone: {
    id: string;
    title: string;
    body: string;
    type: "rule" | "procedure";
    appliesTo: Record<string, unknown>;
    status: string;
    bodyHash: string;
  };
  canonical: {
    id: string;
    title: string;
    body: string;
    type: "rule" | "procedure";
    appliesTo: Record<string, unknown>;
    status: string;
    bodyHash: string;
  } | null;
  deterministicRecommendation: DeadZoneReviewRecommendation;
  indicators: DeadZoneKnowledgeIndicators;
  reviewerNote?: string;
};
```

LLM output schema:

```ts
type DeadZoneMergeReviewResult = {
  decision:
    | "merge_recommended"
    | "merge_blocked"
    | "keep_separate"
    | "needs_evidence";
  confidence: "low" | "medium" | "high";
  rationale: string[];
  blockers: string[];
  proposedCanonicalBody: string | null;
  proposedSummary: string | null;
  rawOutputExcerpt: string;
  parseStatus: "parsed" | "recovered" | "failed";
};
```

LLM instructions:

- Do not invent evidence.
- Do not erase canonical-specific guidance.
- Preserve rule/procedure format.
- Prefer concise integration over appending the DeadZone body verbatim.
- Return `merge_blocked` when scope differs, contradiction is likely, or canonical is not clearly stronger.
- Return `needs_evidence` when sources are insufficient.

Output recovery must be deterministic and status-gated. If JSON parse fails, try one local repair pass. If repair fails, mark job `failed` with `last_outcome_kind = 'parse_failed'`.

## UI Flow

DeadZone Review Queue row:

- Keep deterministic recommendation visible.
- Replace immediate primary merge with `Request merge review` when action is `merge_deadzone_into_canonical`.
- Show existing review job state if present:
  - pending
  - running
  - failed
  - completed
- Disable duplicate review requests via `idempotency_key`.

Completed job drawer:

- DeadZone body
- canonical body at snapshot time
- proposed canonical body
- body diff
- LLM rationale
- blockers
- provider/model
- retry/apply controls

Apply button:

- enabled only when job completed and `decision = 'merge_recommended'`
- verifies current deadZone/canonical body hashes still match snapshot
- if hashes changed, blocks apply and asks for re-run
- updates canonical body through `updateKnowledgeItem`
- deprecates DeadZone through `updateKnowledgeItem`
- records decision into `landscape_review_items`
- writes audit payload with previous body, proposed body, result, job id, and provider/model

Keep `deprecate_deadzone`, `keep_separate`, `needs_evidence`, and `promote_deadzone` as direct decision actions. Only merge gets asynchronous LLM review in the first milestone.

## API Plan

Add routes under existing graph/landscape namespace:

- `POST /api/graph/landscape/dead-zone-knowledge/merge-review-jobs`
- `GET /api/graph/landscape/dead-zone-knowledge/merge-review-jobs?reviewItemId=...`
- `POST /api/graph/landscape/dead-zone-knowledge/merge-review-jobs/:id/retry`
- `POST /api/graph/landscape/dead-zone-knowledge/merge-review-jobs/:id/apply`

Create job input:

```ts
type CreateDeadZoneMergeReviewJobInput = {
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId?: string;
  note?: string;
};
```

Apply result:

```ts
type ApplyDeadZoneMergeReviewResult = {
  status: "applied";
  message: string;
  reviewItemId: string;
  jobId: string;
  keptKnowledgeId: string;
  deprecatedKnowledgeId: string;
};
```

The old immediate `merge_deadzone_into_canonical` action remains available as compatibility during migration but should be demoted from the UI primary path.

## Worker Plan

Add module:

- `src/modules/landscape/deadzone-merge-review-queue.repository.ts`
- `src/modules/landscape/deadzone-merge-review-queue.service.ts`
- `src/modules/landscape/deadzone-merge-review-llm.ts`

Worker steps:

1. Claim `deadZoneMergeReview` job through common queue claim.
2. Load job and validate referenced knowledge still exists.
3. If canonical is missing or deprecated, complete as `skipped` with blocker result.
4. Build prompt from `input_snapshot`.
5. Call local-llm through distillation chat runtime or shared LLM provider wrapper.
6. Parse result schema.
7. Save `result`, provider/model, `last_outcome_kind`, and completion state.
8. Append queue events for claimed/completed/failed.

Failure handling:

- provider unreachable: `failed`, `last_outcome_kind = 'provider_failed'`
- timeout: `failed`, `last_outcome_kind = 'provider_timeout'`
- invalid output after repair: `failed`, `last_outcome_kind = 'parse_failed'`
- stale knowledge state before processing: `skipped`, `last_outcome_kind = 'stale_input'`

Retry should preserve the same input snapshot unless the user explicitly creates a new job.

## Queue Page Plan

Queue page should show the new queue as `Merge Review`.

Tabs:

- Finding
- Covering
- Merge Review
- Finalize

`premiumCoveringEvidence` must not appear in Queue page tabs after the deletion migration. The visible replacement slot is `Merge Review`, backed by `deadZoneMergeReview`.

For `deadZoneMergeReview`, list rows with:

- subject title: DeadZone knowledge title
- subject detail: `canonical=<id> | review=<id>`
- metadata summary: result decision or deterministic recommendation
- provider/model: route-resolved local-llm model

Stats:

- `nonRegistered` should remain specific to covering queues.
- `offline` should count provider failures/timeouts.

## Migration Strategy

Milestone 1: Delete Premium queue

- Add migration `0054_drop_premium_covering_evidence_queue.sql`.
- Delete premium queue rows/events/results before tightening checks.
- Drop `premium_covering_evidence_queue`.
- Remove `premiumJobId` from `distillation_queue_migration_map`.
- Remove `premiumCoveringEvidence` from queue constants.
- Remove `escalated_to_premium` event type.
- Remove Queue UI Premium tab.

Milestone 2: DeadZone merge review schema and queue plumbing

- Add migration `0055_dead_zone_merge_review_queue.sql`.
- Add Drizzle schema.
- Add queue enum value, table mapping, queue control defaults.
- Add repository list/stats support for `deadZoneMergeReview`.

Milestone 3: Job creation and UI request

- Add create/list/retry routes.
- Add row-level `mergeReviewJob` summary to DeadZone review response or fetch per expanded drawer.
- Change UI primary merge button to `Request merge review`.
- Show pending/running/completed/failed state.

Milestone 4: LLM worker

- Add prompt and parser.
- Add worker branch for `deadZoneMergeReview`.
- Use local-llm route with no default cloud fallback.
- Persist result; no knowledge mutation.

Milestone 5: Apply reviewed merge

- Add apply endpoint.
- Verify body hashes.
- Update canonical via `updateKnowledgeItem`.
- Deprecate DeadZone via `updateKnowledgeItem`.
- Record landscape decision and audit payload.
- Invalidate Landscape, Knowledge, Graph, and Queue queries.

## Test Plan

Schema/tests:

- New queue table appears in schema fixtures.
- Queue name schema includes `deadZoneMergeReview`.
- `queueTableNameByQueue.deadZoneMergeReview` maps to `dead_zone_merge_review_queue`.
- `premiumCoveringEvidence` and `premium_covering_evidence_queue` references are absent outside historical migration files.

Repository tests:

- Create job is idempotent for the same deadZone/canonical/review tuple.
- Queue list returns DeadZone title and canonical detail.
- Stats include pending/running/failed/completed counts.
- `nonRegistered` remains zero for merge review.

Service tests:

- Create job rejects missing canonical.
- Create job rejects canonical equal to DeadZone.
- Create job snapshots body hashes.
- Apply rejects non-completed job.
- Apply rejects `merge_blocked`, `keep_separate`, and `needs_evidence`.
- Apply rejects stale body hashes.
- Apply updates canonical body, deprecates DeadZone, records decision, and triggers embedding through `updateKnowledgeItem`.

Worker tests:

- Completed LLM result is persisted without mutating knowledge.
- Provider failure marks failed.
- Parse failure after repair marks failed.
- Deprecated canonical skips job.

Component tests:

- Merge recommendation shows `Request merge review`, not immediate destructive merge.
- Pending/running job state disables duplicate request.
- Completed job drawer shows rationale and diff.
- Apply button is enabled only for `merge_recommended`.

Verification:

```bash
bunx vitest run test/landscape-deadzone-review.service.test.ts test/queue.repository.test.ts test/queue-worker.test.ts test/components/admin/landscape-page.test.tsx test/components/admin/queue-page.test.tsx
bun run verify
```

## Open Questions

- Should local-llm fallback stay empty even for manual retry, or should retry allow an explicit cloud mode?
- Should merge review jobs be generated only on click, or pre-enqueued for high-confidence rows in the background?
- Should `promote_deadzone` get a similar LLM clean-up job later?

## Recommendation

Implement Milestone 1 and Milestone 2 together. That creates the durable queue and moves the UI away from immediate merge without yet relying on local-llm quality. Then add the worker and apply flow in separate commits so the destructive mutation remains review-gated throughout the transition.
