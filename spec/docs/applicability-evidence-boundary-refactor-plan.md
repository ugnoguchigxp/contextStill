# Applicability And Evidence Boundary Refactor Plan

## Purpose

`finding -> covering -> finalize` の一連の distillation pipeline は、applicability facets と evidence references を複数レイヤーで扱う。直近の negative knowledge 修正で、次の2点が今後の保守リスクとして残っている。

1. `technologies` / `changeTypes` / `domains` / `repoPath` / `repoKey` / `general` の正規化が、`coverNegativeEvidence`、`coverEvidence`、queue worker、`finalizeDistille` に分散している。
2. `sourceSummary` は source content の要約メタデータであり、primary evidence ではないが、型上は `supports_candidate` reference として混ざる余地がある。

この計画は、上記を小さな milestone に分けて整理し、最後に SQLite runtime で negative `find -> cover -> finalize` の統合テストを追加するための実装順序を定義する。

## Scope

### In Scope

- Applicability 正規化 helper の共通化。
- `sourceSummary` と primary source evidence の型分離。
- Finalize source linking が summary evidence を primary source fragment として扱わないことの固定。
- SQLite runtime 上で negative candidate が covering と finalize を通って draft knowledge になる統合テスト。

### Out Of Scope

- LLM prompt の大幅な再設計。
- public API contract の大きな変更。
- PostgreSQL schema の破壊的変更。
- Knowledge ranking / retrieval score の再設計。
- EpisodeCard / context_decision の applicability model 変更。

## Current State

### Applicability Duplication

現状、類似の正規化・変換処理が複数箇所にある。

- `src/modules/coverNegativeEvidence/domain.ts`
  - `normalizeAppliesTo`
  - `mergeAppliesTo`
  - `hasRequiredApplicabilityFacets`
- `src/modules/coverNegativeEvidence/parser.ts`
  - `NegativeEvidenceAppliesTo`
  - `parseAppliesTo`
- `src/modules/coverEvidence/helpers.ts`
  - `candidateOriginHintsFromOrigin`
  - `stringArrayHint`
- `src/modules/coverEvidence/parser.ts`
  - `parseApplicability`
- `src/modules/coverEvidence/repository.ts`
  - candidate と `appliesTo` column の相互変換
- `src/modules/queue/core/worker.ts`
  - `appliesToFromCoverCandidate`
  - `metadataApplicabilityForOrigin`
  - evidence row から `CoverEvidenceResult.candidate` への復元
- `src/modules/finalizeDistille/domain.ts`
  - `appliesToFromCandidate`
  - `missingApplicabilityFacets`

この状態では、negative path と positive path で同じ入力を違う形に正規化する可能性がある。

### Evidence Boundary Risk

`sourceSummary` は、candidate extraction 時に source content の該当箇所を短く要約した metadata である。これは coverage 判定の補助には使えるが、source fragment link や finalize provenance の primary evidence と同一ではない。

現在の設計で守るべき境界:

- primary evidence:
  - file token window
  - vibe memory token window
  - registered `knowledge_candidate` body
  - source fragment として再解決できる source reference
- summary evidence:
  - `origin.sourceSummary`
  - `origin.source_summary`
  - `origin.sourceEvidenceSummary`
  - `origin.evidenceSummary`

summary evidence は assessment input には使えるが、`supports_candidate` として source fragment link の対象にしてはいけない。

## Design

### 1. Shared Applicability Helper

Add:

```text
src/modules/knowledge/applicability.ts
```

Export:

```ts
export type KnowledgeApplicability = {
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
};

export type CoverCandidateApplicability = {
  applicabilityGeneral?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
};
```

Core functions:

```ts
normalizeApplicability(value: unknown): KnowledgeApplicability | undefined
mergeApplicability(...values: Array<KnowledgeApplicability | undefined>): KnowledgeApplicability | undefined
hasRequiredApplicabilityFacets(value: KnowledgeApplicability | CoverCandidateApplicability | null | undefined): boolean
missingRequiredApplicabilityFacets(value: KnowledgeApplicability | CoverCandidateApplicability | null | undefined): string[]
applicabilityFromCoverCandidate(candidate: CoverEvidenceResult["candidate"]): KnowledgeApplicability
applicabilityToCoverCandidateFields(value: KnowledgeApplicability | undefined): CoverCandidateApplicability
```

Normalization rules:

- Accept nested `appliesTo` and `applicability`.
- Accept flat fields.
- Accept arrays and comma-separated strings for `technologies`, `changeTypes`, and `domains`.
- Trim empty values.
- Deduplicate arrays while preserving first occurrence order.
- Accept both `general` and `applicabilityGeneral`.
- Store canonical object with `general`, not `applicabilityGeneral`.
- Convert to `applicabilityGeneral` only when applying to `CoverEvidenceCandidate`.

### 2. Source Evidence Boundary Types

Prefer a non-breaking intermediate shape first:

```ts
export type CoverEvidenceSourceRead = {
  primaryContent: string | null;
  assessmentContent: string;
  assessmentSource: "primary" | "source_summary";
  references: CoverEvidenceReference[];
  readRanges: Array<{ from: number; toExclusive: number }>;
};
```

Migration mapping:

- Existing `content` -> `primaryContent`
- Existing `valueAssessmentContent` -> `assessmentContent`
- primary source read -> `assessmentSource: "primary"`
- summary fallback -> `primaryContent: null`, `assessmentSource: "source_summary"`

Extend reference role:

```ts
evidenceRole:
  | "supports_candidate"
  | "dedupe_match"
  | "external_verification"
  | "source_summary"
```

Rules:

- `evaluateSourceSupport` must use `primaryContent` only.
- If `primaryContent` is null and only `source_summary` exists, skip strict source support and continue to evidence assessment with explicit summary context, or return `insufficient` if the current stage requires primary evidence.
- `runExternalEvidence` may receive `assessmentContent`, but prompts should label it as summary context when `assessmentSource === "source_summary"`.
- `linkResolvableSourceReferences` must link only `supports_candidate` references.
- `source_summary` references must stay in metadata for audit/provenance, but not source fragment links.

### 3. Negative SQLite Runtime Integration Test

Add one provider-less SQLite runtime integration test to:

```text
test/sqlite-runtime-support.bun.ts
```

Test name:

```text
processes negative finding through covering and finalize in sqlite runtime
```

The test should prove the SQLite-backed queue path, not just Vitest mocks.

Required setup:

1. Create a SQLite runtime test DB through the existing test setup.
2. Seed a `finding_candidate_queue` row.
3. Seed a selected `found_candidates` row with:
   - `origin.polarity = "negative"`
   - `origin.intentTags`
   - `metadata.appliesTo` or direct applicability fields
4. Seed a `covering_evidence_queue` row for that candidate.
5. Use deterministic injected/mocked coverEvidence behavior so no real provider call is needed.
6. Run covering worker.
7. Confirm `evidence_coverage_results` row is `knowledge_ready`.
8. Confirm `finalize_distille_queue` row is created.
9. Use deterministic embedding or an embedding mock path.
10. Run finalize worker.
11. Confirm `knowledge_items` row is draft negative knowledge.

Expected SQLite assertions:

- `evidence_coverage_results.status = "knowledge_ready"`
- `evidence_coverage_results.applies_to` contains:
  - `technologies`
  - `changeTypes`
  - `domains`
- `evidence_coverage_results.tool_events` contains `negative_coverage`.
- `finalize_distille_queue.status = "completed"`
- `knowledge_items.polarity = "negative"`
- `knowledge_items.status = "draft"`
- `knowledge_items.applies_to` preserves the same facets.
- `knowledge_items.metadata` keeps references/toolEvents needed for audit.

## Implementation Milestones

### Milestone 1: Add Shared Applicability Module

Files:

- `src/modules/knowledge/applicability.ts`
- `test/applicability.test.ts`

Tasks:

1. Add `KnowledgeApplicability` and `CoverCandidateApplicability`.
2. Implement normalize / merge / missing-facet helpers.
3. Add unit tests for:
   - nested `appliesTo`
   - nested `applicability`
   - flat fields
   - comma-separated strings
   - arrays with empty entries
   - `general` vs `applicabilityGeneral`
   - merge priority

Acceptance:

- Unit tests pass.
- No caller behavior changed yet.

Verification:

```bash
bunx vitest run test/applicability.test.ts
```

### Milestone 2: Replace Duplicate Applicability Logic

Files:

- `src/modules/coverNegativeEvidence/domain.ts`
- `src/modules/coverNegativeEvidence/parser.ts`
- `src/modules/coverEvidence/helpers.ts`
- `src/modules/coverEvidence/parser.ts`
- `src/modules/coverEvidence/repository.ts`
- `src/modules/queue/core/worker.ts`
- `src/modules/finalizeDistille/domain.ts`

Tasks:

1. Replace local applicability parsers with shared helper calls.
2. Preserve current public shapes:
   - DB JSON uses `general`.
   - `CoverEvidenceCandidate` uses `applicabilityGeneral`.
3. Keep `missingRequiredApplicabilityFacets` as the only required-facet gate.
4. Remove local duplicate helpers after each caller is migrated.

Acceptance:

- Positive coverEvidence output shape is unchanged.
- Negative coverEvidence output shape is unchanged except implementation source.
- Finalize reject reason remains `applies_to_categories_required`.
- Queue persistence still writes canonical `applies_to`.

Verification:

```bash
bunx vitest run \
  test/cover-negative-evidence.test.ts \
  test/cover-evidence.test.ts \
  test/finalize-distille.test.ts \
  test/queue-worker.test.ts
```

### Milestone 3: Split Source Summary From Primary Evidence

Files:

- `src/modules/coverEvidence/types.ts`
- `src/modules/coverEvidence/source-support.service.ts`
- `src/modules/coverEvidence/domain.ts`
- `src/modules/coverEvidence/prompts.ts`
- `src/modules/finalizeDistille/domain.ts`
- `test/source-support.test.ts`
- `test/cover-evidence.test.ts`
- `test/finalize-distille.test.ts`

Tasks:

1. Add `source_summary` evidence role.
2. Change `CoverEvidenceSourceRead` to distinguish:
   - primary source content
   - assessment content
   - assessment source kind
3. Update summary fallback to return `source_summary` reference.
4. Update source support so summary is not treated as primary source content.
5. Update final evidence prompt context to label summary content clearly.
6. Ensure finalize source linking ignores `source_summary`.

Acceptance:

- Missing source + source summary does not produce a fake `supports_candidate` source reference.
- Summary can still be included as labeled assessment context if the domain flow permits it.
- Candidate body fallback remains absent.
- Source links are created only from primary source references.

Verification:

```bash
bunx vitest run \
  test/source-support.test.ts \
  test/cover-evidence.test.ts \
  test/finalize-distille.test.ts
```

### Milestone 4: Add Negative SQLite Runtime E2E

Files:

- `test/sqlite-runtime-support.bun.ts`
- test setup or small injection helper only if needed

Tasks:

1. Seed SQLite queue tables with a negative selected candidate.
2. Run covering queue worker with deterministic evidence behavior.
3. Assert persisted coverage row and finalize queue row.
4. Run finalize queue worker with deterministic embedding behavior.
5. Assert draft negative knowledge row.

Acceptance:

- The test proves actual SQLite persistence across covering and finalize.
- The test does not call a real LLM provider.
- The test does not depend on build output or production compilation artifacts.
- The test fails if applicability facets are dropped.
- The test fails if `negative_coverage` metadata is lost.

Verification:

```bash
bun test ./test/sqlite-runtime-support.bun.ts -t "negative finding"
```

### Milestone 5: Full Verification

Commands:

```bash
bunx vitest run \
  test/applicability.test.ts \
  test/source-support.test.ts \
  test/cover-negative-evidence.test.ts \
  test/cover-evidence.test.ts \
  test/finalize-distille.test.ts \
  test/queue-worker.test.ts

bun test ./test/sqlite-runtime-support.bun.ts -t "negative finding"

bun run verify
```

If `verify:sqlite` is used as an additional gate:

```bash
bun run verify:sqlite
```

## Risks And Controls

| Risk | Control |
|---|---|
| Shared helper changes output shape silently | Add before/after unit tests and keep DB JSON canonical as `general` |
| Positive coverEvidence prompt parser loses fallback behavior | Keep parser tests for flat and nested applicability |
| Summary evidence is too restricted and causes lower coverage throughput | Allow labeled `assessmentContent` while preventing source links |
| Source summary still becomes linkable evidence | Add finalize test proving `source_summary` is ignored by `linkResolvableSourceReferences` |
| SQLite E2E becomes flaky due to provider calls | Use deterministic injection/mock path; do not use real provider |
| Refactor touches too many queue paths | Migrate applicability helpers first, then evidence boundary, then SQLite E2E |

## Done Criteria

- One shared module owns applicability normalization, merge, serialization, and required-facet checks.
- `sourceSummary` cannot be accidentally treated as primary `supports_candidate` evidence.
- Finalize links source fragments only for primary source references.
- SQLite runtime test proves negative coverage can persist and finalize into draft negative knowledge.
- `bun run verify` passes.

## Non-Goals

- Do not weaken `finalizeDistille` applicability requirements.
- Do not reintroduce candidate body fallback for missing vibe memory.
- Do not make source summaries disappear from audit metadata.
- Do not require live provider calls in default tests.
