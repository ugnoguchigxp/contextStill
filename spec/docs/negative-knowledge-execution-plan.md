# Negative Knowledge Execution Plan

> Created: 2026-06-11
> Status: ready to implement
> Source concept: [Negative Knowledge Concept](negative-knowledge-concept.md)
> High-level plan: [Negative Knowledge Implementation Plan](negative-knowledge-implementation-plan.md)

## Fixed Decisions

These are no longer open questions.

- `intentTags` starts as `knowledge_items.intent_tags` JSONB.
- `polarity` is a first-class `knowledge_items.polarity` column.
- `register_review_corrections` duplicate handling is a duplicate error, not idempotent success.
- Negative coverage uses the existing distillation / covering evidence / finalization shape.
- Do not add a dedicated negative coverage table in the first implementation.
- Ready negative results finalize to draft Knowledge.
- Humans activate draft negative Knowledge from the Knowledge screen or a closely related review view.
- Raw review findings stay outside contextStill.

## Implementation Target

Build this flow:

```text
accepted review correction
  -> register_review_corrections
  -> negative candidate
  -> existing coverage/finalization path with negative metadata
  -> draft negative Knowledge
  -> human activates draft
  -> context_compile guardrail
  -> context_decision risk / counter-evidence / verification trace
```

## Storage Strategy

Use existing storage paths.

Add columns:

```text
knowledge_items.polarity text not null default 'positive'
knowledge_items.intent_tags jsonb not null default '[]'
```

Extend existing checks:

- `knowledge_tag_definitions.kind` accepts `intent`
- `knowledge_origin_links.origin_kind` accepts `review_finding`, `external_review_run`, `review_correction`

Do not add:

- `negative_knowledge`
- `negative_coverage_results`
- `review_findings`
- another review ledger table

Store negative-specific context in existing metadata:

- candidate metadata
- distillation target metadata
- coverage result metadata
- Knowledge metadata
- origin links

If metadata later proves insufficient for audit, replay, or UI, revisit after the first working end-to-end implementation.

## Slice 1: Schema And Contracts

### Files

- `src/db/schema.constants.ts`
- `src/db/schema-knowledge.ts`
- `src/shared/schemas/knowledge.schema.ts`
- `api/modules/knowledge/knowledge.repository.types.ts`
- `api/modules/knowledge/knowledge.repository.ts`
- `api/modules/knowledge/knowledge.routes.ts`
- new Drizzle migration

### Work

1. Add `knowledgePolarityValues = ["positive", "negative", "neutral"]`.
2. Add `"intent"` to `knowledgeTagKindValues`.
3. Add shared origin kind constants for `knowledge_origin_links`.
4. Add `polarity` and `intentTags` to `knowledgeItems`.
5. Add DB checks and indexes:
   - `knowledge_items_polarity_idx`
   - `knowledge_items_intent_tags_gin_idx`
   - `knowledge_items_status_polarity_idx`
6. Add migration with default backfill.
7. Add schema fields to Knowledge create/update/list/search types.
8. Keep omitted values backward compatible:
   - `polarity = positive`
   - `intentTags = []`

### Checkpoint

- Existing Knowledge reads as positive with empty intent tags.
- Invalid polarity fails schema validation.
- Existing candidate registration still works unchanged.
- API list/detail exposes the new fields.
- No compile or decision behavior changes.

### Focused Tests

```bash
bunx vitest run test/schemas.test.ts test/knowledge.repository.test.ts test/api.routes.knowledge.test.ts test/register-candidate.service.test.ts
bun run typecheck
```

## Slice 2: Search And Retrieval Metadata

### Files

- `src/shared/schemas/knowledge.schema.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/modules/knowledge/knowledge.service.ts`
- `src/mcp/tools/knowledge.tool.ts`
- `api/modules/knowledge/`

### Work

1. Add search filters:

```ts
polarities?: Array<"positive" | "negative" | "neutral">;
intentTags?: string[];
```

2. Select `polarity` and `intentTags` in text retrieval.
3. Select `polarity` and `intentTags` in vector retrieval.
4. Return identical metadata from both retrieval paths.
5. Add MCP `search_knowledge` schema fields and output fields.
6. Add API list filters.
7. Do not change ranking.

### Checkpoint

- `search_knowledge` can filter only negative items.
- `search_knowledge` can filter only positive items.
- Text and vector retrieval results have matching polarity/tag fields.
- Omitting filters preserves existing behavior.

### Focused Tests

```bash
bunx vitest run test/knowledge.repository.test.ts test/knowledge.service.test.ts test/mcp.tools.test.ts test/mcp.contract.test.ts test/api.routes.knowledge.test.ts
bun run typecheck
```

## Slice 3: register_review_corrections

### Files

- `src/shared/schemas/knowledge.schema.ts`
- `src/modules/registerCandidate/register-review-corrections.service.ts`
- `src/modules/registerCandidate/register-candidate.service.ts`
- `src/mcp/tools/knowledge.tool.ts`
- MCP registry tests

### Tool Shape

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

### Work

1. Add a strict bulk schema with max item count aligned to `register_candidates`.
2. Normalize each item to a candidate body:

```text
Failure:
Impact:
Trigger:
Fix:
Verification:
Decision signal:
```

3. Default metadata:
   - `polarity = negative`
   - `intentTags = ["review_finding"]`
   - `source = mcp_register_review_corrections`
4. Reject missing `reviewFindingId`.
5. Reject empty `finding`.
6. Reject duplicate `origin.system + origin.reviewFindingId`.
7. Reuse `registerCandidate` or `registerCandidatesBulk`.
8. Return per-item success/failure.

### Checkpoint

- Accepted/fixed/deferred corrections create negative candidates.
- Duplicates return duplicate errors.
- Candidates are not active Knowledge.
- Metadata preserves review correction origin.
- MCP tool is listed and contract-tested.

### Focused Tests

```bash
bunx vitest run test/register-candidate.service.test.ts test/mcp.tools.test.ts test/mcp.contract.test.ts
bun run typecheck
```

Add `test/register-review-corrections.service.test.ts`.

## Slice 4: Negative Coverage On Existing Pipeline

### Files

- `src/modules/coverNegativeEvidence/`
- existing cover evidence / finalization integration points
- `src/modules/finalizeDistille/`
- queue or distillation metadata helpers as needed

### Work

1. Add negative coverage prompt and parser.
2. Use existing candidate / target / queue / coverage result / finalization paths.
3. Store route-specific negative data in metadata.
4. Do not add a dedicated table.
5. Output:

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

6. Finalize `ready` results to draft Knowledge only.
7. Preserve origin links and source links through finalization.

### Checkpoint

- `false_positive` creates no Knowledge.
- `not_reusable` creates no Knowledge.
- `ready` creates draft negative Knowledge.
- Existing positive cover evidence still works.
- Draft negative Knowledge can be found in the existing Knowledge list.

### Focused Tests

```bash
bunx vitest run test/cover-evidence.test.ts test/finalize-distille.test.ts test/finalize-distille-repository.test.ts
bun run typecheck
```

Add negative parser/service tests near existing cover evidence tests.

## Slice 5: Human Activation UI

### Files

- Knowledge API list/detail routes
- existing Knowledge admin/list UI files
- existing status update path

### Work

1. Add polarity and intent filters to Knowledge list.
2. Add a draft negative Knowledge filter or queue view.
3. Display review correction provenance.
4. Add activation action that uses existing draft-to-active transition rules.
5. Do not add a hidden auto-promotion path.

### Checkpoint

- Human can find draft negative Knowledge.
- Human can inspect provenance and body.
- Human can activate it using existing status transition logic.
- Active negative Knowledge remains distinguishable from positive Knowledge.

## Slice 6: context_compile Guardrails

### Files

- `src/shared/schemas/context-pack.schema.ts`
- `src/db/schema.constants.ts`
- `src/modules/context-compiler/`
- `src/modules/knowledge/knowledge.service.ts`

### Work

1. Add structured `guardrails: ContextPackItem[]`.
2. Keep `warnings: string[]`.
3. Retrieve positive Knowledge for normal rules/procedures.
4. Retrieve negative Knowledge for guardrails.
5. Add guardrails to rendering and token budgeting.
6. Persist `guardrails` as a pack section only if the existing pack item persistence requires a first-class section.

### Checkpoint

- Negative Knowledge does not appear as a positive procedure.
- Guardrails render separately.
- No-guardrail output remains backward compatible.

## Slice 7: context_decision Risk Mapping

### Files

- `src/modules/context-decision/`
- `src/shared/schemas/context-decision.schema.ts`
- decision UI/API only if needed for trace display

### Work

1. Map polarity and tags to existing evidence roles:
   - positive -> `selected_support`
   - negative guardrail/prohibition -> `risk_warning`
   - negative failure_pattern/regression -> `risk_warning`
   - preference -> `user_preference`
2. Keep verification/test_gap in coverage traces unless item-level evidence becomes necessary.
3. Add explicit conflict/risk trace.
4. Do not add new decision values.

### Checkpoint

- Negative guardrails appear as risk.
- Positive support still supports execute.
- Conflicting positive/negative evidence is visible.
- Unknown intent tags fall back safely.

## Slice 8: Feedback, Seed, Doctor

### Files

- `src/modules/knowledge/knowledge-feedback.service.ts`
- `src/modules/knowledge/knowledge-value.service.ts`
- `src/db/seed.ts`
- `src/db/seeds/knowledge-seed.json`
- Doctor service/reason files

### Work

1. Adjust feedback labels and scoring by polarity.
2. Preserve same verdict values.
3. Update seed import/export for `polarity` and `intentTags`.
4. Add Doctor warnings:
   - negative Knowledge count
   - negative Knowledge without origin links
   - unknown intent tags
   - negative Knowledge selected as positive procedure
5. Add dry-run prohibition finder only after backend behavior is stable.

### Checkpoint

- Negative `used` improves guardrail/risk value, not procedure priority.
- Negative `wrong` enters existing wrong-review path.
- Seed import/export preserves fields.
- Doctor warnings are non-blocking.

## Full Verification

Run focused tests during each slice. Before committing a completed major slice:

```bash
bun run typecheck
bun run test:unit
bun run build:web
bun run verify
```

## Start Here

Start with Slice 1 only.

Do not implement coverage, UI, compile guardrails, or decision mapping until Slice 1 and Slice 2 are green. The first two slices create the contract every later slice depends on.

