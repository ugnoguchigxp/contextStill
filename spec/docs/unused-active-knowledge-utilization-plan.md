# Unused Active Knowledge Utilization Plan

## Goal

Increase useful selection of active Knowledge that currently has no compile usage, without lowering `context_compile` quality.

The target is not to force unused Knowledge into packs. The target is to separate valuable-but-unreached Knowledge from stale, weak, duplicate, or mis-scoped Knowledge, then feed measured outcomes back into ranking and lifecycle decisions.

## Current Baseline

Current system signals already exist:

- `knowledge_items.compileSelectCount` identifies never-selected active Knowledge.
- `knowledge_items.importance` and `knowledge_items.confidence` provide initial quality signals.
- `knowledge_items.dynamicScore` reflects selection, recent use, explicit feedback, and usage feedback.
- `knowledge_usage_events` records `used`, `not_used`, `off_topic`, and `wrong`.
- `displayFilter=unused-active` lists active Knowledge with `compileSelectCount = 0`.
- Landscape already models `over_selected_not_used`, `dead_zone_reachability_risk`, and `dead_zone_stale`.
- `LANDSCAPE_COMPILE_INTERVENTION=diversity_exploration` can insert one vector-and-facet matched candidate from beyond the normal ranking window.

## Non-Goals

- Do not boost all unused active Knowledge.
- Do not replace normal ranking with exploration ranking.
- Do not automatically rewrite `appliesTo` without review.
- Do not treat `importance` and `confidence` as the full quality definition.
- Do not optimize for reducing unused count if pack usefulness gets worse.

## Quality Model

`importance` and `confidence` are initial quality signals, not the whole score.

Use this model for exploration candidates:

```text
candidateQuality =
  0.25 * importance
+ 0.20 * confidence
+ 0.20 * evidenceStrength
+ 0.15 * reachability
+ 0.10 * freshness
+ 0.10 * uniqueness
```

Definitions:

- `importance`: potential impact if the Knowledge is correct and applicable.
- `confidence`: trust in the Knowledge extraction or classification.
- `evidenceStrength`: source refs, origin refs, run evidence, or agent diff evidence.
- `reachability`: vector match plus facet match against the current task.
- `freshness`: decay based on `lastVerifiedAt` or `updatedAt`.
- `uniqueness`: not clearly duplicate, superseded, or a merge/deprecate candidate.

For production ordering, continue to rely on `dynamicScore` and feedback-driven ranking. `candidateQuality` is an exploration gate and trace field.

## Phase 1: Exploration Slot Instrumentation

### Objective

Turn the existing diversity exploration intervention into a measurable unused-Knowledge experiment.

### Backend Changes

Update `src/modules/landscape/landscape-compile-intervention.service.ts`:

- Keep the runtime flag opt-in through `LANDSCAPE_COMPILE_INTERVENTION`.
- Prefer candidates that are:
  - `status = active`
  - `compileSelectCount = 0`
  - vector matched
  - facet matched
  - above the minimum `candidateQuality`
- Return diagnostics with:
  - `candidateKnowledgeId`
  - `candidateQuality`
  - `wasUnusedActive`
  - `originalRank`
  - `replacedKnowledgeId`
  - `reason`

Update `src/modules/context-compiler/context-compiler.service.ts`:

- Persist exploration diagnostics in the compile run snapshot or candidate trace evidence.
- Mark exploration-inserted pack items with trace metadata.
- Keep the intervention to at most one inserted item per compile run.

### Tests

- Exploration is disabled by default.
- Exploration inserts at most one item.
- Exploration prefers unused active candidates over already-used candidates when both are eligible.
- Exploration does not insert low-quality or facet-mismatched candidates.
- Diagnostics include original rank and reason.

## Phase 2: Unused Active Classification

### Objective

Classify unused active Knowledge so the system can choose the right action: explore, rescope, merge, deprecate, or ignore.

### Classifications

| Classification | Meaning | Primary Action |
|---|---|---|
| `high_quality_unreached` | Quality and evidence are good, but normal ranking never selects it | Explore |
| `scope_mismatch` | Content is useful, but `appliesTo` appears too broad, too narrow, or wrong | Suggest `appliesTo` update |
| `duplicate_or_deadzone` | Similar canonical Knowledge exists or Landscape marks it as weak/dead-zone | Merge or deprecate |
| `low_evidence` | Importance/confidence may be high, but source support is thin | Re-evidence or demote |
| `stale_or_obsolete` | Decay or domain drift suggests outdated content | Reverify or deprecate |

### Backend Changes

Add a classifier service under `src/modules/knowledge/` or `src/modules/landscape/` that can evaluate a Knowledge item from existing signals:

- lifecycle status
- compile select count
- dynamic score
- importance/confidence
- source refs / origin refs
- embedding availability
- vector/facet reachability from replay or candidate traces
- Landscape community classification
- freshness decay

Expose the classification through Knowledge API list/detail responses only after the classifier is deterministic and covered by tests.

### UI Changes

Add classification badges to the existing unused-active Knowledge view. Keep the first UI slice read-only.

Recommended filters:

- High-quality unreached
- Scope mismatch
- Duplicate/dead-zone
- Low evidence
- Stale

### Tests

- Never-selected high-quality item with evidence becomes `high_quality_unreached`.
- Thin evidence item becomes `low_evidence` even if importance is high.
- Landscape dead-zone signal takes precedence over exploration.
- Stale procedure becomes `stale_or_obsolete`.

## Phase 3: High-Quality Unused Boost

### Objective

Use `candidateQuality` as an exploration gate, not as a direct production ranking replacement.

### Rules

A Knowledge item is eligible for exploration boost when:

- `status = active`
- `compileSelectCount = 0`
- `candidateQuality >= threshold`
- vector match is true
- facet match is true
- evidence is present
- classification is `high_quality_unreached` or `scope_mismatch`
- classification is not `duplicate_or_deadzone`, `low_evidence`, or `stale_or_obsolete`

### Configuration

Add settings with conservative defaults:

```text
LANDSCAPE_COMPILE_INTERVENTION=off
UNUSED_KNOWLEDGE_EXPLORATION_LIMIT=1
UNUSED_KNOWLEDGE_EXPLORATION_MIN_QUALITY=60
```

If project config already has a preferred settings mechanism, use that instead of new env-only settings.

### Feedback Loop

When an exploration item is selected:

- Existing compile selection tracking increments normal selection counters.
- Existing usage feedback should record `used`, `not_used`, `off_topic`, or `wrong`.
- `dynamicScore` recalculation remains the production learning path.
- Exploration-specific metadata allows later reporting on first-use and off-topic rates.

### Tests

- `used` exploration items improve through existing `dynamicScore` path.
- `not_used` and `off_topic` exploration items do not keep getting explored indefinitely.
- Quality threshold blocks weak items.
- Exploration metadata survives compile run persistence.

## Phase 4: AppliesTo Suggestion Workflow

### Objective

Fix Knowledge that is useful but unreachable because `appliesTo` is wrong.

### Suggestion Inputs

Use compile traces and replay comparisons to infer suggested `appliesTo`:

- task `repoKey`
- task `repoPath`
- retrieval mode
- requested technologies
- requested change types
- requested domains
- vector/facet matches where the item was outside the final selection window
- baseline used feedback where current retrieval lost the item

### Backend Changes

Add suggestion records or a read-only suggestion endpoint before allowing mutation.

Suggested record shape:

```ts
type AppliesToSuggestion = {
  knowledgeId: string;
  reason: "scope_mismatch" | "used_baseline_lost" | "semantic_reachable_dead_zone";
  confidence: "low" | "medium" | "high";
  currentAppliesTo: Record<string, unknown>;
  suggestedAppliesTo: Record<string, unknown>;
  evidence: string[];
  runIds: string[];
};
```

### UI Changes

Add a review action from the unused-active or Landscape view:

- show current `appliesTo`
- show suggested `appliesTo`
- show evidence
- allow apply, dismiss, or edit-before-apply

Do not auto-apply suggestions in the first version.

### Tests

- Suggestion preserves existing compatible `appliesTo` fields.
- Suggestion never drops repo scoping unless explicitly recommended.
- Applying a suggestion validates through existing Knowledge update schema.
- Dismissed suggestions do not reappear for the same evidence key.

## Metrics

Track these metrics before and after rollout:

```text
unusedActiveCount
highQualityUnreachedCount
explorationInsertedCount
explorationFirstUseCount
explorationUsedRate
explorationNotUsedRate
explorationOffTopicRate
explorationWrongRate
appliesToSuggestionCount
appliesToSuggestionAppliedCount
appliesToSuggestionDismissedCount
unusedActiveDeprecatedCount
```

Primary success metric:

```text
explorationUsedRate improves without increasing off_topic rate above baseline.
```

Secondary success metrics:

- high-quality unreached count decreases.
- unused active count decreases through exploration, rescoping, merge, or deprecation.
- average compile evaluation score does not regress.
- no increase in `No Content` or degraded compile rates.

## Rollout Plan

1. Implement Phase 1 diagnostics with exploration still disabled by default.
2. Add unit tests for exploration selection and diagnostics.
3. Enable exploration locally with one slot and collect traces.
4. Implement read-only unused-active classification.
5. Add high-quality exploration gate.
6. Add appliesTo suggestions as read-only output.
7. Add review/apply UI after suggestion quality is verified.

## Verification Commands

Run:

```bash
bun run typecheck
bun run test:unit
bun run build:web
bun run verify
```

Focused tests should cover:

- landscape compile intervention
- knowledge value scoring
- knowledge feedback dynamic score recalculation
- knowledge list `unused-active` filtering
- Landscape dead-zone classification
- appliesTo suggestion validation

## Open Questions

- Should exploration settings live in env only, runtime settings, or both?
- Should candidate quality be persisted as a first-class column or only stored in trace evidence?
- Should `high_quality_unreached` live in Knowledge API, Landscape API, or both?
- What is the minimum sample size before enabling exploration by default for a project?
