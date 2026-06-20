# Negative Knowledge Coverage To Finalize Implementation Plan

## Purpose

negative knowledge を `coveringEvidence` queue 経由で evidence coverage し、`finalizeDistille` で draft knowledge として保存できる状態にする。

現状は negative candidate の検出、negative evidence 収集、`polarity: "negative"` の伝播までは実装されている。一方で、`runCoverNegativeEvidence` が生成する `CoverEvidenceResult.candidate` に `technologies` / `changeTypes` / `domains` が入らないため、`finalizeDistille` の `applies_to_categories_required` gate で reject される可能性が高い。

この計画は、negative evidence の primary evidence を保ったまま、finalize に必要な applicability metadata を deterministic に補完し、queue 経由の統合テストで固定するための実装手順を定義する。

## Current Flow

1. `findCandidate` / registration は candidate に `polarity: "negative"` を付与できる。
2. `coverEvidence` は `origin.polarity === "negative"` の candidate を `runCoverNegativeEvidence` にルーティングする。
3. `runCoverNegativeEvidence` は negative-specific prompt と parser で `negative_coverage` tool event を作る。
4. `coveringEvidence` queue worker は `evidence_coverage_results.tool_events` に `negative_coverage` を保存する。
5. `finalizeDistille` は `negative_coverage` event から `polarity` と `intentTags` を取り出して `upsertKnowledgeFromSource` に渡す。

## Gaps

### Gap 1: Applicability Facets Are Missing

`finalizeDistille` は `knowledge_ready` candidate に `technologies`, `changeTypes`, `domains` の3カテゴリを要求する。positive coverEvidence は prompt / parser / candidate hints でこれらを扱うが、negative coverEvidence の schema にはまだない。

Impact:
- negative evidence collection can succeed.
- polarity propagation can succeed.
- knowledge finalization can still reject with `applies_to_categories_required`.

### Gap 2: Tests Cover Pieces But Not The Whole Queue Path

Existing tests cover:
- negative candidate routing to `runCoverNegativeEvidence`.
- negative polarity / intentTags passed by finalize when facets are present.
- queue storing negative polarity for downstream covering.

Missing test:
- a negative candidate goes through covering queue, persists `evidence_coverage_results`, creates finalize job, then finalizes into draft negative knowledge.

### Gap 3: Evidence And Summary Metadata Need Clear Boundaries

negative knowledge must not treat UI summary metadata as primary evidence. Primary evidence should stay in `references` and `negative_coverage.metadata.distilled`; applicability metadata should describe where the guardrail applies, not be used as the evidence itself.

## Design

### 1. Extend Negative Evidence Result Schema

Add applicability fields to `NegativeEvidenceResult`:

```ts
appliesTo?: {
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
  general?: boolean;
}
```

Parser rules:
- Accept arrays and comma-separated strings where useful.
- Normalize empty arrays away.
- Keep unknown fields ignored.
- Preserve `polarity` and `intentTags` behavior.

### 2. Update Negative Evidence Prompt

Ask the model to return applicability metadata with these constraints:
- `technologies`, `changeTypes`, `domains` must each contain at least one item for `status: "ready"`.
- Values should be source-grounded and conservative.
- If the model cannot identify the three categories, it should return `status: "insufficient"` with evidence explaining the gap.
- Applicability is not evidence. Evidence must remain in `evidence` and `originRefs`.

### 3. Add Deterministic Facet Fallbacks

Do not rely only on LLM output. Merge applicability in this priority order:

1. Parsed negative evidence `appliesTo`.
2. Candidate origin/applicability hints.
3. Candidate metadata hints from `found_candidates.metadata`.
4. Source kind fallback only where safe:
   - `targetKind: "knowledge_candidate"` can default domain to `knowledge-registration` only if no better domain exists.
   - Avoid broad defaults like `typescript` unless source metadata supports them.

If the final candidate still lacks any required facet, keep finalize rejection as-is. The improvement should not weaken `finalizeDistille` quality gates.

### 4. Map Negative Evidence To CoverEvidence Candidate

When `parsed.status === "ready"`, construct the candidate with:
- `type: "rule"`.
- `title` from the original candidate.
- `body` from distilled failure/impact/trigger/fix/verification/decisionSignal.
- `importance` and `confidence` conservatively set or parsed if added later.
- `technologies`, `changeTypes`, `domains`, `repoPath`, `repoKey`, `applicabilityGeneral` from merged applicability.

Keep `negative_coverage` event metadata:
- `polarity`
- `intentTags`
- `originRefs`
- `distilled`
- `appliesTo`

### 5. Preserve Manual Approval Semantics

If a `knowledge_candidate` is linked to a landscape review item, finalize must still require approved/finalized landscape status before storage. This plan should not bypass `landscape_manual_approval_required`.

## Implementation Milestones

### Milestone 1: Schema And Parser

Files:
- `src/modules/coverNegativeEvidence/parser.ts`
- `src/modules/coverNegativeEvidence/prompts.ts`

Tasks:
- Extend `NegativeEvidenceResult`.
- Add `appliesTo` normalization helpers.
- Update prompt JSON schema and instructions.
- Add parser tests for arrays, comma-separated values, missing appliesTo, and unknown fields.

Acceptance:
- `parseNegativeEvidenceResult` returns normalized applicability metadata.
- Invalid or missing applicability does not throw by itself; status can still express insufficiency.

### Milestone 2: Domain Mapping

Files:
- `src/modules/coverNegativeEvidence/domain.ts`
- optionally shared helper extracted from `coverEvidence/helpers.ts` if duplication becomes meaningful.

Tasks:
- Merge applicability from parsed result and origin hints.
- Put merged facets on `CoverEvidenceResult.candidate`.
- Put the same facets into `negative_coverage.metadata.appliesTo`.
- Keep `references` as primary evidence.

Acceptance:
- A ready negative result includes `candidate.technologies`, `candidate.changeTypes`, and `candidate.domains`.
- A non-ready negative result does not create a candidate.
- The result still carries `negative_coverage` with polarity and intentTags.

### Milestone 3: Queue Persistence Contract

Files:
- `src/modules/queue/core/worker.ts`
- `test/queue-worker.test.ts`
- SQLite runtime test if needed.

Tasks:
- Confirm `applies_to` persists from negative coverage result.
- Confirm `tool_events` persist `negative_coverage.metadata.appliesTo`.
- Add queue worker test where mocked `runCoverEvidence` returns negative-ready result with facets and finalize job is created.

Acceptance:
- `evidence_coverage_results.applies_to` contains the negative applicability facets.
- `finalize_distille_queue` is enqueued for `knowledge_ready` negative coverage.

### Milestone 4: Finalize Integration

Files:
- `test/finalize-distille.test.ts`
- optionally `test/cover-negative-evidence.test.ts`

Tasks:
- Add a test using an actual `runCoverNegativeEvidence` output shape with appliesTo, not a manually patched ready result.
- Confirm `upsertKnowledgeFromSource` receives:
  - `polarity: "negative"`
  - `intentTags`
  - `appliesTo`
  - source metadata and references

Acceptance:
- finalize stores draft negative knowledge when facets are present.
- finalize still rejects missing facets.
- finalize still respects landscape manual approval.

### Milestone 5: End-To-End SQLite Path

Files:
- `test/sqlite-runtime-support.bun.ts` or a narrower SQLite queue integration test.

Tasks:
- Seed a negative `found_candidate`.
- Process `coveringEvidence` using a deterministic mock or injected chat client path.
- Confirm `evidence_coverage_results` stores negative-ready coverage with facets.
- Process `finalizeDistille`.
- Confirm draft knowledge row has `polarity = negative` and expected intent tags.

Acceptance:
- The full SQLite queue path is covered without a real provider call.
- The test proves evidence collection and knowledge finalization, not just polarity storage.

## Verification Plan

Run focused tests first:

```bash
bunx vitest run test/cover-negative-evidence.test.ts test/finalize-distille.test.ts test/queue-worker.test.ts
```

Run registration tests:

```bash
bunx vitest run test/register-candidate.service.test.ts test/register-candidate.integration.test.ts
```

Run SQLite focused path:

```bash
bun test ./test/sqlite-runtime-support.bun.ts -t "negative|covering|finalize"
```

Run type and formatting gates:

```bash
bun run typecheck
bunx biome check src/modules/coverNegativeEvidence src/modules/queue/core/worker.ts test/cover-negative-evidence.test.ts test/finalize-distille.test.ts test/queue-worker.test.ts
```

If the broader SQLite runtime suite is still blocked by the existing compile-eval ordering failure, report it separately and do not treat it as proof of negative knowledge failure.

## Done Criteria

- negative candidate routes to negative coverage.
- negative coverage returns or derives required applicability facets.
- queue persistence preserves candidate facets and negative tool event metadata.
- finalize stores draft knowledge with `polarity: "negative"`.
- missing facets still reject.
- manual approval still blocks landscape-linked `knowledge_candidate` finalization.
- focused tests pass without real provider calls.

## Non-Goals

- Do not weaken `finalizeDistille` applicability requirements.
- Do not bypass landscape manual approval.
- Do not treat display summaries as primary evidence.
- Do not require a real LLM/provider in default tests.
