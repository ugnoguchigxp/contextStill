# DeadZone Knowledge Review Queue Design

Status: draft  
Created: 2026-06-04  
Reviewed: 2026-06-05  
Owner: ContextStill admin / Knowledge Landscape

## Purpose

DeadZone が増加したときに、到達されにくい knowledge を安全に整理するための admin UI を設計する。

この画面の主語は similarity ではない。主語は DeadZone knowledge の処遇決定である。Similarity は近傍候補を発見するための signal に限定し、merge / deprecated / keep / evidence 補強の最終判断は scope、evidence、usage、graph health、replay stability を合わせて行う。

## Decision

Landscape page に `DeadZone Review Queue` を置く。Graph canvas 上では扱わない。

UI は merge tool ではなく decision queue として設計する。

- 1 row = 1 DeadZone knowledge item.
- Similar knowledge は操作対象の一覧ではなく、判断材料として表示する。
- Primary action は recommendation に沿った明示ボタンにする。
- `Merge similar into DeadZone` のような左右矢印操作は通常 action から外す。
- State-changing action は実行中の状態、完了結果、失敗理由を画面上に必ず残す。

## Current Implementation Gap

The current Landscape page already lists DeadZone knowledge and can call a maintenance endpoint. The risky parts are:

- action buttons are still directional merge controls
- the action model contains `merge_similar_into_deadzone`
- the UI presents similar knowledge as direct action targets instead of evidence
- non-destructive outcomes such as `keep_separate` and `needs_evidence` are not durable decisions
- API response does not yet expose row-level `recommendation`, `allowedActions`, or `blockers`

The next implementation should not add more merge behavior on top of this model. It should first replace the action vocabulary and UI affordances.

## Why This Is Safer

DeadZone knowledge は不要 knowledge と同義ではない。次のような状態が混在する。

| State | Meaning | Safe decision |
|---|---|---|
| Duplicate of reachable canonical | 既存の reachable knowledge と重複している | Merge DeadZone into canonical |
| Weak and unused | 根拠が薄く、使われていない | Deprecate DeadZone |
| Scope differs | Semantic は近いが用途が違う | Keep separate |
| DeadZone is better | DeadZone 側の方が正確または一般化されている | Promote / strengthen DeadZone |
| Insufficient evidence | 判断材料が足りない | Needs evidence |

左右矢印でどちらかへ merge する UI は、この違いを隠す。特に `similar -> DeadZone` は、reachable な知識を deprecated にして、到達不能な knowledge を残す可能性がある。これは DeadZone maintenance の目的と逆になる。

## Non-Goals

- Similarity だけで merge / deprecated を決めない。
- Graph canvas に DeadZone maintenance 操作を戻さない。
- 初期改善で bulk destructive action を追加しない。
- `context_compile` ranking / retrieval の本番挙動をこの UI から直接変更しない。
- Candidate review の代替画面にしない。

## Review Signals

UI と API は similarity 以外の判断材料を明示する。

| Signal | Purpose | Example | Decision impact |
|---|---|---|---|
| Semantic similarity | 近傍候補の発見 | cosine similarity `>= 0.9` | discovery only |
| Scope compatibility | 同じ用途か判定 | `domains`, `technologies`, `changeTypes`, `appliesTo` overlap | merge / keep separate |
| Evidence strength | 根拠の強さ | source links, origin links, evidence density | canonical selection / needs evidence |
| Usage history | 実際に使われているか | `compileSelectCount`, `lastCompiledAt`, replay usage | canonical / deprecated |
| Graph health | DeadZone の性質 | orphan, thin, connected, community label | repair / review priority |
| Replay impact | 実運用への影響 | used lost, churn, retained | risk ranking |
| Staleness | 古い前提か | no recent compile, old source, stale body markers | review priority |
| Contradiction risk | 似ているが逆のことを言っていないか | polarity conflict, deprecated reuse | blocks merge |

## Recommendation Model

API は row ごとに deterministic recommendation を返す。LLM には判断させない。

```ts
type DeadZoneRecommendationAction =
  | "merge_deadzone_into_canonical"
  | "deprecate_deadzone"
  | "keep_separate"
  | "promote_deadzone"
  | "needs_evidence";

type DeadZoneReviewRecommendation = {
  action: DeadZoneRecommendationAction;
  confidence: "low" | "medium" | "high";
  reasons: string[];
  blockers: string[];
};
```

Recommendation の基本ルール:

- `merge_deadzone_into_canonical`
  - similarity high
  - scope medium/high
  - target evidence or usage is stronger
  - no contradiction blocker
- `deprecate_deadzone`
  - evidence none/thin
  - usage none
  - stale or duplicate
  - no signal that DeadZone is canonical
- `keep_separate`
  - semantic similarity high but scope low
  - technologies/domains differ
  - both items have valid but different applicability
- `promote_deadzone`
  - DeadZone evidence/usage/content quality is stronger than similar candidate
  - DeadZone body is specific enough to become reachable canonical
  - this is not a command to deprecate the similar item
- `needs_evidence`
  - no reliable canonical target
  - missing source/origin evidence
  - missing embedding or contradictory signals

## API Contract

Existing endpoint remains the list source:

`GET /api/graph/landscape/dead-zone-knowledge`

Query:

- `windowDays`: default 30
- `limit`: default 50, max 200
- `page`: default 1
- `status`: default `active`
- `reason`: `all | dead_zone_reachability_risk | dead_zone_stale`
- `minSimilarity`: default `0.9`
- `similarTopK`: default 5, max 10
- `badge`: optional
- `sortBy`: `deadZoneScore | compileSelectCount | title | similarity | evidence | usage`
- `sortDir`: `asc | desc`

Response should evolve toward this shape:

```ts
type DeadZoneKnowledgeReviewItem = {
  knowledge: DeadZoneKnowledgeSummary;
  classification: {
    primary: "dead_zone_reachability_risk" | "dead_zone_stale";
    confidence: "low" | "medium" | "high";
    reason: string;
  };
  indicators: {
    deadZoneScore: number;
    evidenceStrength: "none" | "thin" | "moderate" | "strong";
    usageStrength: "none" | "low" | "moderate" | "strong";
    structureQuality: "weak" | "partial" | "strong";
    graphHealth: "orphan" | "thin" | "connected";
    badges: string[];
  };
  bestCanonicalCandidate: DeadZoneSimilarKnowledge | null;
  alternativeCandidates: DeadZoneSimilarKnowledge[];
  recommendation: DeadZoneReviewRecommendation;
  allowedActions: DeadZoneRecommendationAction[];
  reviewItemId: string | null;
};
```

Compatibility note:

- Current implementation may still return `similarKnowledge`.
- UI can derive `bestCanonicalCandidate` from the first recommended similar item during the transition.
- Once API returns `recommendation`, UI should stop deriving destructive action labels from `similarKnowledge.suggestedAction`.

## Action Contract

State-changing endpoint should expose decision actions, not directional arrows.

`POST /api/graph/landscape/dead-zone-knowledge/actions`

```ts
type DeadZoneKnowledgeReviewActionInput = {
  action:
    | "merge_deadzone_into_canonical"
    | "deprecate_deadzone"
    | "keep_separate"
    | "promote_deadzone"
    | "needs_evidence";
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId?: string;
  reviewItemId?: string;
  note?: string;
};
```

Action semantics:

- `merge_deadzone_into_canonical`
  - requires `canonicalKnowledgeId`
  - canonical target must be active and non-deprecated
  - appends or previews merge content only through an explicit merge path
  - deprecates the DeadZone item only after the decision is recorded
- `deprecate_deadzone`
  - only changes the DeadZone item status
  - uses existing lifecycle transition validation
- `keep_separate`
  - records why semantic similarity is misleading
  - does not mutate knowledge status
- `promote_deadzone`
  - records that DeadZone should be strengthened
  - does not deprecate similar knowledge automatically
  - should lead to edit/evidence/reachability repair flow
- `needs_evidence`
  - records that evidence is missing
  - does not mutate knowledge status

Every action must return a visible result:

```ts
type DeadZoneKnowledgeReviewActionResult = {
  action: DeadZoneRecommendationAction;
  status: "recorded" | "applied";
  message: string;
  keptKnowledgeId?: string;
  deprecatedKnowledgeId?: string;
  reviewItemId?: string;
};
```

### Transition from Current Maintenance Endpoint

Current endpoint:

`POST /api/graph/landscape/dead-zone-knowledge/maintenance`

Current actions:

- `merge_deadzone_into_similar`
- `merge_similar_into_deadzone`
- `deprecate_deadzone`
- `deprecate_similar`

Transition plan:

| Current action | Replacement | Notes |
|---|---|---|
| `merge_deadzone_into_similar` | `merge_deadzone_into_canonical` | Rename target from similar to canonical and require recommendation evidence |
| `merge_similar_into_deadzone` | `promote_deadzone` | Do not deprecate the similar item automatically |
| `deprecate_deadzone` | `deprecate_deadzone` | Keep, but require recommendation or reviewer note |
| `deprecate_similar` | remove from this screen | Similar item deprecation should be a separate Knowledge review action |

The old endpoint can remain temporarily as a compatibility layer, but the UI should stop calling directional actions before new write paths are expanded.

## UI Design

### Page

Admin nav:

```txt
Knowledge
Landscape
Graph
```

`Landscape` contains the DeadZone Review Queue. It does not render the graph canvas.

### Table Columns

| Column | Contents |
|---|---|
| Score | `deadZoneScore`, primary reason badge |
| Knowledge | title, preview, community, selected count |
| Signals | evidence, usage, graph, stale, scope badges |
| Best Candidate | canonical candidate summary, similarity, scope, evidence/usage comparison |
| Recommendation | action, confidence, reasons, blockers |
| Decision | action buttons |

### Expanded Row / Drawer

Rows should be expandable for detail review.

Detail sections:

- DeadZone knowledge body and appliesTo
- evidence/source summary
- usage/replay summary
- best canonical candidate comparison
- alternative candidates
- recommendation reasons
- blockers
- optional note

### Buttons

Use text + icon buttons. Avoid icon-only directional merge controls.

Primary button depends on recommendation:

- `Merge into canonical`
- `Deprecate DeadZone`
- `Keep separate`
- `Promote DeadZone`
- `Needs evidence`

Secondary buttons:

- `Keep separate`
- `Needs evidence`
- `Deprecate DeadZone` only when allowed

Dangerous actions must not be hidden behind arrows.

### Pending and Result Feedback

When an action starts:

- show action-specific text:
  - `Merging knowledge...`
  - `Deprecating knowledge...`
  - `Recording review decision...`
- disable filters, sort, pagination, refresh, and all row actions
- keep the row visible until the request resolves

When action succeeds:

- show a durable inline result, for example:
  - `Merged DeadZone "A" into canonical "B" and deprecated "A".`
  - `Recorded Keep separate for "A".`
  - `Marked "A" as Needs evidence.`
- invalidate Landscape, Knowledge, and Graph queries

When action fails:

- show the API error near the table header
- do not clear the row
- leave controls enabled after failure

## Safety Rules

- No action may be enabled solely because similarity is high.
- `merge_deadzone_into_canonical` requires a canonical target with stronger evidence, usage, or graph reachability unless reviewer overrides with note.
- `promote_deadzone` must not deprecate the similar item.
- `keep_separate` and `needs_evidence` are first-class outcomes, not no-op fallbacks.
- Missing embedding disables merge recommendation and biases toward `needs_evidence`.
- Deprecated similar knowledge cannot be canonical target.
- Contradiction blocker disables merge until explicitly reviewed.
- Bulk action is disabled until single-action audit behavior is stable.

## Data and Persistence

Use `landscape_review_items` for durable review workflow before adding a new table.

Recommended payload fields:

```ts
type DeadZoneReviewPayload = {
  deadZoneKnowledgeId: string;
  bestCanonicalCandidateId?: string;
  alternativeCandidateIds: string[];
  indicators: Record<string, unknown>;
  recommendation: DeadZoneReviewRecommendation;
  thresholds: {
    minSimilarity: number;
    windowDays: number;
  };
  decision?: {
    action: DeadZoneRecommendationAction;
    note?: string;
    decidedAt: string;
  };
};
```

If direct knowledge mutation remains available, it must also write audit evidence with:

- action
- deadZoneKnowledgeId
- target/canonical knowledge id
- previous status
- next status
- reviewer note or generated rationale
- indicators at decision time

## Implementation Plan

### Milestone 1: Convert Current UI to Decision Queue

- Remove left/right merge semantics.
- Replace similar group action buttons with decision buttons.
- Remove `deprecate_similar` from the Landscape row actions.
- Display `Best Candidate` and `Recommendation`.
- Keep `Keep separate` and `Needs evidence` visible.
- Show pending state and action result text.
- Keep API-backed sorting and Knowledge-style pagination.

Exit criteria:

- User can understand what will happen before clicking.
- Left/right arrow ambiguity is gone.
- A successful action visibly changes page state or records a visible decision result.

### Milestone 2: Add Recommendation to API

- Add deterministic `recommendation` and `allowedActions`.
- Add `bestCanonicalCandidate`.
- Preserve `similarKnowledge` temporarily for compatibility.
- Add service tests for each recommendation outcome.
- Add blockers for missing embedding, deprecated candidate, low scope overlap, and contradiction risk.

Exit criteria:

- UI no longer infers action meaning from button position.
- Similarity is used as discovery signal only.

### Milestone 3: Review Item Decisions

- Persist `keep_separate`, `needs_evidence`, and `promote_deadzone` as review decisions.
- Prevent already-decided items from reappearing unless landscape signals change materially.
- Add note support where required.
- Add idempotency key based on deadZoneKnowledgeId, recommendation action, best candidate id, and threshold bundle.

Exit criteria:

- Non-destructive decisions are durable.
- Queue size can shrink without mutating knowledge status.

### Milestone 4: Explicit Merge Preview

- Add merge preview drawer.
- Show DeadZone body, canonical body, proposed merged body, and diff.
- Require explicit confirmation.
- Store previous body and decision payload in audit evidence.

Exit criteria:

- Body rewrite is explicit and reviewable.
- Merge is reversible from audit evidence.

## Test Plan

### Service Tests

- High similarity + high scope + stronger target evidence recommends `merge_deadzone_into_canonical`.
- Low evidence + no usage recommends `deprecate_deadzone`.
- High similarity + low scope recommends `keep_separate`.
- Strong DeadZone evidence recommends `promote_deadzone`.
- Missing embedding recommends or allows only `needs_evidence` / `keep_separate`.
- Deprecated similar item is never canonical target.
- Contradiction blocker disables merge recommendation.

### Route Tests

- Query defaults include page, sort, threshold, and status.
- Action endpoint rejects missing canonical target for merge.
- Action endpoint rejects deprecated canonical target.
- Action endpoint returns visible message.

### Component Tests

- Table renders recommendation and best candidate.
- Directional arrow buttons are absent.
- Pending action disables filters, sort, pagination, refresh, and row actions.
- Success result is visible after action.
- `Keep separate` and `Needs evidence` are visible outcomes.

### Verification

Run targeted tests first:

```bash
bunx vitest run test/landscape-deadzone-review.service.test.ts test/graph.routes.test.ts test/components/admin/landscape-page.test.tsx
```

Then run:

```bash
bun run verify
```

## Documentation Review Notes

2026-06-05 review changes:

- Reframed the feature from merge UI to decision queue.
- Removed Graph page placement as the recommended path because Graph rendering capacity is not suitable for this workflow.
- Removed `Merge similar into DeadZone` as a normal action.
- Added recommendation model, allowed actions, blockers, and action result feedback.
- Promoted `keep_separate` and `needs_evidence` to first-class outcomes.
- Added milestone order that starts by removing ambiguous UI before adding stronger mutations.

## Open Questions

- Should `keep_separate` create a durable relation explaining intentional separation?
- What threshold change should make an already-reviewed item reappear?
- Should `needs_evidence` create a source/evidence repair task, or only mark the review item?
- Should `promote_deadzone` open the Knowledge edit drawer immediately?
- Should merge require a note even when recommendation confidence is high?

## Recommendation

Implement Milestone 1 first. The first useful correction is not a smarter merge. It is replacing ambiguous directional controls with an explicit decision queue where similarity is only one signal among several.
