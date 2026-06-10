# Negative Knowledge Implementation Plan

## Scope

Implement the concept from [Negative Knowledge Concept](negative-knowledge-concept.md) in small, reviewable slices.

This plan covers:

- Knowledge polarity.
- Flexible intent tags.
- Review correction registration.
- Negative evidence coverage.
- Context compile rendering.
- Context decision role mapping.
- Feedback and scoring semantics.
- Migration, seed, and UI changes.

This plan does not implement code review execution or multi-agent review orchestration. Review findings can come from humans, local scripts, another agent system, or a separate project. context-still only owns distilled reusable Knowledge and the candidate/feedback lifecycle.

## Design Summary

Use a hybrid model:

```text
External or human review findings
  -> manually accepted/deferred valid findings
  -> context-still register_review_corrections
  -> negative candidate
  -> covering negative evidence
  -> distilled Knowledge with polarity/tags/origin links
  -> context_compile guardrails and context_decision risk/counter evidence
```

Fixed fields:

```text
polarity = positive | negative | neutral
```

Flexible fields:

```text
intentTags = string[]
```

Stable decision behavior:

```text
decision roles = support | counter_evidence | risk | verification | user_preference | alternative
```

In the current codebase this means:

- retrieval and coverage query roles use `contextDecisionCoverageQueryRoleValues`
- persisted evidence roles use `contextDecisionEvidenceRoleValues`
- `risk` should initially persist as `risk_warning`
- `support` should initially persist as `selected_support`
- additional persisted evidence roles should be added only when the existing role set cannot represent the behavior

## Fixed Implementation Decisions

These decisions are fixed for the first implementation pass.

| Topic | Decision |
|---|---|
| Polarity storage | First-class `knowledge_items.polarity` column |
| Intent tag storage | First-class `knowledge_items.intent_tags` JSONB array of normalized slugs |
| Intent taxonomy | Extend `knowledge_tag_definitions.kind` with `intent`; do not add a closed intent enum |
| Review correction input | Add bulk MCP tool `register_review_corrections` |
| Review correction output | Create candidates only; do not persist raw review findings in context-still |
| Raw review ledger | Out of scope for context-still; source systems or humans own raw review records |
| Negative coverage module | Add a separate `coverNegativeEvidence` module |
| Negative coverage storage | Use existing candidate/queue path initially, with route metadata; add a dedicated table only if result shape cannot stay compatible |
| Context pack rendering | Add structured `guardrails: ContextPackItem[]`; keep `warnings` for compatibility |
| Draft to active promotion | Same as existing Knowledge: human review/approval. Keep it intentionally loose in the first implementation. |
| Wrong/noisy negative Knowledge | Same as existing Knowledge: use feedback to identify noise, then manually deprecate or edit from the admin/review surface |

## Non-Goals

- Do not store raw review findings as Knowledge.
- Do not make context-still the code review executor.
- Do not route review correction flow through `knowledge_review_queue`.
- Do not make intent tags a closed enum.
- Do not automatically convert existing "never" rules into active negative Knowledge.
- Do not make another project depend on context-still internals.

## Phase 1: Schema And Contracts

### Goal

Add polarity and tag contracts without changing runtime selection behavior.

### Database

Add to `knowledge_items`:

```text
polarity text not null default 'positive'
intent_tags jsonb not null default '[]'
```

Checks:

```text
polarity in ('positive', 'negative', 'neutral')
intent_tags is JSON array
```

Indexes:

```text
knowledge_items_polarity_idx
knowledge_items_intent_tags_gin_idx
knowledge_items_status_polarity_idx
```

Add review-correction compatible origin support to `knowledge_origin_links.origin_kind`.

Initial allowed additions:

```text
review_finding
external_review_run
review_correction
```

Do not create a separate negative Knowledge table in this slice.

Update constants:

- add `knowledgePolarityValues = ["positive", "negative", "neutral"]`
- add `"intent"` to `knowledgeTagKindValues`
- add review-origin values through a reusable constant instead of hardcoding the SQL check inline

### Shared Schemas

Update Knowledge schemas:

- `KnowledgeItem`
- `registerKnowledgeInputSchema`
- `registerCandidateInputSchema`
- `updateKnowledgeInputSchema`
- `knowledgeSearchInputSchema`
- Knowledge API list/detail schemas

Add:

```ts
polarity: "positive" | "negative" | "neutral";
intentTags: string[];
```

Defaults:

- new Knowledge defaults to `positive`
- existing rows are backfilled to `positive`
- candidates registered without polarity remain `positive`
- API inputs may omit the fields, but parsed entities should always expose defaulted values

### Tag Definitions

Extend `knowledge_tag_definitions.kind` to include:

```text
intent
```

Seed initial intent tag definitions:

- `guidance`
- `guardrail`
- `prohibition`
- `warning`
- `failure_pattern`
- `review_finding`
- `regression`
- `test_gap`
- `verification`
- `preference`
- `boundary_violation`
- `architecture_risk`
- `security_risk`
- `performance_risk`
- `operational_risk`

Keep aliases in tag definitions, not in enum code.

### Tests

- migration creates polarity and intent tag fields
- legacy rows default to `positive`
- schema rejects invalid polarity
- schema accepts flexible intent tags
- origin link accepts `review_finding`
- existing register candidate tests still pass with omitted polarity

### PR 1 File Targets

- `src/db/schema.constants.ts`
- `src/db/schema-knowledge.ts`
- `src/shared/schemas/knowledge.schema.ts`
- `api/modules/knowledge/*`
- `src/modules/knowledge/*`
- focused schema/repository/API tests

## Phase 2: Search And Retrieval Filters

### Goal

Make polarity and intent tags queryable before changing compile or decision behavior.

### MCP And API

Add optional filters to:

- `search_knowledge`
- Knowledge list API
- Knowledge admin filters

Fields:

```ts
polarities?: Array<"positive" | "negative" | "neutral">;
intentTags?: string[];
```

Filtering behavior:

- omitted `polarities` preserves current behavior
- omitted `intentTags` preserves current behavior
- intent tag matching should use normalized slug matching
- include aliases only through tag normalization service, not ad hoc string matching in routes

### Repository

Update retrieval queries to carry polarity and intent metadata in results.

Do not change ranking in this phase.

Make sure vector and text retrieval return the same polarity/tag metadata, otherwise `context_compile` and `context_decision` will diverge by retrieval method.

### Tests

- `search_knowledge` can return only negative items
- `search_knowledge` can return only positive items
- list API supports polarity filter
- flexible intent tag filters work
- omitted filters preserve current results

## Phase 3: Review Correction Registration

### Goal

Add a dedicated bulk MCP tool for accepted review findings.

### MCP Tool

Add:

```text
register_review_corrections
```

Input shape:

```ts
{
  items: Array<{
    title: string;
    finding: string;
    impact?: string;
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

- reject `rejected_false_positive`
- reject missing `reviewFindingId`
- reject items without `finding`
- default `polarity=negative`
- default `intentTags=["review_finding"]`
- write as candidate, not active Knowledge
- preserve origin metadata and create origin link-compatible metadata
- set `metadata.reviewCorrection` with the origin payload
- set candidate origin `source` to `mcp_register_review_corrections`
- include `polarity` and `intentTags` in the candidate payload and origin metadata
- `origin.system` must be treated as provenance metadata only, not as a hard dependency on a specific external project

Naming:

- tool name should be plural: `register_review_corrections`
- it should be bulk-first, with max item count aligned to `register_candidates`

### Candidate Shape

Normalize candidate body:

```text
Failure:
Impact:
Trigger:
Fix:
Verification:
Decision signal:
```

If fields are missing, keep placeholders out of the body. Do not invent missing evidence.

Set candidate `type` to `rule` by default. Negative procedures are not allowed in the first slice because a `procedure` can be misread as something to execute. If a later design needs negative procedures, it must add rendering and scoring rules first.

### Tests

- valid accepted finding creates a negative candidate
- fixed finding creates a negative candidate
- deferred valid finding creates a negative candidate
- false-positive status is rejected
- duplicate reviewFindingId is idempotent or reported as duplicate
- bulk partial failures report per item
- MCP contract lists the new tool

## Phase 4: Covering Negative Evidence

### Goal

Verify and shape negative candidates with a dedicated coverage route.

### Pipeline

Do not reuse positive coverEvidence prompts unchanged.

Add a negative evidence route that evaluates:

- did the failure/risk really occur?
- is the finding accepted or fixed/deferred for a valid reason?
- is it a false positive?
- is the lesson reusable beyond one run?
- which tag category fits: guardrail, prohibition, failure pattern, verification, risk?
- what verification should be required in future?

Working module options:

- `src/modules/coverNegativeEvidence/`

Use a separate module because prompt, parser, result statuses, and promotion rules are materially different from positive coverEvidence.

### Output

Negative coverage result should include:

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

### Finalization

Only `ready` negative coverage results can become active/draft Knowledge.

`false_positive` should not create Knowledge. It may record audit metadata for reviewer calibration when a source system provides a ledger, but that ledger is outside context-still.

First implementation should finalize ready negative results as `draft` by default. Promotion to `active` should use the same human review/approval baseline as existing Knowledge. This is intentionally a loose approval model in the first implementation; automation can be reconsidered only after enough feedback evidence exists.

### Tests

- accepted fixed finding can become ready negative Knowledge
- false positive result does not create Knowledge
- not reusable result does not create Knowledge
- negative output parser rejects positive procedure format
- finalization preserves polarity and intent tags
- source/origin links are retained

## Phase 5: Context Compile Rendering

### Goal

Allow `context_compile` to use negative Knowledge safely.

### Retrieval

Initial behavior:

- normal rule/procedure sections continue to prefer `polarity=positive`
- negative Knowledge is retrieved for warnings/guardrails only
- neutral verification Knowledge can appear as verification guidance

Add a guardrail retrieval pass or post-filter:

```text
positive -> rules/procedures
negative -> warnings/guardrails
neutral + verification tags -> verification notes
```

### Pack Schema

Existing schema has `warnings`, but `warnings: string[]` cannot carry Knowledge identity, source refs, polarity, or feedback metadata.

Implementation path:

- add structured `guardrails: ContextPackItem[]`
- add `guardrails` to pack schema with default `[]`
- add `guardrails` to token budgeting and pack rendering
- keep `warnings` for compatibility and non-Knowledge warnings
- do not add `risks` in the first slice; use `guardrails` as the structured negative Knowledge section

### Rendering

Guardrail text must be framed as avoid/check language, never as a task instruction.

Example:

```text
Guardrails
- Avoid changing artifact selectors to prefer task-message metadata before artifact rows.
  Prior failure: stale preview was shown when canonical artifact data existed.
  Verify: test both artifact row and task message present, artifact row wins.
```

### Tests

- negative Knowledge is not rendered in positive procedures
- guardrails render separately
- pack schema remains backward compatible
- token budget handles guardrails
- no content behavior is unchanged when no guardrails exist

## Phase 6: Context Decision Role Mapping

### Goal

Use negative Knowledge as risk and counter-evidence without relying on closed intent enums.

### Mapper

Add a deterministic mapper:

```text
Knowledge + query role + polarity + intentTags -> decision evidence role
```

Mapping rules:

- `polarity=positive` -> `selected_support` by default when selected
- `polarity=negative` + `guardrail` / `prohibition` -> `risk_warning`
- `polarity=negative` + `failure_pattern` / `regression` -> `risk_warning`; use coverage query role `counter_evidence` to record counter-evidence strength
- `test_gap` / `verification` -> keep as coverage trace first; add a persisted evidence role only if UI/API needs item-level verification evidence
- `preference` -> `user_preference`
- unknown tags fall back to polarity and query role

This keeps tags flexible while decision behavior stays stable.

### Scoring

Do not reuse positive support scoring blindly.

Negative evidence should influence:

- risk score
- counter-evidence strength
- recommended decision
- verification requirements

It should not become positive support just because its dynamic score is high.

The first slice should not add a new final decision value. It should change evidence assessment and confidence trace only, then let the existing decision set (`execute`, `reject`, `revise_and_execute`, `rollback`, `discard`, `escalate`) carry the outcome.

### Tests

- negative failure pattern can cause revise/reject when applicable
- negative guardrail appears as risk
- positive guidance still supports execute
- unknown intent tags do not break mapping
- conflicting positive and negative evidence produces explicit conflict trace

## Phase 7: Feedback And Dynamic Score Semantics

### Goal

Make usage feedback meaningful for different polarities.

### Semantics

Positive:

- `used`: guidance/procedure helped execution
- `not_used`: selected but not useful
- `off_topic`: irrelevant
- `wrong`: incorrect Knowledge

Negative:

- `used`: warning/guardrail helped avoid or catch a problem
- `not_used`: warning was selected but not needed
- `off_topic`: risk was irrelevant
- `wrong`: warning or failure pattern was false or misleading

### Scoring

Update dynamic scoring to account for polarity.

Possible first slice:

- keep same storage table
- keep same verdict values
- change labels and scoring weights by polarity
- add tests showing negative `used` increases warning value, not procedure priority

Initial weight rule:

- positive `used`: existing boost semantics
- negative `used`: boost guardrail/risk selection only
- negative `not_used`: mild penalty
- negative `off_topic`: stronger penalty
- negative `wrong`: route through the existing wrong feedback/review path and strongly suppress until reviewed

### Tests

- negative used increases dynamic score without moving it into procedure output
- negative off_topic reduces future guardrail selection
- wrong negative Knowledge can enter the existing wrong-review path
- UI labels differ by polarity

### Noisy Knowledge Removal Baseline

If negative Knowledge becomes noise in `context_compile` or `context_decision`, the baseline operation is the same as existing Knowledge:

- capture `not_used`, `off_topic`, or `wrong` feedback
- surface that feedback in the existing review/admin flow
- let the user manually edit, deprecate, or keep the item

Do not add an automatic deletion path in the first implementation. `deprecated` remains the lifecycle state for removing a noisy or obsolete Knowledge item from active selection.

## Phase 8: Admin UI Refresh

### Goal

Make polarity and review provenance understandable.

### Knowledge UI

Add:

- polarity filter
- intent tag filter
- origin kind filter
- review finding provenance panel
- badges for guardrail/failure/verification
- separate rendering for negative body format

Do not hide negative Knowledge inside the existing positive-only mental model.

### Context Compiler UI

Add:

- guardrails/risk section
- feedback labels that reflect polarity
- trace detail showing why negative Knowledge was selected

### Decision UI

Add:

- risk/counter evidence grouped separately
- polarity badges
- conflict trace between positive and negative evidence

### Tests

- Knowledge list can filter negative items
- context compile detail renders guardrails separately
- decision detail shows risk evidence separately
- feedback buttons keep existing behavior but labels reflect polarity

## Phase 9: Migration, Cleanup, And Seed

### Goal

Move existing data safely and prepare curated negative Knowledge.

### Initial Migration

- backfill all existing Knowledge to `polarity=positive`
- backfill empty `intentTags=[]`
- do not auto-convert "never" rules

### Candidate Extraction

Add a dry-run script to find prohibition-like existing Knowledge:

Patterns:

- `never`
- `avoid`
- `do not`
- `must not`
- `禁止`
- `避ける`
- `しない`

Output:

- candidate ID
- suggested polarity
- suggested intent tags
- reason
- confidence

Do not write by default.

Script name:

```text
bun run knowledge:negative-candidates:dry-run
```

Implementation target:

```text
src/cli/negative-knowledge-candidates.ts
```

### Cleanup

After review:

- deduplicate overlapping positive/negative pairs
- merge intent tag aliases
- seed curated intent tag definitions
- export seed after taxonomy stabilizes

### Tests

- migration is reversible in test DB
- dry-run script writes no DB changes
- seed export includes polarity and intent tags
- seed import preserves polarity and intent tags

## Phase 10: Operations And Doctor

### Goal

Make the new system observable.

### Doctor

Add non-blocking diagnostics:

- negative Knowledge count
- negative Knowledge with no origin links
- negative Knowledge selected as positive procedure
- false-positive candidate leakage count
- unknown intent tag count
- unnormalized intent alias count

### Metrics

Track:

```text
negativeKnowledgeCount
reviewCorrectionCandidateCount
negativeCoverageReadyCount
negativeCoverageFalsePositiveCount
negativeUsedRate
negativeOffTopicRate
guardrailSelectionCount
decisionRiskEvidenceCount
decisionCounterEvidenceCount
```

### Tests

- doctor reports counts without blocking healthy local setups
- unknown tags are maintenance warnings, not failures
- missing origin links are maintenance warnings

## PR 1 Acceptance Criteria

PR 1 is implementation-ready when it satisfies all of these:

- migrations add `polarity` and `intent_tags`
- existing rows read as `polarity=positive` and `intentTags=[]`
- schemas expose defaulted `polarity` and `intentTags`
- Knowledge list/detail APIs include the new fields
- `register_candidate` and `register_candidates` remain backward compatible
- `knowledge_tag_definitions.kind` accepts `intent`
- origin links accept `review_finding`, `external_review_run`, and `review_correction`
- no compile or decision behavior changes yet
- focused tests plus typecheck pass

## PR 2 Acceptance Criteria

PR 2 is implementation-ready when it satisfies all of these:

- `search_knowledge` accepts `polarities` and `intentTags`
- Knowledge list API supports polarity/tag filters
- text and vector retrieval return polarity/tag metadata consistently
- omitted filters preserve current retrieval behavior
- no ranking behavior changes yet

## PR Slicing

Recommended implementation order:

1. Schema/contracts only: polarity, intent tags, origin kinds, tests.
2. Search/list filters and metadata propagation.
3. `register_review_corrections` MCP tool and candidate normalization.
4. Negative coverage parser/prompt/result model.
5. Finalization support for negative candidates.
6. Context compile guardrail rendering.
7. Context decision role mapper.
8. Feedback/scoring semantics by polarity.
9. Admin UI refresh.
10. Migration cleanup, seed/export/import, doctor metrics.

Each PR should keep production behavior unchanged unless the PR explicitly owns the behavior change.

## Verification Gates

For each PR:

```bash
bun run typecheck
bun run test:unit
bun run build:web
```

Before merge:

```bash
bun run verify
```

Focused suites:

- `test/mcp.contract.test.ts`
- `test/mcp.tools.test.ts`
- Knowledge repository/API tests
- coverEvidence or negative coverage parser tests
- context compiler tests
- context decision tests
- doctor tests

## Deferred Implementation Decisions

These are intentionally deferred beyond the first implementation pass:

1. Should negative coverage receive a dedicated table after the first route-metadata implementation?
2. Should intent tags eventually move from `knowledge_items.intent_tags` into normalized relation rows?
3. Should promotion from draft to active eventually gain stronger evidence thresholds after human-review feedback accumulates?
