# Negative Knowledge Implementation Plan

> Updated: 2026-06-11
> Scope: contextStill implementation plan for [Negative Knowledge Concept](negative-knowledge-concept.md)

## Goal

Implement Negative Knowledge in small, reviewable slices so review corrections, regressions, guardrails, and failure patterns can influence `context_compile` and `context_decision` without becoming ordinary positive instructions.

The first milestone is:

```text
accepted review correction
  -> register_review_corrections
  -> negative candidate
  -> draft/active negative Knowledge
  -> context_compile review_context guardrail
  -> context_decision risk / counter-evidence / verification trace
```

## Current Repo Baseline

Existing implementation anchors:

- Knowledge storage: `src/db/schema-knowledge.ts`
- Knowledge constants: `src/db/schema.constants.ts`
- Knowledge schemas: `src/shared/schemas/knowledge.schema.ts`
- Knowledge retrieval: `src/modules/knowledge/knowledge.repository.ts`
- Knowledge service: `src/modules/knowledge/knowledge.service.ts`
- Candidate registration: `src/modules/registerCandidate/register-candidate.service.ts`
- Knowledge MCP tools: `src/mcp/tools/knowledge.tool.ts`
- Knowledge API: `api/modules/knowledge/`
- Compile retrieval/rendering: `src/modules/context-compiler/`
- Decision assessment: `src/modules/context-decision/`
- Context pack schema: `src/shared/schemas/context-pack.schema.ts`
- Existing review queue for wrong feedback: `knowledge_review_queue`
- Existing landscape review items: `landscape_review_items`
- Existing origin links: `knowledge_origin_links`

Existing constraints:

- `context_compile` already has `review_context`.
- `context_decision` already has coverage roles: `support`, `counter_evidence`, `user_preference`, `risk`, `verification`, `alternative`.
- Persisted decision evidence roles already include `selected_support`, `risk_warning`, `user_preference`, and `missing_counter_evidence`.
- `knowledge_review_queue` is for wrong/off-topic Knowledge feedback and must not become a raw review finding queue.
- Raw review findings stay in the source system. contextStill stores distilled reusable Knowledge and provenance metadata only.

## Non-Goals

- Do not make contextStill a code review executor.
- Do not store raw review findings as first-class review ledger rows.
- Do not route review correction registration through `knowledge_review_queue`.
- Do not add file read or shell execution to contextStill.
- Do not make `intentTags` a closed enum.
- Do not auto-convert existing "never" or "avoid" Knowledge to negative.
- Do not change compile or decision ranking in the schema-only PR.
- Do not build autonomous goal discovery in this plan.

## Data Model

Add first-class fields to `knowledge_items`:

```text
polarity text not null default 'positive'
intent_tags jsonb not null default '[]'
```

Allowed polarity values:

```text
positive | negative | neutral
```

Intent tags remain flexible normalized slugs. Seed initial tag definitions with kind `intent`:

```text
guidance
guardrail
prohibition
warning
failure_pattern
review_finding
regression
test_gap
verification
preference
boundary_violation
architecture_risk
security_risk
performance_risk
operational_risk
```

Extend `knowledge_origin_links.origin_kind` to accept:

```text
review_finding
external_review_run
review_correction
```

Do not create a separate negative Knowledge table in the first implementation pass.

## PR 1: Schema And Contracts

### Objective

Add polarity and intent tag contracts without changing runtime selection behavior.

### Changes

Update `src/db/schema.constants.ts`:

- add `knowledgePolarityValues`
- add `"intent"` to `knowledgeTagKindValues`
- add a reusable origin kind constant for `knowledge_origin_links`

Update `src/db/schema-knowledge.ts`:

- add `knowledgeItems.polarity`
- add `knowledgeItems.intentTags`
- add check constraints
- add indexes:
  - `knowledge_items_polarity_idx`
  - `knowledge_items_intent_tags_gin_idx`
  - `knowledge_items_status_polarity_idx`
- replace the hardcoded `knowledge_origin_links_origin_kind_check` list with the shared constant

Add a Drizzle migration:

- backfill all existing rows to `polarity='positive'`
- backfill all existing rows to `intent_tags=[]`
- update `knowledge_origin_links.origin_kind` check
- update `knowledge_tag_definitions.kind` check

Update `src/shared/schemas/knowledge.schema.ts`:

- expose `polarity` and `intentTags` on Knowledge item schemas
- allow optional `polarity` and `intentTags` on register/update schemas
- default omitted register/update values to current behavior
- keep `register_candidate` and `register_candidates` backward compatible

Update API repository types under `api/modules/knowledge/`:

- include `polarity` and `intentTags` in list/detail/create/update item shapes
- default legacy row reads to `positive` and `[]` where needed for local/dev migration tolerance

### Tests

Add or update focused tests:

- `test/schemas.test.ts`
- `test/knowledge.repository.test.ts`
- `test/api.routes.knowledge.test.ts`
- `test/register-candidate.service.test.ts`

Acceptance criteria:

- migrations add `polarity` and `intent_tags`
- existing Knowledge reads as `polarity=positive` and `intentTags=[]`
- invalid polarity is rejected
- flexible intent tags are accepted
- origin links accept review-related origin kinds
- `register_candidate` and `register_candidates` still pass without polarity fields
- no compile or decision output changes in this PR

## PR 2: Search Filters And Retrieval Metadata

### Objective

Make polarity and intent tags queryable and consistently returned before changing compile or decision behavior.

### Changes

Update `src/shared/schemas/knowledge.schema.ts`:

```ts
polarities?: Array<"positive" | "negative" | "neutral">;
intentTags?: string[];
```

Update `src/modules/knowledge/knowledge.repository.ts`:

- select `polarity` and `intentTags` in text search
- select `polarity` and `intentTags` in vector search
- filter by `polarities`
- filter by normalized `intentTags`
- ensure `mapKnowledgeRowsToResults` returns the same metadata for text and vector paths

Update `src/modules/knowledge/knowledge.service.ts`:

- pass new filters through `retrieveKnowledge` and `searchKnowledgeCandidates`
- keep omitted filters behavior identical to current behavior

Update `src/mcp/tools/knowledge.tool.ts`:

- add `polarities` and `intentTags` to `search_knowledge` input schema
- include `polarity` and `intentTags` in tool output

Update `api/modules/knowledge/`:

- add list filters for `polarity` and `intentTags`
- include fields in list/detail responses

### Tests

Add or update focused tests:

- `test/knowledge.repository.test.ts`
- `test/knowledge.service.test.ts`
- `test/mcp.tools.test.ts`
- `test/mcp.contract.test.ts`
- `test/api.routes.knowledge.test.ts`

Acceptance criteria:

- `search_knowledge` can return only negative items
- `search_knowledge` can return only positive items
- text and vector retrieval expose identical polarity/tag fields
- omitted filters preserve existing results
- no ranking behavior changes yet

## PR 3: register_review_corrections MCP Tool

### Objective

Add a bulk-oriented MCP tool for accepted or valid review corrections. It creates candidates only.

### Tool

Add `register_review_corrections` under `src/mcp/tools/knowledge.tool.ts` or a dedicated review-correction tool module if the file becomes too large.

Input:

```ts
{
  items: Array<{
    title: string;
    finding: string;
    impact?: string;
    trigger?: string;
    fix?: string;
    verification?: string;
    decisionSignal?: string;
    severity?: "low" | "medium" | "high" | "critical";
    status: "accepted" | "fixed" | "deferred";
    origin: {
      system: string;
      reviewFindingId: string;
      runId?: string;
      taskId?: string;
      sessionId?: string;
      repositoryPath?: string;
      artifactRefs?: string[];
      fileRefs?: Array<{ path: string; line?: number }>;
    };
    confidence?: number;
    importance?: number;
    intentTags?: string[];
    appliesTo?: Record<string, unknown>;
  }>;
}
```

Rules:

- reject missing `reviewFindingId`
- reject empty `finding`
- reject false-positive/rejected statuses by not including them in the schema
- default `polarity=negative`
- default `intentTags=["review_finding"]`
- candidate `type` defaults to `rule`
- do not create active Knowledge directly
- preserve `origin` under metadata as provenance only
- set candidate metadata source to `mcp_register_review_corrections`
- keep max items aligned with `register_candidates`

Candidate body format:

```text
Failure:
Impact:
Trigger:
Fix:
Verification:
Decision signal:
```

Omit missing sections. Do not invent evidence.

### Implementation

Add a service near `src/modules/registerCandidate/`:

- `src/modules/registerCandidate/register-review-corrections.service.ts`

Reuse `registerCandidate` / `registerCandidatesBulk` where possible instead of duplicating queue insertion logic.

If idempotency is cheap, use `origin.reviewFindingId` and `origin.system` to report duplicates. If it is not cheap in the first slice, return a per-item error for duplicates once detected in candidate metadata.

### Tests

Add:

- `test/register-review-corrections.service.test.ts`

Update:

- `test/mcp.tools.test.ts`
- `test/mcp.contract.test.ts`

Acceptance criteria:

- accepted, fixed, and deferred corrections create negative candidates
- tool output reports per-item success/failure
- missing `reviewFindingId` is rejected
- missing `finding` is rejected
- candidate metadata contains polarity, intent tags, and review correction origin
- MCP registry lists the new tool

## PR 4: Negative Coverage And Finalization

### Objective

Shape negative candidates into reusable Knowledge using a route that understands failure/risk semantics.

### Changes

Add a separate module:

- `src/modules/coverNegativeEvidence/`

Do not reuse positive coverEvidence prompts unchanged.

Negative coverage should answer:

- did the failure or risk really occur?
- was the finding accepted, fixed, or validly deferred?
- is it reusable outside the exact run?
- is it actually a false positive?
- what intent tags fit?
- what verification should future agents run?

Output shape:

```ts
{
  status: "ready" | "insufficient" | "false_positive" | "not_reusable";
  polarity: "negative" | "neutral";
  intentTags: string[];
  distilled: {
    failure: string;
    impact?: string;
    trigger?: string;
    fix?: string;
    verification?: string;
    decisionSignal?: string;
  };
  evidence: string[];
  originRefs: string[];
}
```

First implementation should finalize `ready` results as `draft` Knowledge by default. Promotion to `active` remains the normal human review path.

### Tests

Add:

- negative parser tests
- negative coverage service tests
- finalize preservation tests

Acceptance criteria:

- false positives do not create Knowledge
- not reusable findings do not create Knowledge
- ready results preserve `polarity`, `intentTags`, and origin metadata
- finalization creates draft Knowledge by default
- existing positive coverEvidence behavior does not change

## PR 5: context_compile Guardrails

### Objective

Allow `context_compile` to include negative Knowledge safely without presenting it as ordinary work instructions.

### Changes

Update `src/shared/schemas/context-pack.schema.ts`:

- add `guardrails: ContextPackItem[]` with default `[]`
- keep `warnings: string[]` for compatibility

Update `src/db/schema.constants.ts`:

- add `guardrails` to `packSectionValues` only if persisted pack items need a first-class section

Update `src/modules/context-compiler/`:

- retrieve positive Knowledge for normal rules/procedures
- retrieve negative Knowledge for guardrails
- keep neutral verification Knowledge out of positive procedure output unless explicitly selected as verification material
- include guardrails in token budgeting
- include guardrails in markdown rendering
- include guardrail traces in candidate trace evidence where practical

Rendering rule:

- negative Knowledge must be phrased as avoid/check/verify guidance
- it must not be phrased as a task to execute

### Tests

Add or update:

- `test/context-compiler.service.test.ts`
- `test/context-compiler.test.ts`
- `test/context-response-composer.service.test.ts`
- `test/token-budget.test.ts`

Acceptance criteria:

- negative Knowledge is not rendered in positive procedures
- guardrails render separately
- no guardrails case preserves existing output shape
- `review_context` benefits first; other retrieval modes can follow only after tests prove no noise increase

## PR 6: context_decision Role Mapping

### Objective

Use negative Knowledge as risk, counter-evidence, and verification evidence without adding new decision values.

### Changes

Add deterministic mapping:

```text
Knowledge + coverage query role + polarity + intentTags -> evidence role
```

Initial rules:

- `polarity=positive` -> `selected_support`
- `polarity=negative` + `guardrail` / `prohibition` -> `risk_warning`
- `polarity=negative` + `failure_pattern` / `regression` -> `risk_warning`
- `verification` / `test_gap` tags -> coverage trace first; add persisted role only if UI/API needs item-level evidence
- `preference` -> `user_preference`
- unknown intent tags fall back to polarity and query role

Update `src/modules/context-decision/`:

- coverage assessment records polarity/tag-aware risk and conflict
- confidence trace makes risk/counter evidence explicit
- final decision set remains unchanged

### Tests

Add or update:

- `test/context-decision.knowledge-assessment.test.ts`
- `test/context-decision.coverage.test.ts`
- `test/context-decision.service.test.ts`
- `test/context-decision.scoring.test.ts`

Acceptance criteria:

- negative guardrail appears as risk evidence
- negative failure pattern can push toward `revise_and_execute`, `reject`, or `escalate` when applicable
- positive guidance still supports `execute`
- unknown tags do not break decisions
- conflicting positive and negative evidence is visible in traces

## PR 7: Feedback Semantics And Dynamic Score

### Objective

Make feedback meaningful for different polarities while reusing existing storage.

### Semantics

Positive:

- `used`: guidance helped
- `not_used`: selected but not useful
- `off_topic`: irrelevant
- `wrong`: incorrect

Negative:

- `used`: warning/guardrail helped avoid or catch a problem
- `not_used`: warning was selected but not needed
- `off_topic`: risk was irrelevant
- `wrong`: warning/failure pattern was false or misleading

### Changes

Update:

- `src/modules/knowledge/knowledge-feedback.service.ts`
- `src/modules/knowledge/knowledge-value.service.ts`
- API/UI labels where feedback is displayed

Keep the same verdict values. Adjust scoring and labels by polarity.

### Tests

Add or update:

- `test/knowledge-feedback.service.test.ts`
- `test/knowledge-value.service.test.ts`
- API route tests for feedback labels if exposed

Acceptance criteria:

- negative `used` increases guardrail/risk selection value, not procedure priority
- negative `off_topic` suppresses future noisy guardrails
- negative `wrong` enters the existing wrong-review path
- no automatic deletion path is added

## PR 8: UI, Seed, Doctor, And Cleanup

### Objective

Make negative Knowledge understandable and observable after backend behavior exists.

### UI

Update Knowledge UI:

- polarity filter
- intent tag filter
- origin kind filter
- polarity/intent badges
- review correction provenance panel

Update compile/decision detail UI:

- guardrails section
- polarity badges
- risk/counter-evidence grouping

### Seed And Migration Cleanup

Update:

- `src/db/seed.ts`
- `src/db/seeds/knowledge-seed.json`
- seed import/export tests

Add dry-run candidate finder:

```text
bun run knowledge:negative-candidates:dry-run
```

Target:

- `src/cli/negative-knowledge-candidates.ts`

The dry run may suggest polarity and intent tags for existing prohibition-like Knowledge, but it must not write by default.

### Doctor

Add non-blocking diagnostics:

- negative Knowledge count
- negative Knowledge without origin links
- unknown intent tag count
- negative Knowledge selected as positive procedure
- false-positive correction leakage count if detectable

### Tests

Add or update:

- `test/doctor.service.test.ts`
- `test/doctor-reasons.test.ts`
- seed tests
- CLI dry-run tests
- UI tests where existing coverage patterns exist

Acceptance criteria:

- UI can filter and inspect negative Knowledge
- Doctor reports maintenance warnings without blocking healthy setups
- seed import/export preserves polarity and intent tags
- dry-run script makes no DB changes

## Recommended Implementation Order

1. PR 1: Schema and contracts.
2. PR 2: Search filters and retrieval metadata.
3. PR 3: `register_review_corrections`.
4. PR 4: Negative coverage and draft finalization.
5. PR 5: `context_compile` guardrails.
6. PR 6: `context_decision` role mapping.
7. PR 7: feedback and dynamic score semantics.
8. PR 8: UI, seed, doctor, and cleanup.

Each PR should keep production behavior unchanged unless that PR explicitly owns the behavior change.

## Verification Gates

For focused development:

```bash
bun run typecheck
bun run test:unit
bun run build:web
```

Before merge:

```bash
bun run verify
```

Use narrower test runs while iterating, then run the full gate before committing or merging.

## Deferred Decisions

- Whether negative coverage needs a dedicated table after route metadata proves insufficient.
- Whether `intentTags` should move from `knowledge_items.intent_tags` to normalized relation rows.
- Whether draft-to-active promotion should eventually require stronger evidence thresholds.
- Whether verification-tagged neutral Knowledge needs a persisted `context_decision_evidence` role beyond coverage traces.
- Whether NightWorkers should provide a formal review-correction contract after its review ledger stabilizes.
