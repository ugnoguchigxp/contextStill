# Context Decision Implementation Plan

Status: planned  
Created: 2026-06-09  
Owner: ContextStill / NightWorkers knowledge cycle

## Purpose

`context_decision` を、NightWorkers がユーザー確認で止まらずに判断・実行・検証・破棄・再試行を続けるための MCP tool として実装する。

この計画は [Context Decision Concept](context-decision-concept.md) を実装へ落とす。主対象は ContextStill 側である。NightWorkers 側には ContextStill 専用 schema / repository / fallback を持たせず、MCP 経由の optional integration とする。

運用目標:

- 判断点の 90% 以上でユーザー回答を求めない。
- `escalate` は 10% 未満を目標にする。
- 判断は必ず Knowledge evidence を使う。
- Human feedback は Good / Bad のみ。
- 初期 system feedback は PR discard に絞る。
- feedback effects は Knowledge と同様に自動運用サイクルへ戻す。

## Goals

- `context_decision` MCP tool を追加する。
- 判断履歴、Evidence、coverage trace、feedback、feedback effects を永続化する。
- Knowledge evidence ベースで `confidence` を算出する。
- `missing_counter_evidence` は multi-query coverage trace がある場合だけ弱い positive として扱う。
- Human Bad は final outcome で system success より優先する。
- PR discard は git / GitHub CLI (`gh`) から判定する。
- WebUI に `decision` メニューを追加し、左に判断要求一覧、右に判断本文と全証跡を表示する。
- NightWorkers が Blocker / Todo 残 / cron 的再実行 / PR 作成前 / ユーザー質問前に呼べる契約を定義する。

## Non-Goals

- `context_compile` の既存 input / output contract を壊さない。
- NightWorkers に ContextStill 固有 DB schema を持たせない。
- 初期実装で git rollback / CI failure / review finding 由来の system feedback を自動回収しない。
- Good / Bad 以外の詳細な人間 feedback UI を作らない。
- LLM の self confidence を主スコアにしない。
- `missing_counter_evidence` だけで断定判断しない。

## Slice 1: Data Model

Add a migration after the current latest drizzle migration.

### Tables

#### `context_decision_runs`

Stores one decision request and final decision.

Core columns:

- `id uuid primary key default gen_random_uuid()`
- `session_id text`
- `task_goal text not null`
- `decision_point text not null`
- `proposed_action text`
- `options jsonb not null default '[]'`
- `decision text not null`
- `selected_action text`
- `rejected_actions jsonb not null default '[]'`
- `mandate text not null`
- `agent_message text not null`
- `confidence integer not null`
- `confidence_trace jsonb not null default '{}'`
- `autonomy_level text not null default 'high'`
- `risk_budget text not null default 'medium'`
- `knowledge_policy text not null default 'optional'`
- `available_rollback text`
- `verification_plan text`
- `guardrails jsonb not null default '{}'`
- `unsupported_alternatives jsonb not null default '[]'`
- `status text not null default 'completed'`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Checks:

- `decision in ('execute','reject','revise_and_execute','rollback','discard','escalate')`
- `confidence between 0 and 100`
- `autonomy_level in ('low','medium','high')`
- `risk_budget in ('low','medium','high')`
- `knowledge_policy in ('optional','required')`
- `status in ('completed','degraded','failed')`
- JSONB columns are arrays / objects as appropriate.

Indexes:

- `(created_at desc)`
- `(decision, created_at desc)`
- `(status, created_at desc)`
- `(session_id, created_at desc)`

#### `context_decision_evidence`

Stores Knowledge evidence used for the decision.

Core columns:

- `id uuid primary key default gen_random_uuid()`
- `decision_run_id uuid not null references context_decision_runs(id) on delete cascade`
- `knowledge_id uuid references knowledge_items(id) on delete set null`
- `role text not null`
- `weight_at_decision integer not null`
- `dynamic_score_at_decision integer`
- `applicability_score integer`
- `temporal_relevance integer`
- `summary text not null`
- `source_refs jsonb not null default '[]'`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

Roles:

- `selected_support`
- `rejected_alternative`
- `user_preference`
- `risk_warning`
- `missing_counter_evidence`

Indexes:

- `(decision_run_id, role)`
- `(knowledge_id, role)`

#### `context_decision_coverage_traces`

Stores the search coverage behind selected evidence and unsupported alternatives.

Core columns:

- `id uuid primary key default gen_random_uuid()`
- `decision_run_id uuid not null references context_decision_runs(id) on delete cascade`
- `query text not null`
- `query_role text not null`
- `scope jsonb not null default '{}'`
- `hit_count integer not null default 0`
- `max_similarity integer`
- `selected_knowledge_ids jsonb not null default '[]'`
- `rejected_knowledge_ids jsonb not null default '[]'`
- `reason text not null`
- `created_at timestamptz not null default now()`

`query_role` values:

- `support`
- `counter_evidence`
- `user_preference`
- `risk`

This table is required before `missing_counter_evidence` can be used as weak positive signal.

#### `context_decision_human_feedback`

Stores only Good / Bad feedback.

Core columns:

- `id uuid primary key default gen_random_uuid()`
- `decision_run_id uuid not null references context_decision_runs(id) on delete cascade`
- `value text not null`
- `created_at timestamptz not null default now()`

Checks:

- `value in ('good','bad')`

Uniqueness:

- Start with one latest user feedback per run: unique `(decision_run_id)`.

#### `context_decision_feedback`

Stores AI / system feedback.

Core columns:

- `id uuid primary key default gen_random_uuid()`
- `decision_run_id uuid not null references context_decision_runs(id) on delete cascade`
- `source text not null`
- `outcome text not null`
- `inferred_reason text not null`
- `affected_knowledge_ids jsonb not null default '[]'`
- `suggested_adjustment jsonb not null default '{}'`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

Checks:

- `source in ('ai','system')`
- `outcome in ('success','failed','discarded_pr','user_overrode','regression_found','still_unknown')`

Initial system source only creates `discarded_pr`.

#### `context_decision_feedback_effects`

Stores proposed / applied scoring effects.

Core columns:

- `id uuid primary key default gen_random_uuid()`
- `feedback_id uuid references context_decision_feedback(id) on delete cascade`
- `human_feedback_id uuid references context_decision_human_feedback(id) on delete cascade`
- `decision_run_id uuid not null references context_decision_runs(id) on delete cascade`
- `knowledge_id uuid references knowledge_items(id) on delete set null`
- `effect text not null`
- `amount integer not null`
- `reason text not null`
- `confidence integer not null`
- `status text not null default 'applied'`
- `applied_at timestamptz`
- `metadata jsonb not null default '{}'`
- `created_at timestamptz not null default now()`

Checks:

- `effect in ('boost','penalize','neutral')`
- `confidence between 0 and 100`
- `status in ('applied','queued_for_review','skipped')`
- exactly one of `feedback_id` / `human_feedback_id` is present.

Initial behavior:

- Human Good / Human Bad and PR discard effects can be auto-applied when reason classification is clear.
- Ambiguous effects go to review queue.
- Existing merge review queue may be reused for the review surface if that keeps implementation smaller, but automatic operation is the default path.

### Verification

Command:

```bash
bun run db:generate
bun run db:migrate
bunx vitest run test/context-decision.schema.test.ts
```

Expected:

- Drizzle migration applies cleanly to test DB.
- Invalid enum values fail.
- JSONB shape checks fail for non-array / non-object values.
- Cascade delete removes evidence / coverage / feedback rows for a run.

Failure handling:

- If migration generation conflicts with current snapshots, inspect `drizzle/meta/_journal.json` and regenerate from the latest schema only.
- If check constraints fail in tests, fix schema first; do not relax checks to pass tests.

## Slice 2: Domain Module

Add `src/modules/context-decision/`.

Files:

- `domain.ts`
- `context-decision.repository.ts`
- `context-decision.service.ts`
- `context-decision.scoring.ts`
- `context-decision.coverage.ts`
- `context-decision.feedback.service.ts`
- `context-decision.pr-discard.service.ts`

### Service Responsibilities

`context-decision.service.ts`:

- Validate input.
- Retrieve Knowledge evidence.
- Build support / counter / preference / risk queries.
- Build coverage traces.
- Compute confidence.
- Select one decision.
- Persist run, evidence, coverage, and trace.
- Return MCP-friendly response.

`context-decision.scoring.ts`:

- Compute score from Knowledge evidence.
- Do not make a decision without Knowledge evidence when `knowledgePolicy=required`.
- Treat `missing_counter_evidence` as neutral unless coverage requirements are met.
- Keep `risk_warning` separate from simple negative scoring.
- Produce `confidence_trace`.

`context-decision.coverage.ts`:

- Generate multi-query support / counter-evidence search.
- Save query, scope, hit count, max similarity, selected / rejected IDs, and reason.
- Provide coverage status for confidence scoring.

`context-decision.feedback.service.ts`:

- Accept Good / Bad.
- Accept system / AI feedback.
- Classify reasons.
- Generate effects.
- Auto-apply clear effects.
- Queue ambiguous effects.

`context-decision.pr-discard.service.ts`:

- Use git / `gh` to identify PR state.
- Do not require NightWorkers to emit discard events.
- Only create feedback when a PR can be tied to a `decisionId`.

### Confidence Scoring v1

Use Knowledge evidence, not hardcoded answers.

Initial scoring features:

- support evidence total
- support evidence count
- evidence role distribution
- dynamic score snapshot
- appliesTo / domain / technology fit
- source trace strength
- temporal relevance
- Good / Bad history for related Knowledge
- related decision outcome history
- counter-evidence strength
- coverage quality
- rollback / verification availability

Output:

```ts
type ContextDecisionConfidenceTrace = {
  supportScore: number;
  counterScore: number;
  preferenceScore: number;
  riskSignalScore: number;
  coverageScore: number;
  verificationScore: number;
  historicalFeedbackScore: number;
  finalConfidence: number;
  forcedRules: string[];
};
```

Rules:

- `knowledgePolicy=required` + selected support evidence 0 -> `confidence=0`, status `degraded`.
- `missing_counter_evidence` alone never raises confidence.
- If coverage is weak, unsupported alternatives remain unsupported but do not strengthen confidence.
- Human Bad outcome history should lower confidence for the same evidence / decision type.

### Verification

Command:

```bash
bunx vitest run test/context-decision.service.test.ts test/context-decision.scoring.test.ts
```

Expected:

- v1 scoring uses Knowledge evidence rows.
- `knowledgePolicy=required` with no evidence returns degraded.
- `missing_counter_evidence` is neutral without coverage trace.
- Human Bad is reflected in subsequent scoring.
- Risk warnings do not always reduce confidence when they become guardrails.

Failure handling:

- If scoring becomes brittle, keep weights configurable in code constants but do not move to LLM self confidence.
- If tests need huge fixtures, replace with small factory helpers.

## Slice 3: MCP Tools

Add tools under `src/mcp/tools/`.

### `context_decision`

Input:

- `taskGoal`
- `decisionPoint`
- `proposedAction`
- `options`
- `autonomyLevel`
- `riskBudget`
- `availableRollback`
- `verificationPlan`
- `knowledgePolicy`
- optional `sessionId`
- optional `metadata`

Output:

- `decision`
- `selected`
- `rejected`
- `mandate`
- `confidence`
- `agentMessage`
- `guardrails`
- `evidence`
- `unsupportedAlternatives`
- `feedbackHandle`
- `coverageSummary`

Tool description must tell the LLM:

- Use before asking the user.
- Use when blocked, before PR creation, after failed tests/review, and when unfinished Todo/status remains.
- Return a decision, not options.
- Escalate only when autonomous progress is not possible.

### `context_decision_feedback`

Input:

- `decisionId`
- `source`: `human | ai | system`
- `value` for human: `good | bad`
- `outcome` for ai/system
- optional `reason`
- optional `metadata`

For MCP, human Good / Bad can be accepted here, but WebUI will also expose an API route.

### Registry

Update:

- `src/mcp/tools/index.ts`
- `src/mcp/registry.ts`
- `src/modules/doctor/inspectors/mcp.inspector.ts` if tool list validation expects named tools.

### Verification

Command:

```bash
bunx vitest run test/mcp.context-decision.test.ts test/mcp.contract.test.ts
bun run mcp:smoke
```

Expected:

- Tools appear in MCP list.
- `context_decision` returns structured content with `decisionId`.
- Feedback tool accepts Good / Bad.
- Invalid feedback values fail with a useful tool error.

Failure handling:

- If MCP contract snapshots fail, update only the expected tool schema changes.
- If smoke requires DB, run with `CONTEXT_STILL_TEST_DATABASE_URL`.

## Slice 4: API Routes

Add `api/modules/context-decision/`.

Files:

- `context-decision.routes.ts`
- `context-decision.repository.ts`
- `context-decision.service.ts`

Routes:

- `GET /api/context-decisions`
  - list runs, newest first
  - filters: `decision`, `status`, `feedback`, `q`, `limit`, `cursor`
- `GET /api/context-decisions/:id`
  - run detail with evidence, coverage trace, feedback, effects
- `POST /api/context-decisions/:id/human-feedback`
  - body `{ value: "good" | "bad" }`
- `POST /api/context-decisions/:id/system-feedback`
  - internal/admin route for generated feedback
- `POST /api/context-decisions/pr-discard-scan`
  - optional admin trigger for git / gh scan

The detail endpoint must return all evidence needed by the decision page. Do not require the WebUI to reconstruct evidence by calling multiple unrelated endpoints.

### Verification

Command:

```bash
bunx vitest run test/context-decision.routes.test.ts test/api.routes.integration.test.ts
```

Expected:

- List supports pagination.
- Detail includes all evidence and coverage traces.
- Good / Bad writes invalidate and return updated detail.
- Nonexistent decision returns 404.

Failure handling:

- If route tests become too broad, split repository tests from Hono route tests.

## Slice 5: PR Discard Feedback

Initial scope: PR discard only.

Do not rely on NightWorkers to emit discard events.

### Detection Sources

Use, in order:

1. `gh pr view --json number,state,closedAt,headRefName,headRefOid,url`
2. local git branch / commit metadata
3. decision metadata that stores branch / PR URL / commit SHA when available

`git pull` alone is not enough to reliably know PR close / discard state. Use `gh` when PR state is needed.

### Linkage

A `context_decision_run` can be linked to PR data through `metadata`.

Suggested fields:

- `metadata.branch`
- `metadata.prUrl`
- `metadata.prNumber`
- `metadata.headSha`
- `metadata.nightWorkersTaskId`

Only create `discarded_pr` feedback when the linkage is strong enough. If linkage is weak, create no feedback and expose the ambiguity in the decision detail.

### CLI

Add:

```json
{
  "scripts": {
    "decision:pr-discard-scan": "bun run src/cli/context-decision-pr-discard-scan.ts"
  }
}
```

CLI behavior:

- default dry-run
- `--apply` writes system feedback and effects
- `--since` limits scan window
- prints decisionId, PR, detected state, action

### Verification

Command:

```bash
bunx vitest run test/context-decision.pr-discard.test.ts
bun run decision:pr-discard-scan -- --dry-run
```

Expected:

- Closed PR linked to decision creates planned `discarded_pr`.
- Unknown PR linkage is skipped.
- Dry-run writes nothing.

Failure handling:

- If `gh` is unavailable, service returns degraded scan status and does not create feedback.
- If auth is missing, surface setup text but keep decision system usable.

## Slice 6: Feedback Effects And Auto-Apply

Implement the feedback loop after run/evidence persistence is stable.

### Effect Generation

Human Good:

- boost `selected_support`
- boost `user_preference`
- boost correctly used `rejected_alternative`
- neutral / small boost `risk_warning` when guardrail was useful

Human Bad:

- final outcome is Bad even if system success exists
- do not immediately penalize all support evidence
- infer reason first
- penalize selected support only for policy / direction mistakes
- adjust appliesTo / domain fit for scope mistakes
- adjust verification policy for verification misses

PR discard:

- outcome `discarded_pr`
- inspect decision metadata and PR state
- infer whether discard suggests wrong direction, failed scope, or abandoned implementation
- clear cases can apply automatically
- ambiguous cases go to review queue

### Auto-Apply Rule

Automatic operation is the default. Review queue is for ambiguity, not the normal path.

Initial auto-apply:

- Human Good with clear selected support
- Human Bad with clear classification
- PR discard with strong linkage and clear classification

Queue:

- weak PR linkage
- conflicting system / human signals
- no affected Knowledge
- malformed reason classification

### Verification

Command:

```bash
bunx vitest run test/context-decision.feedback-effects.test.ts
```

Expected:

- Human Bad does not blindly penalize all evidence.
- Clear Human Good creates applied boost effects.
- Ambiguous PR discard queues effects.
- Applied effects are visible in decision detail.

Failure handling:

- If effect application touches existing knowledge scoring paths, add regression tests for `knowledge_quality_adjustments`.

## Slice 7: Decision Web UI

Add WebUI under `web/src/modules/context-decision/` and wire it into `web/src/modules/admin/components/app-shell.tsx` or the existing navigation owner.

### Page Layout

`decision` menu sits next to `context_compile`.

Left pane:

- decision run list
- decision point
- decision outcome
- confidence
- status
- feedback state
- created time

Right detail:

- what judgment was requested
- selected decision
- agentMessage
- confidence trace
- all Knowledge evidence
- coverage trace
- selected / rejected evidence
- unsupported alternatives and rejection reasons
- guardrails
- rollback / discard conditions
- feedback effects and applied / queued / skipped state
- Good / Bad controls

This right pane is the decision detail. Do not create a separate detail concept elsewhere.

### UX Constraints

- Good / Bad is one click.
- No detailed human feedback form.
- Evidence must be inspectable without leaving the page.
- If coverage is degraded, show that the decision was degraded.
- If PR discard feedback was generated, show source PR state and detection source (`git` / `gh`).

### API Client

Add repository / hooks mirroring context compiler patterns:

- `web/src/modules/context-decision/repositories/context-decision.repository.ts`
- `web/src/modules/context-decision/hooks/context-decision.hooks.ts`
- `web/src/modules/context-decision/components/context-decision.page.tsx`
- `web/src/modules/context-decision/components/context-decision.run-sidebar.tsx`

### Verification

Command:

```bash
bunx vitest run web/src/modules/context-decision
bunx vitest run test/admin/repositories.test.ts
bun run build:web
```

Expected:

- List renders with mocked API data.
- Detail renders all evidence groups.
- Good / Bad mutation updates detail.
- Build passes.

Failure handling:

- If UI state becomes complex, keep selection state URL-addressable only after initial version works.

## Slice 8: NightWorkers Integration Contract

This is a contract document and smoke integration, not a ContextStill-owned NightWorkers implementation.

### Call Points

NightWorkers should call `context_decision`:

- before asking the user
- when Blocker stops work
- when design docs or TodoList are consumed but task status is not Done
- during cron-like wakeup / rerun when unfinished task / Todo / status remains
- before PR creation
- after test failure or review finding when deciding continue / rollback / discard
- when repeated retry does not converge

### Input Mapping

NightWorkers should pass:

- task goal
- decision point
- proposed action
- options if known
- Todo / status context
- blocker summary
- verification plan
- rollback availability
- PR / branch / commit metadata if available
- autonomy level, default high
- risk budget

### Output Handling

NightWorkers should:

- obey `execute`, `revise_and_execute`, `reject`, `discard`, `rollback`
- ask user only on `escalate`
- attach `decisionId` to any branch / PR metadata it can store
- not implement ContextStill-specific persistence

### Verification

Command:

```bash
bunx vitest run test/context-decision.nightworkers-contract.test.ts
```

Expected:

- Contract examples validate against MCP input schema.
- Blocker / Todo / PR-before examples produce non-escalate decisions when evidence exists.
- Escalate appears only when no autonomous branch is possible.

Failure handling:

- If NightWorkers needs extra fields, add optional `metadata` rather than hard-coding NightWorkers schema in ContextStill.

## Slice 9: Observability And Doctor

Add operator visibility after core behavior works.

### Metrics

Decision overview metrics:

- total decisions
- execute / revise / reject / discard / rollback / escalate counts
- escalate rate
- target: escalate < 10%
- Good / Bad feedback counts
- PR discard feedback count
- auto-applied effects count
- queued effects count
- degraded decisions count

### Doctor

Doctor should flag:

- context decision table missing
- PR discard scanner unavailable because `gh` missing or unauthenticated
- high escalate rate over recent window
- feedback effects stuck queued
- required Knowledge decisions degraded due to zero evidence

### Verification

Command:

```bash
bunx vitest run test/context-decision.doctor.test.ts
bun run doctor
```

Expected:

- Healthy system reports decision capability.
- Missing `gh` is degraded only for PR discard feedback, not for core decisions.
- High escalate rate is surfaced as a quality warning.

Failure handling:

- Keep Doctor messages factual. Do not suggest legacy retry flows that do not exist.

## Slice 10: End-To-End Verification

Run after all slices land.

Commands:

```bash
bun run typecheck
bun run lint
bun run test:unit
DATABASE_URL=${CONTEXT_STILL_TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still_test} bun run db:migrate
DATABASE_URL=${CONTEXT_STILL_TEST_DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still_test} bun run test:mcp:contract
bun run build:web
bun run mcp:smoke
bun run doctor
```

Expected:

- Typecheck and lint pass.
- Unit tests cover scoring, feedback, routes, and UI repository behavior.
- MCP contract includes new tools.
- Web build passes.
- Doctor reports decision capability.

Failure handling:

- Expand failing command output only.
- If API routes pass but Web fails, isolate to repository / component mocks before changing backend shape.
- If MCP smoke fails, inspect registry and tool schema first.

## Implementation Order Summary

1. Data model and migration.
2. Domain module and scoring.
3. MCP tools.
4. API routes.
5. PR discard scanner.
6. Feedback effects auto-apply / queue.
7. Decision WebUI.
8. NightWorkers contract tests / docs.
9. Doctor / observability.
10. Full verification.

## Open Implementation Details

- Exact confidence weights and thresholds.
- Exact effect amount formula.
- Whether decision effects reuse `knowledge_quality_adjustments` directly or write a dedicated adjustment path first.
- Whether existing merge review queue can host ambiguous decision effects without confusing its UI.
- How to map PR / branch metadata to `decisionId` when multiple decisions happen in one branch.
