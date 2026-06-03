# DeadZone Knowledge Review UI Implementation Plan

Status: draft  
Created: 2026-06-04  
Owner: ContextStill admin / Knowledge Landscape

## Purpose

DeadZone が増加したときに、DeadZone にいる knowledge を近傍 knowledge と比較し、canonical 化、統合、Deprecated、分離維持、根拠補強のどれが妥当かを人間が判断できる画面を追加する。

この計画の主語は candidate ではなく knowledge である。Candidate Review 風の操作感は利用するが、扱う対象は `knowledge_items` と既存 Knowledge Landscape の状態であり、最初の段階では retrieval / ranking / compile の本番挙動を変更しない。

## Review Outcome

2026-06-04 の文書レビューで、次の点を実装前提として明確化した。

- 現在の DeadZone は主に community 健康指標なので、画面に出す knowledge 単位の候補集合を明示する。
- similarity は discovery 指標に限定し、write action の根拠には applicability / evidence / usage / content quality / graph health を必ず併記する。
- Phase 1 は read-only に固定し、DB migration と production ranking 変更を禁止する。
- Phase 2 は既存 `landscape_review_items` を再利用し、enum 追加なしで進める。
- Phase 3 以降の write action は audit trail と required note を必須にし、merge は自動本文変更ではなく記録済み review decision から始める。

## Current Repo Context

- Knowledge Landscape の既存 UI は `web/src/modules/admin/components/graph.page.tsx` に集約されている。
- Graph/Landscape API は `api/modules/graph/graph.routes.ts` と `api/modules/graph/graph.repository.ts` が入口になっている。
- Landscape の健康分類は `src/modules/landscape/landscape.scoring.ts` にあり、`dead_zone_reachability_risk` と `dead_zone_stale` が既に存在する。
- Review artifact は `landscape_review_items` に保存され、schema は `src/shared/schemas/landscape-review.schema.ts` と `src/db/schema-landscape.ts` にある。
- Knowledge の status 遷移は `src/modules/knowledge/knowledge-lifecycle.service.ts` で `active -> deprecated` と `deprecated -> active` が許可されている。
- Audit trail は `src/modules/audit/audit-log.service.ts` の `recordAuditLogSafe` を使う。

## Non-Goals

- 初期実装で自動 merge や自動 Deprecated を行わない。
- similarity だけで統合可否を決めない。
- `context_compile` の ranking / retrieval 挙動を初期実装で変えない。
- Candidate 生成フローの代替画面にしない。
- DeadZone を不要知識と同義にしない。孤立しているが有効な niche knowledge は残す。

## Review Indicators

UI は similarity を入口にしつつ、判断に使う指標を以下に分けて表示する。

| Indicator | Purpose | Example signal | Primary action impact |
|---|---|---|---|
| Similarity | 近傍候補を出す | cosine similarity `>= 0.9` | 比較対象の発見 |
| Applicability match | 同じ用途か判定する | `domains`, `technologies`, `changeTypes`, `appliesTo`, `Use when` | Merge / Keep separate |
| Evidence strength | 根拠の強さを見る | source link count, origin link, source URI, evidence result | Merge into stronger / Needs evidence / Deprecate |
| Usage history | 実際に使われているか見る | `compileSelectCount`, `lastCompiledAt`, replay used/not_used/churn | Canonical / Deprecate |
| Content quality | 知識として維持可能か見る | structured body, actionable workflow, verification, stale implementation names | Canonical / Needs evidence |
| Graph health | DeadZone の性質を見る | community, relation count, source density, stale ratio | Keep separate / repair reachability |

### Knowledge Candidate Set

現行 Landscape では DeadZone は community 単位で集計される。UI に並べる knowledge は、次の順で決める。

1. `buildLandscapeSnapshot()` の `communities` から `classification.primary` が `dead_zone_reachability_risk` または `dead_zone_stale` の community を抽出する。
2. 抽出した community の `representativeKnowledgeIds` を最初の候補にする。
3. Graph snapshot の community assignment が取得できる場合は、同じ `communityKey` に属する active knowledge も追加する。
4. 候補内では `compileSelectCount = 0`、`lastCompiledAt IS NULL`、source density が低いものを優先する。
5. embedding がない knowledge は similar comparison の対象からは外すが、DeadZone list には `Needs embedding` badge 付きで残す。

この定義により、community health を起点にしつつ、レビュー対象は明確に knowledge 単位になる。

### Indicator Thresholds

初期値は固定し、UI から変えられる値と内部判定値を分ける。

| Signal | Initial threshold | UI configurable | Notes |
|---|---:|---|---|
| similar knowledge | `similarity >= 0.9` | yes | discovery only |
| applicability high | overlap score `>= 0.75` | no | normalized tags and `appliesTo` keys |
| applicability medium | overlap score `>= 0.4` | no | below this is `Scope differs` |
| evidence strong | source/origin refs `>= 2` or source density `>= 1.0` | no | either side can be canonical |
| evidence thin | no source/origin refs and source density `< 0.5` | no | suggests `Needs evidence` |
| usage strong | `compileSelectCount >= 3` or recent replay used | no | suggests canonical |
| stale | no compile selection and low freshness factor | no | suggests review, not automatic deprecation |

### Review Badges

Raw 指標をそのまま大量表示するだけでなく、一覧と比較 pane では次の badge にまとめる。

- `Strong merge candidate`: similarity が高く、applicability も一致し、近傍 knowledge の根拠が強い。
- `Canonical candidate`: DeadZone 側の方が根拠、構造、利用実績のいずれかで強い。
- `Likely duplicate`: similarity と applicability が高く、差分が薄い。
- `Scope differs`: similarity は高いが、domain / technology / appliesTo が違う。
- `Evidence thin`: source / origin / evidence が薄い。
- `Stale`: 古い前提、古い実装名、または長期未使用が強い。
- `Niche but valid`: 孤立しているが適用条件と根拠が明確。

## UI Design

### Placement

新規画面名は `DeadZone Review` とする。導線は次のどちらかで実装する。

1. 初期実装: Graph page 内の Landscape tab / panel として追加する。
2. 後続整理: `app-shell.tsx` の admin nav に独立項目として追加する。

初期実装では Graph page への追加を優先する。既存 Landscape データ、review item、trajectory、contradiction panel と近い文脈で確認できるため。

### Layout

- Left: DeadZone knowledge list
  - title, type, status, primary classification, badges, community label, last compiled, source density
  - filters: reason, badge, community, status, minimum similarity, evidence strength
- Center: selected DeadZone knowledge detail
  - title/body/appliesTo/metadata
  - origin/source/evidence summary
  - usage history and replay signals
  - generated decision reasons
- Right: similar knowledge comparison
  - similarity `>= 0.9` by default
  - top K configurable, default 5
  - applicability diff
  - evidence/usage/content quality comparison
  - suggested action badge
- Footer/action rail:
  - `Merge into selected`
  - `Mark DeadZone as canonical`
  - `Deprecate DeadZone`
  - `Keep separate`
  - `Needs evidence`
  - required note field for write actions

### Interaction Rules

- Read-only comparison is available without note.
- Any state-changing action requires a note.
- Actions first create or update a review artifact; destructive or ranking-affecting changes are not applied silently.
- `Merge into selected` initially means "record merge review decision", not automatic body rewrite.
- `Deprecate DeadZone` may call the existing knowledge status transition only after a review item is in `reviewing` and the note is present.
- `Keep separate` should store why the similarity is misleading, especially applicability differences.
- If the selected similar knowledge is `deprecated`, only `Keep separate` and `Needs evidence` are enabled until the reviewer chooses a non-deprecated target.
- If the DeadZone knowledge has no embedding, merge/canonical/deprecate actions are disabled in Phase 1 and the item is marked `Needs embedding`.
- If there is no similar knowledge above threshold, the panel should still show the DeadZone item and bias toward `Needs evidence` or `repair reachability`, not hide it.

## API Plan

### Phase 1: Read-Only Diagnostics

Add a read-only endpoint:

`GET /api/graph/landscape/dead-zone-knowledge`

Query:

- `windowDays`: default 30
- `limit`: default 50, max 200
- `status`: default `active`
- `reason`: `all | dead_zone_reachability_risk | dead_zone_stale`
- `minSimilarity`: default `0.9`
- `similarTopK`: default 5, max 10
- `communityKey`: optional
- `badge`: optional

Response shape:

```ts
type DeadZoneKnowledgeReviewItem = {
  knowledge: {
    id: string;
    title: string;
    bodyPreview: string;
    type: "rule" | "procedure";
    status: "draft" | "active" | "deprecated";
    appliesTo: Record<string, unknown>;
    confidence: number;
    importance: number;
    compileSelectCount: number;
    lastCompiledAt: string | null;
    sourceRefCount: number;
    sourceRefDensity: number;
    communityKey: string | null;
    communityLabel: string | null;
  };
  classification: {
    primary: "dead_zone_reachability_risk" | "dead_zone_stale";
    confidence: "low" | "medium" | "high";
    reason: string;
  };
  indicators: {
    evidenceStrength: "none" | "thin" | "moderate" | "strong";
    usageStrength: "none" | "low" | "moderate" | "strong";
    structureQuality: "weak" | "partial" | "strong";
    graphHealth: "orphan" | "thin" | "connected";
    badges: string[];
  };
  similarKnowledge: Array<{
    id: string;
    title: string;
    status: string;
    similarity: number;
    applicabilityMatch: "low" | "medium" | "high";
    evidenceStrength: "none" | "thin" | "moderate" | "strong";
    usageStrength: "none" | "low" | "moderate" | "strong";
    suggestedAction:
      | "merge_into_similar"
      | "deadzone_is_canonical"
      | "likely_duplicate"
      | "scope_differs"
      | "needs_evidence"
      | "keep_separate";
    reasons: string[];
  }>;
  reviewItemId: string | null;
};
```

Implementation files:

- `src/shared/schemas/landscape-deadzone-review.schema.ts`
- `src/modules/landscape/landscape-deadzone-review.service.ts`
- `src/modules/landscape/landscape-deadzone-review.repository.ts`
- `api/modules/graph/graph.routes.ts`
- `web/src/modules/admin/repositories/admin.repository.ts`

Phase 1 data source:

- Use `buildLandscapeSnapshot()` to identify DeadZone communities and risk reasons.
- Use `buildGraphSnapshot({ view: "community" })` or equivalent repository query to map candidate knowledge to `communityKey`.
- Query `knowledge_items` directly for candidate details and similar knowledge.
- Query `knowledge_origin_links` and metadata source refs for evidence strength.
- Do not write `landscape_review_items` in this phase.

Route placement:

- Register `/landscape/dead-zone-knowledge` before generic or broad graph routes if new broad routes are added later.
- Keep the endpoint under `api/modules/graph/graph.routes.ts` until it becomes large enough to split into a dedicated landscape router.

Failure behavior:

- If Landscape snapshot generation fails, return a structured `503` with the reason and render an empty-state panel.
- If pgvector similarity query fails because embeddings are unavailable, return the DeadZone list with `similarKnowledge: []` and `Needs embedding` / `Similarity unavailable` badges.
- If source/origin evidence tables are unavailable in a migrated test DB, evidence strength should degrade to `none`, not fail the entire endpoint.

### Phase 2: Materialize Review Items

Extend review item materialization so DeadZone knowledge items can be explicitly queued for review.

Preferred approach:

- Reuse `landscape_review_items`.
- Use existing reasons:
  - `dead_zone_reachability_risk`
  - `dead_zone_stale`
  - `semantic_merge` when similarity/applicability suggest consolidation
- Use existing proposed actions where possible:
  - `repair_reachability`
  - `split_or_merge_review`
  - `review_only`
- Do not add new review item enum values in Phase 2. The existing values in `src/db/schema.constants.ts` are sufficient.

Add endpoint:

`POST /api/graph/landscape/dead-zone-knowledge/review-items`

Body:

```ts
type DeadZoneReviewItemsMaterializeInput = {
  dryRun: boolean;
  knowledgeIds?: string[];
  windowDays?: number;
  minSimilarity?: number;
  similarTopK?: number;
  limit?: number;
};
```

The idempotency key must include:

- deadzone knowledge id
- primary reason
- nearest similar knowledge id if present
- current threshold bundle

Payload requirements:

- `payload.deadZoneKnowledgeId`
- `payload.similarKnowledgeIds`
- `payload.indicators`
- `payload.badges`
- `payload.thresholds`
- `payload.recommendedAction`

Dry-run response must include the candidate review items that would be inserted and whether each idempotency key already exists.

### Phase 3: Review Actions

Add an explicit action endpoint:

`POST /api/graph/landscape/dead-zone-knowledge/:knowledgeId/actions`

Body:

```ts
type DeadZoneKnowledgeReviewActionInput = {
  action:
    | "merge_into_selected"
    | "mark_deadzone_canonical"
    | "deprecate_deadzone"
    | "keep_separate"
    | "needs_evidence";
  targetKnowledgeId?: string;
  reviewItemId?: string;
  note: string;
};
```

Initial write behavior:

- `merge_into_selected`: store review decision and audit event; do not rewrite bodies automatically.
- `mark_deadzone_canonical`: store decision and optionally resolve review item; do not change other knowledge automatically.
- `deprecate_deadzone`: transition knowledge status to `deprecated` only if allowed by `canTransitionKnowledgeStatus`, then audit.
- `keep_separate`: resolve or dismiss review item with note explaining applicability difference.
- `needs_evidence`: keep review item pending/reviewing and add note.

Audit events to add:

- `LANDSCAPE_DEADZONE_REVIEW_ACTION_RECORDED`
- `LANDSCAPE_DEADZONE_KNOWLEDGE_DEPRECATED`

Action validation:

- `merge_into_selected` requires `targetKnowledgeId` and target status must not be `deprecated`.
- `mark_deadzone_canonical` must not mutate the target knowledge. If a similar item should later be deprecated, that is a separate review action.
- `deprecate_deadzone` requires either `reviewItemId` or a newly created review item in the same transaction.
- `keep_separate` should resolve/dismiss the review item only when the note states the scope difference.
- `needs_evidence` must leave the review item open unless the reviewer explicitly dismisses it later.

## DB Plan

Phase 1 should not require a migration.

Phase 2 can reuse `landscape_review_items` and store comparison details in `payload`.

Phase 3 has two options:

1. Minimal: store decisions in `landscape_review_items.note` and `payload.reviewDecision`.
2. Durable: add `landscape_knowledge_review_actions`.

Recommended durable table for Phase 3:

```sql
create table landscape_knowledge_review_actions (
  id uuid primary key default gen_random_uuid(),
  review_item_id uuid references landscape_review_items(id) on delete set null,
  knowledge_id uuid not null references knowledge_items(id) on delete cascade,
  target_knowledge_id uuid references knowledge_items(id) on delete set null,
  action text not null,
  note text not null,
  indicators jsonb not null default '{}',
  actor text not null default 'user',
  created_at timestamp not null default now()
);
```

Do not add this table in Phase 1 or Phase 2. Add it only when write actions are implemented. If Phase 3 starts without this table, the implementation must explicitly choose the minimal storage option and document why it is acceptable.

## Scoring Helpers

Implement small deterministic helpers before UI rendering:

- `scoreApplicabilityMatch(a, b)`
  - compares normalized `domains`, `technologies`, `changeTypes`, repo fields, and simple `appliesTo` keys.
- `scoreEvidenceStrength(knowledgeId)`
  - combines source/origin links, evidence references, and sourceRefDensity.
- `scoreUsageStrength(knowledge)`
  - uses `compileSelectCount`, `lastCompiledAt`, replay feedback where available.
- `scoreStructureQuality(knowledge)`
  - checks procedure sections, body specificity, and stale markers.
- `deriveDeadZoneReviewBadges(item, similarItems)`
  - maps raw indicators to the badge vocabulary.

Keep these deterministic. Do not call an LLM to decide review actions.

Suggested file placement:

- Put pure scoring helpers in `src/modules/landscape/landscape-deadzone-review.scoring.ts`.
- Keep DB access in `landscape-deadzone-review.repository.ts`.
- Keep orchestration and schema mapping in `landscape-deadzone-review.service.ts`.
- Export shared zod schemas from `src/shared/schemas/landscape-deadzone-review.schema.ts`.

## Frontend Implementation Plan

### Components

- `deadzone-review.page.tsx` or `deadzone-review-panel.tsx`
- `deadzone-review-list.tsx`
- `deadzone-knowledge-detail.tsx`
- `deadzone-similar-knowledge-panel.tsx`
- `deadzone-review-action-bar.tsx`

If added inside Graph page first, start with `deadzone-review-panel.tsx` and import it from `graph.page.tsx`.

### UI Constraints

- Use compact operational layout, not a marketing/card-heavy page.
- Avoid nested cards. Use full-width panels, table/list rows, and a detail split.
- Badges should explain why an item is risky or safe to keep.
- Long knowledge titles/body previews must wrap without overflowing.
- Action buttons should be disabled until required target/note is present.

## Test Plan

### Unit Tests

- `test/landscape-deadzone-review.service.test.ts`
  - DeadZone knowledge is selected from `dead_zone_reachability_risk` / `dead_zone_stale`.
  - Community-level DeadZone classification maps to knowledge-level list items.
  - Similar knowledge below threshold is excluded.
  - Applicability mismatch produces `Scope differs`.
  - Strong target evidence produces `Strong merge candidate`.
  - DeadZone item with stronger evidence becomes `Canonical candidate`.
  - Missing embedding keeps the knowledge in the list but returns no similarity comparison.
  - Deprecated similar knowledge does not produce merge/canonical actions.

- `test/landscape-deadzone-review-actions.test.ts`
  - State-changing actions require note.
  - Deprecated transition uses `canTransitionKnowledgeStatus`.
  - Merge action records decision without rewriting knowledge body.
  - Audit log safe path is called.

### API Tests

- Add route coverage in `test/graph.routes.test.ts` or a dedicated `test/graph.routes.deadzone-review.test.ts`.
- Validate query parsing defaults.
- Validate dry-run materialization does not insert.
- Validate idempotent materialization does not duplicate review items.

### Component Tests

- Add test under `test/components/admin/`.
- Verify list, detail, similar panel, badge rendering, and disabled/enabled action states.

### E2E

- Extend `e2e/admin-ui.spec.ts` only after Phase 1 UI is stable.
- Verify the page opens, filters render, a row can be selected, and no text overlaps in desktop viewport.

### Acceptance Gate

Run targeted tests first:

```bash
bun test test/landscape-deadzone-review.service.test.ts
bun test test/graph.routes.deadzone-review.test.ts
bun test test/components/admin/deadzone-review-panel.test.tsx
```

Then run the repo gate:

```bash
bun run verify
```

Failure handling:

- If targeted service tests fail, do not proceed to UI work.
- If route tests fail because the endpoint contract is too broad, reduce Phase 1 response shape rather than weakening validation.
- If component tests show overflow or text overlap, adjust layout constraints before adding write actions.
- If `bun run verify` fails on unrelated pre-existing changes, record the failing command and isolate whether the DeadZone files introduced any failures before continuing.

## Rollout Plan

### Milestone 1: Read-Only Review Surface

- Add schema, repository, service, API endpoint.
- Add admin repository fetch function.
- Add Graph page panel with list/detail/similar comparison.
- Include knowledge-level derivation from DeadZone communities.
- Include missing-embedding and no-similar-results empty states.
- No DB migration.
- No write action.

Exit criteria:

- DeadZone knowledge can be listed with similar knowledge `>= 0.9`.
- Badges are deterministic and visible.
- Community-level DeadZone counts can be reconciled with visible knowledge-level rows.
- No production knowledge status or ranking changes.

### Milestone 2: Review Item Materialization

- Add materialization endpoint.
- Reuse `landscape_review_items`.
- Store comparison payload and evidence strings.
- Add dry-run mode and idempotency.
- Use existing reason/proposedAction enum values only.

Exit criteria:

- Operator can create review items for selected DeadZone knowledge.
- Dry-run shows what would be inserted.
- Duplicate materialization is idempotent.

### Milestone 3: Approval-Gated Actions

- Add action endpoint.
- Add required note and audit log.
- Support `keep_separate`, `needs_evidence`, `deprecate_deadzone`.
- Keep merge/canonical actions as recorded decisions unless a separate merge editor is implemented.
- Add `landscape_knowledge_review_actions` or explicitly document the minimal storage choice.

Exit criteria:

- No silent merge.
- Deprecated action uses existing lifecycle transition.
- Every action leaves review/audit evidence.

### Milestone 4: Merge Editor

- Add explicit merge preview.
- Show source body, target body, proposed merged body, and diff.
- Require confirmation before changing any knowledge body.
- Keep previous body in audit payload.

Exit criteria:

- Body rewrite is explicit, reversible from audit evidence, and covered by tests.

## Open Questions

- Should `DeadZone Review` be a Graph page tab or a separate admin nav item after Phase 1?
- Should merge decisions eventually create a new canonical knowledge item, or update one existing item?
- Should `keep_separate` add a durable relation explaining why two similar items are intentionally separate?
- What retention policy should apply to old review actions after the knowledge landscape changes?
- Should missing embeddings be repaired from this screen, or only surfaced as a separate maintenance task?
- Should review actions be user-only, or can agent-triggered actions be allowed after the UI contract is stable?

## Initial Recommendation

Implement Milestone 1 first. Add Milestone 2 only after the knowledge-level candidate set reconciles with the community-level DeadZone counts and the read-only UI proves useful. The first useful outcome is not mutation; it is making the current DeadZone knowledge reviewable with enough evidence to decide the next action safely.
