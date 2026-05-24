# Knowledge Landscape Action Queue 永続化 実装計画

> Status: ready to implement
> Date: 2026-05-24 JST
> Last reviewed: 2026-05-24 JST
> Based on:
> - `docs/knowledge-landscape-concept-design.md`
> - `docs/knowledge-landscape-attractor-implementation-plan.md`
> - `docs/knowledge-landscape-attractor-phase2-replay-basin-plan.md`

## 0. ドキュメントレビュー結果

初稿の実装可能性は **8.2 / 10**。方向性は正しいが、実装開始直後に迷いが出る箇所が残っていた。

主な不足:

- DB migration SQL の具体性が弱く、`schema.ts` と migration の対応が実装者依存だった
- `source` enum に AQ-1 で使わない `replay_basin` が含まれていた
- materialize の conflict handling と list ordering が曖昧だった
- UI/API/CLI を一気に実装する計画で、最小の縦切りが見えにくかった
- candidate payload の肥大化、idempotency key の安定化、dry-run の差分表示が弱かった

この版では、上記を補い **9.0 / 10 水準**を目標にする。残り 1 点は、実装時に既存 DB の実データ量と UI 表示負荷を測らないと確定できない領域である。

評価基準:

| 観点 | 目標 |
|---|---|
| 実装可能性 | ファイル、関数、migration、route、test がそのまま作業単位になる |
| 安全性 | production ranking / knowledge 本体 / 既存 wrong queue を変えない |
| 冪等性 | 同じ analysis を繰り返しても duplicate を作らない |
| 段階性 | replay compare 起点の縦切りから始め、snapshot / semantic / gate へ広げられる |
| 検証性 | dry-run、write、list、status update をそれぞれ test できる |

## 1. 目的

Knowledge Landscape は、Snapshot / Replay / Replay Compare / Graph UI まで実装済みである。ただし現状の `Action Queue` は `GET /api/graph/landscape/replay/compare` の一時的な `appliesToRefineCandidates` 表示であり、レビュー対象として残らない。

この計画の目的は、Attractor / Negative Candidate / Dead Zone / Replay drift の診断結果を **永続化された人間レビュー可能な Action Queue** に接続することである。

達成後の状態:

```txt
Landscape analysis
  -> replay compare / basin analysis / semantic comparison
  -> idempotent action item materialization
  -> Admin UI / CLI / API で review
  -> 手動で resolve / dismiss
```

この段階では、knowledge 本体、`appliesTo`、ranking、promotion gate を自動変更しない。

## 2. 設計判断

### 2.1 既存 `knowledge_review_queue` は直接拡張しない

既存の `knowledge_review_queue` は、`wrong` verdict 起点のレビューキューとして設計されている。

現在の制約:

- `knowledge_id` が必須
- `trigger_event_id` が必須
- `trigger_event_id` に unique index がある
- `trigger_verdict` は `knowledge_usage_events.verdict` 前提
- `proposed_action` は `review_only | demote_to_draft_candidate`

Landscape Action Queue では次のような item も扱う必要がある。

- `used_baseline_lost`: usage event はあるが、目的は wrong review ではなく reachability / appliesTo refinement
- `baseline_missing_after_recompile`: usage event がない場合がある
- `dead_zone_reachability_risk`: community 単位で、特定 run/event に紐づかない
- `semantic_split` / `semantic_merge`: community 比較単位で、knowledge item が複数または未確定
- `promotion_gate_review`: run / basin 単位で、knowledge item に限定できない

そのため Phase AQ-1 では、既存 table を壊さず、専用の `landscape_review_items` table を追加する。既存 `knowledge_review_queue` は引き続き `wrong` feedback 専用として維持する。

### 2.2 Action Queue は「修正候補」ではなく「レビュー対象」

Action item は自動修正命令ではない。次の情報を保存する。

- なぜ検出されたか
- どの run / knowledge / community に関係するか
- 推奨 action は何か
- suggested `appliesTo` は何か
- evidence は何か
- 冪等化 key は何か

保存しても実際の変更は行わない。

### 2.3 Materialize は冪等にする

同じ replay comparison を何度実行しても、同じ item が重複作成されてはいけない。

`idempotencyKey` を table unique key とし、既存 item がある場合は新規 insert せず `existingCount` に含める。

## 3. スコープ

### 3.1 実装する

- `landscape_review_items` table
- action item candidate type / schema
- replay compare / landscape snapshot / community comparison からの candidate 生成
- dry-run と write の両方を持つ materialize service
- `GET` / `POST` / `PATCH` API
- CLI からの dry-run / materialize
- Graph UI の Replay Review card から materialize 実行
- Graph UI で persisted action items を表示
- unit / route / component tests

### 3.2 実装しない

- `knowledge_items.appliesTo` の自動更新
- knowledge の自動 active / draft / deprecated 変更
- production ranking boost / repulsion
- promotion gate の強制 enforcement
- LLM による自動 contradiction 確定
- 既存 `knowledge_review_queue` の破壊的 migration

## 4. Data Model

### 4.1 新規 enum 候補

`src/db/schema.ts` に text check 用の value list を追加する。

```ts
export const landscapeReviewItemSourceValues = [
  "replay_compare",
  "landscape_snapshot",
  "semantic_relation_comparison",
  "promotion_gate",
] as const;

export const landscapeReviewItemReasonValues = [
  "used_baseline_lost",
  "baseline_off_topic",
  "baseline_wrong",
  "baseline_missing_after_recompile",
  "negative_attractor_candidate",
  "wrong_review_required",
  "over_selected_not_used",
  "dead_zone_reachability_risk",
  "dead_zone_stale",
  "semantic_reachable_dead_zone",
  "semantic_split",
  "semantic_merge",
  "relation_orphan",
  "promotion_gate_review",
] as const;

export const landscapeReviewItemStatusValues = [
  "pending",
  "reviewing",
  "resolved",
  "dismissed",
] as const;

export const landscapeReviewItemProposedActionValues = [
  "review_only",
  "refine_applies_to",
  "repair_reachability",
  "review_wrong",
  "split_or_merge_review",
  "promotion_gate_review",
  "demote_to_draft_candidate",
] as const;
```

### 4.2 新規 table

Table name: `landscape_review_items`

```ts
export const landscapeReviewItems = pgTable(
  "landscape_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAction: text("proposed_action").notNull().default("review_only"),
    priority: integer("priority").notNull().default(50),
    confidence: text("confidence").notNull().default("low"),
    idempotencyKey: text("idempotency_key").notNull(),

    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => contextCompileRuns.id, { onDelete: "set null" }),
    triggerEventId: uuid("trigger_event_id").references(() => knowledgeUsageEvents.id, {
      onDelete: "set null",
    }),
    communityKey: text("community_key"),
    communityLabel: text("community_label"),

    suggestedAppliesTo: jsonb("suggested_applies_to").default({}).notNull(),
    evidence: jsonb("evidence").default([]).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    note: text("note"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("landscape_review_items_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    statusPriorityCreatedAtIdx: index(
      "landscape_review_items_status_priority_created_at_idx",
    ).on(table.status, table.priority, table.createdAt),
    knowledgeStatusIdx: index("landscape_review_items_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    communityStatusIdx: index("landscape_review_items_community_status_idx").on(
      table.communityKey,
      table.status,
    ),
    runStatusIdx: index("landscape_review_items_run_status_idx").on(table.runId, table.status),
    reasonStatusIdx: index("landscape_review_items_reason_status_idx").on(
      table.reason,
      table.status,
    ),
    sourceCheck: check(
      "landscape_review_items_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(landscapeReviewItemSourceValues))})`,
    ),
    reasonCheck: check(
      "landscape_review_items_reason_check",
      sql`${table.reason} IN (${sql.raw(toSqlList(landscapeReviewItemReasonValues))})`,
    ),
    statusCheck: check(
      "landscape_review_items_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeReviewItemStatusValues))})`,
    ),
    proposedActionCheck: check(
      "landscape_review_items_proposed_action_check",
      sql`${table.proposedAction} IN (${sql.raw(
        toSqlList(landscapeReviewItemProposedActionValues),
      )})`,
    ),
    confidenceCheck: check(
      "landscape_review_items_confidence_check",
      sql`${table.confidence} IN ('low', 'medium', 'high')`,
    ),
  }),
);
```

Migration file: `drizzle/0038_landscape_review_items.sql`

### 4.3 Item contract

Shared schema file: `src/shared/schemas/landscape-review.schema.ts`

```ts
export const landscapeReviewItemSchema = z.object({
  id: z.string(),
  source: landscapeReviewItemSourceSchema,
  reason: landscapeReviewItemReasonSchema,
  status: landscapeReviewItemStatusSchema,
  proposedAction: landscapeReviewItemProposedActionSchema,
  priority: z.number().int().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  knowledgeId: z.string().nullable(),
  runId: z.string().nullable(),
  triggerEventId: z.string().nullable(),
  communityKey: z.string().nullable(),
  communityLabel: z.string().nullable(),
  suggestedAppliesTo: z.record(z.unknown()),
  evidence: z.array(z.string()),
  payload: z.record(z.unknown()),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
```

### 4.4 Migration SQL skeleton

実装時は `drizzle-kit generate` を使ってもよいが、手書きする場合は次の構造を維持する。

```sql
CREATE TABLE IF NOT EXISTS "landscape_review_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "proposed_action" text NOT NULL DEFAULT 'review_only',
  "priority" integer NOT NULL DEFAULT 50,
  "confidence" text NOT NULL DEFAULT 'low',
  "idempotency_key" text NOT NULL,
  "knowledge_id" uuid REFERENCES "knowledge_items"("id") ON DELETE cascade,
  "run_id" uuid REFERENCES "context_compile_runs"("id") ON DELETE set null,
  "trigger_event_id" uuid REFERENCES "knowledge_usage_events"("id") ON DELETE set null,
  "community_key" text,
  "community_label" text,
  "suggested_applies_to" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "note" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp,
  CONSTRAINT "landscape_review_items_source_check"
    CHECK ("source" IN (
      'replay_compare',
      'landscape_snapshot',
      'semantic_relation_comparison',
      'promotion_gate'
    )),
  CONSTRAINT "landscape_review_items_reason_check"
    CHECK ("reason" IN (
      'used_baseline_lost',
      'baseline_off_topic',
      'baseline_wrong',
      'baseline_missing_after_recompile',
      'negative_attractor_candidate',
      'wrong_review_required',
      'over_selected_not_used',
      'dead_zone_reachability_risk',
      'dead_zone_stale',
      'semantic_reachable_dead_zone',
      'semantic_split',
      'semantic_merge',
      'relation_orphan',
      'promotion_gate_review'
    )),
  CONSTRAINT "landscape_review_items_status_check"
    CHECK ("status" IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  CONSTRAINT "landscape_review_items_proposed_action_check"
    CHECK ("proposed_action" IN (
      'review_only',
      'refine_applies_to',
      'repair_reachability',
      'review_wrong',
      'split_or_merge_review',
      'promotion_gate_review',
      'demote_to_draft_candidate'
    )),
  CONSTRAINT "landscape_review_items_confidence_check"
    CHECK ("confidence" IN ('low', 'medium', 'high')),
  CONSTRAINT "landscape_review_items_priority_check"
    CHECK ("priority" >= 0 AND "priority" <= 100),
  CONSTRAINT "landscape_review_items_evidence_array_check"
    CHECK (jsonb_typeof("evidence") = 'array'),
  CONSTRAINT "landscape_review_items_suggested_applies_to_object_check"
    CHECK (jsonb_typeof("suggested_applies_to") = 'object'),
  CONSTRAINT "landscape_review_items_payload_object_check"
    CHECK (jsonb_typeof("payload") = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS "landscape_review_items_idempotency_key_unique"
  ON "landscape_review_items" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "landscape_review_items_status_priority_created_at_idx"
  ON "landscape_review_items" ("status", "priority" DESC, "created_at");

CREATE INDEX IF NOT EXISTS "landscape_review_items_knowledge_status_idx"
  ON "landscape_review_items" ("knowledge_id", "status");

CREATE INDEX IF NOT EXISTS "landscape_review_items_community_status_idx"
  ON "landscape_review_items" ("community_key", "status");

CREATE INDEX IF NOT EXISTS "landscape_review_items_run_status_idx"
  ON "landscape_review_items" ("run_id", "status");

CREATE INDEX IF NOT EXISTS "landscape_review_items_reason_status_idx"
  ON "landscape_review_items" ("reason", "status");
```

Migration 後、`drizzle/meta/_journal.json` に 0038 が登録されることを確認する。

`schema.ts` 側の index 定義で `priority DESC` を表現しにくい場合でも、migration SQL では上記の `DESC` index を優先する。list query は `priority desc, created_at asc, id asc` で固定する。

## 5. Candidate 生成ルール

### 5.1 Replay Compare 起点

Source: `buildLandscapeReplayComparison`

| Input reason | Output reason | Proposed action | Priority | Idempotency key |
|---|---|---|---:|---|
| `used_baseline_lost` | `used_baseline_lost` | `repair_reachability` | 80 | `replay_compare:used_baseline_lost:{runId}:{knowledgeId}` |
| `baseline_off_topic` | `baseline_off_topic` | `refine_applies_to` | 75 | `replay_compare:baseline_off_topic:{runId}:{knowledgeId}` |
| `baseline_wrong` | `baseline_wrong` | `review_wrong` | 95 | `replay_compare:baseline_wrong:{runId}:{knowledgeId}` |
| `baseline_missing_after_recompile` | `baseline_missing_after_recompile` | `repair_reachability` | 65 | `replay_compare:baseline_missing_after_recompile:{runId}:{knowledgeId}` |

Mapping details:

- `runId`: candidate.runId
- `knowledgeId`: candidate.knowledgeId
- `suggestedAppliesTo`: candidate.suggestedAppliesTo
- `evidence`: candidate.evidence
- `payload`: `{ comparisonRun, generatedBy: "landscape_replay_compare" }` の最小情報

### 5.2 Landscape Snapshot risk 起点

Source: `buildLandscapeSnapshot`

| Snapshot risk | Proposed action | Priority | Idempotency key |
|---|---|---:|---|
| `negative_attractor_candidate` | `refine_applies_to` | 85 | `landscape_snapshot:negative_attractor_candidate:{communityKey}` |
| `wrong_review_required` | `review_wrong` | 95 | `landscape_snapshot:wrong_review_required:{communityKey}` |
| `over_selected_not_used` | `review_only` | 55 | `landscape_snapshot:over_selected_not_used:{communityKey}` |
| `dead_zone_reachability_risk` | `repair_reachability` | 70 | `landscape_snapshot:dead_zone_reachability_risk:{communityKey}` |
| `dead_zone_stale` | `review_only` | 45 | `landscape_snapshot:dead_zone_stale:{communityKey}` |

Mapping details:

- community-level item として `communityKey` / `communityLabel` を保存する
- `knowledgeId` は原則 null
- `payload.representativeKnowledgeIds` に snapshot の representative ids を保存する
- `evidence` には classification reason / recommended actions / score summary を入れる

### 5.3 Semantic vs Relation comparison 起点

Source: `buildLandscapeReplaySnapshot().communityComparison`

| Comparison | Proposed action | Priority | Idempotency key |
|---|---|---:|---|
| `semantic_reachable_dead_zone` | `repair_reachability` | 75 | `semantic_relation_comparison:semantic_reachable_dead_zone:{relationCommunityKey}` |
| `semantic_split` | `split_or_merge_review` | 55 | `semantic_relation_comparison:semantic_split:{relationCommunityKey}` |
| `semantic_merge` | `split_or_merge_review` | 55 | `semantic_relation_comparison:semantic_merge:{relationCommunityKey}` |
| `relation_orphan` | `review_only` | 35 | `semantic_relation_comparison:relation_orphan:{relationCommunityKey}` |

### 5.4 Promotion gate 起点

Source: `buildLandscapeReplayComparison().promotionGateSummary`

AQ-1 では aggregate warning として保存する。candidate promotion の実処理は止めない。

Idempotency key:

```txt
promotion_gate:review_required:{windowDays}:{runStatus}:{currentLimit}:{analysisDay}
```

Priority:

- `review_required`: 90
- `normal`: materialize しない

### 5.5 Normalization / payload rules

Candidate 生成時は次を守る。

- `idempotencyKey` は lower-case ASCII で生成する
- `reason`, `source`, `proposedAction`, `confidence` は schema enum を通す
- `knowledgeId`, `runId`, `communityKey` の空文字は `null` に正規化する
- `suggestedAppliesTo.technologies/changeTypes/domains` は trim、dedupe、sort する
- `evidence` は空文字を除外し、最大 8 件までにする
- `payload` には巨大な run detail 全体を保存しない
- `payload.goalPreview` は最大 180 chars
- `payload.representativeKnowledgeIds` は最大 10 件
- `payload.generatedBy` と `payload.generatedAt` を必ず入れる
- `priority` は 0-100 に clamp する

既存 item が `resolved` / `dismissed` の場合も、同じ `idempotencyKey` では再作成しない。再 open をしたい場合は後続で明示 endpoint を作る。

## 6. Service 設計

### 6.1 新規 files

- `src/modules/landscape/landscape-review-items.types.ts`
- `src/modules/landscape/landscape-review-items.repository.ts`
- `src/modules/landscape/landscape-review-items.service.ts`
- `src/shared/schemas/landscape-review.schema.ts`

### 6.2 Public functions

```ts
export async function buildLandscapeReviewItemCandidates(
  input: BuildLandscapeReviewItemCandidatesInput,
): Promise<LandscapeReviewItemCandidateBuildResult>;

export async function materializeLandscapeReviewItems(
  input: MaterializeLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemMaterializeResult>;

export async function listLandscapeReviewItems(
  input: ListLandscapeReviewItemsInput,
): Promise<LandscapeReviewItemListResult>;

export async function updateLandscapeReviewItemStatus(
  input: UpdateLandscapeReviewItemStatusInput,
): Promise<LandscapeReviewItem | null>;
```

### 6.3 実装順序の縦切り

最初の実装スライスは `replay_compare` 起点だけにする。

AQ-1A:

- schema / migration
- `replay_compare` の `appliesToRefineCandidates` だけを materialize
- dry-run / write / list / status update
- CLI dry-run
- route tests

AQ-1B:

- `landscape_snapshot`
- `semantic_relation_comparison`
- `promotion_gate`
- Graph UI の materialize button と persisted item list

この分割により、DB/API の冪等性を先に固めてから、生成 source を増やす。

### 6.4 Materialize input

```ts
type MaterializeLandscapeReviewItemsInput = {
  dryRun?: boolean;
  windowDays: number;
  limit: number;
  runStatus: "ok" | "degraded" | "failed" | "all";
  currentLimit: number;
  landscapeLimit: number;
  landscapeStatus: "current" | "active" | "draft" | "deprecated" | "all";
  relationAxes: Array<"session" | "project" | "source">;
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  sources: Array<
    | "replay_compare"
    | "landscape_snapshot"
    | "semantic_relation_comparison"
    | "promotion_gate"
  >;
  materializeLimit: number;
};
```

### 6.5 Materialize result

```ts
type LandscapeReviewItemMaterializeResult = {
  dryRun: boolean;
  generatedAt: string;
  candidateCount: number;
  insertedCount: number;
  existingCount: number;
  skippedCount: number;
  items: LandscapeReviewItem[];
  candidates: LandscapeReviewItemCandidate[];
};
```

For `dryRun=true`:

- DB insert/update はしない
- `insertedCount=0`
- `candidateCount` と `candidates` を返す

For `dryRun=false`:

- `idempotencyKey` unique で insert
- conflict した item は existing として数える
- `resolved` / `dismissed` 済み item は再 open しない。再 open は別 action にする

### 6.6 Repository details

Repository は次の粒度で実装する。

```ts
export async function insertLandscapeReviewItemsIdempotent(
  candidates: LandscapeReviewItemInsert[],
): Promise<{
  inserted: LandscapeReviewItemRow[];
  existing: LandscapeReviewItemRow[];
}>;
```

実装方針:

- write は `db.transaction` で行う
- `materializeLimit` を超える candidate は priority desc、reason order、idempotencyKey asc で切る
- insert は bulk insert + `onConflictDoNothing({ target: landscapeReviewItems.idempotencyKey })`
- insert 後、candidate の `idempotencyKey` 一覧で select し、inserted/existing を分類する
- list は `status`, `source`, `reason`, `knowledgeId`, `communityKey`, `runId` で filter できる
- list order は `priority desc`, `createdAt asc`, `id asc`
- `PATCH` では `updatedAt` を必ず更新し、`resolved|dismissed` にした場合は `resolvedAt` も設定する

Status transition guard:

```ts
const allowedTransitions = {
  pending: ["reviewing", "resolved", "dismissed"],
  reviewing: ["pending", "resolved", "dismissed"],
  resolved: [],
  dismissed: [],
} as const;
```

## 7. API 設計

`api/modules/graph/graph.routes.ts` に landscape review endpoints を追加する。

### 7.1 Materialize

```txt
POST /api/graph/landscape/replay/queue
```

Request:

```json
{
  "dryRun": true,
  "windowDays": 30,
  "limit": 100,
  "runStatus": "all",
  "currentLimit": 12,
  "landscapeLimit": 1000,
  "landscapeStatus": "active",
  "relationAxes": "session,project,source",
  "minSelectedCount": 3,
  "minFeedbackCount": 3,
  "minSimilarity": 0.72,
  "semanticTopK": 3,
  "sources": [
    "replay_compare",
    "landscape_snapshot",
    "semantic_relation_comparison",
    "promotion_gate"
  ],
  "materializeLimit": 100
}
```

Response:

```json
{
  "result": {
    "dryRun": true,
    "candidateCount": 12,
    "insertedCount": 0,
    "existingCount": 0,
    "skippedCount": 0,
    "items": [],
    "candidates": []
  }
}
```

### 7.2 List

```txt
GET /api/graph/landscape/review-items
```

Query:

- `status=pending|reviewing|resolved|dismissed|all`
- `reason=...`
- `source=...`
- `proposedAction=...`
- `knowledgeId=...`
- `runId=...`
- `communityKey=...`
- `priorityMin=0-100`
- `limit=50`

### 7.3 Status update

```txt
PATCH /api/graph/landscape/review-items/:id
```

Request:

```json
{
  "status": "resolved",
  "note": "appliesTo を手動で調整済み"
}
```

Rules:

- `pending -> reviewing | resolved | dismissed`
- `reviewing -> resolved | dismissed | pending`
- `resolved` / `dismissed` からの変更は AQ-1 では禁止

Error behavior:

- not found: 404
- invalid transition: 409
- invalid schema: 400
- materialize write failure: 500 with audit log

Audit log:

- materialize write 時は `LANDSCAPE_REVIEW_ITEMS_MATERIALIZED`
- status update 時は `LANDSCAPE_REVIEW_ITEM_STATUS_CHANGED`

## 8. CLI 設計

`src/cli/landscape.ts` に option を追加する。

```txt
bun run landscape -- --replay-compare --queue-dry-run
bun run landscape -- --replay-compare --queue
bun run landscape -- --queue-list
bun run landscape -- --queue-list --queue-status pending
```

追加 options:

- `--queue`: materialize する
- `--queue-dry-run`: materialize candidate を表示するが保存しない
- `--queue-list`: persisted items を表示する
- `--queue-status pending|reviewing|resolved|dismissed|all`
- `--queue-source replay_compare,landscape_snapshot,semantic_relation_comparison,promotion_gate`
- `--queue-limit 100`

JSON 出力は既存 CLI と同じ `--json` に統一する。`--queue-json` は追加しない。

出力例:

```txt
Landscape Action Queue dry-run
Candidates: 12
Would insert: 8
Existing: 4

- [95] baseline_wrong knowledge=... run=... action=review_wrong
- [80] used_baseline_lost knowledge=... run=... action=repair_reachability
- [70] dead_zone_reachability_risk community=Auth Boundary action=repair_reachability
```

## 9. Admin UI 設計

### 9.1 Graph Replay Review card

`web/src/modules/admin/components/graph.page.tsx` の `Replay Review` card を拡張する。

追加表示:

- persisted pending count
- dry-run candidate count
- `Create Review Items` button
- materialize result toast/inline message
- persisted action items list

操作:

- `Dry Run` は button 操作にする。初回表示時の自動 write は絶対にしない
- `Create Review Items` 押下で `POST /api/graph/landscape/replay/queue` を `dryRun=false`
- repeated click でも duplicates が増えない
- item ごとに `Resolve` / `Dismiss` button

### 9.2 表示情報

Action item row:

- reason badge
- priority
- confidence
- proposed action
- knowledgeId または community label
- suggested appliesTo facets
- evidence 先頭 2 件
- createdAt
- status

### 9.3 UX boundary

- `Resolve` は「ユーザーが別画面または手動作業で処理した」という状態更新だけ
- `Dismiss` は「今回は扱わない」という状態更新だけ
- knowledge の内容変更や `appliesTo` 更新は別 UI / 別 API に分離する

### 9.4 UI query defaults

Graph UI では負荷を抑えるため次を既定値にする。

- materialize source: 初回は `replay_compare` のみ
- replay compare limit: `25`
- materializeLimit: `50`
- review item list limit: `20`
- status filter: `pending,reviewing`
- community 選択時は `communityKey` filter を優先し、該当 item がない場合だけ global pending count を表示する

書き込み成功後に invalidate する query:

- `graph-landscape-replay-compare`
- `graph-landscape-review-items`
- selected community の review item query

## 10. 実装ステップ

### Phase AQ-0: Preflight

1. `git status --short` で既存変更を確認する
2. DB backup を取る
3. `bun run landscape -- --replay-compare --json` が現在動くことを確認する

### Phase AQ-1: Schema / migration

1. `src/db/schema.ts` に enum values と `landscapeReviewItems` table を追加
2. `drizzle/0038_landscape_review_items.sql` を追加
3. `src/shared/schemas/landscape-review.schema.ts` を追加
4. `test/schemas.test.ts` に schema parse test を追加

Acceptance:

- `bun run typecheck`
- migration SQL が既存 table を破壊しない
- `knowledge_review_queue` の既存 wrong flow は変更なし

### Phase AQ-2: Backend service

1. `landscape-review-items.types.ts` を追加
2. `landscape-review-items.repository.ts` を追加
3. `landscape-review-items.service.ts` を追加
4. replay compare candidate mapping を実装
5. idempotent insert を実装
6. list / status update を実装
7. landscape snapshot risk mapping を実装
8. semantic relation comparison mapping を実装
9. promotion gate item mapping を実装

Acceptance:

- dry-run では DB write しない
- 同じ input で 2 回 materialize しても duplicate が増えない
- `baseline_wrong` は priority 95 / action `review_wrong`
- `dead_zone_reachability_risk` は community-level item として保存される

### Phase AQ-3: API

1. `graph.routes.ts` に `POST /landscape/replay/queue` を追加
2. `graph.routes.ts` に `GET /landscape/review-items` を追加
3. `graph.routes.ts` に `PATCH /landscape/review-items/:id` を追加
4. response schema validation を通す

Acceptance:

- invalid source/reason/status は 400
- dry-run response と write response の shape が同じ
- `PATCH` は許可された status transition だけ通る
- materialize route は `sources=["replay_compare"]` の縦切りで先に通る

### Phase AQ-4: CLI

1. `src/cli/landscape.ts` に queue options を追加
2. `--queue-dry-run` は candidate summary を表示
3. `--queue` は materialize summary を表示
4. `--queue-list` は persisted items を表示
5. `--json` と併用可能にする

Acceptance:

- `bun run landscape -- --replay-compare --queue-dry-run`
- `bun run landscape -- --replay-compare --queue --json`
- `bun run landscape -- --queue-list --queue-status pending`

### Phase AQ-5: Admin UI

1. `web/src/modules/admin/repositories/admin.repository.ts` に API client types/functions を追加
2. Graph page に persisted item query を追加
3. Graph page に materialize mutation を追加
4. Replay Review card の Action Queue を persisted-first に変更
5. candidate-only 表示と persisted 表示を区別する
6. Resolve / Dismiss mutation を追加

Acceptance:

- community view で pending action item count が見える
- `Create Review Items` 実行後に pending count が増える
- 2 回押しても duplicate は増えない
- `Resolve` / `Dismiss` 後に list が更新される

### Phase AQ-6: Tests / verify

追加 test:

- `test/landscape-review-items.test.ts`
  - candidate mapping
  - idempotency key
  - dry-run no write
  - duplicate materialize prevention
- `test/graph.routes.test.ts`
  - materialize route
  - list route
  - patch status route
- `test/components/admin/graph-page.test.tsx`
  - Create Review Items button
  - persisted item count
  - resolve/dismiss action

Verification commands:

```bash
bunx vitest run test/landscape-review-items.test.ts test/graph.routes.test.ts test/components/admin/graph-page.test.tsx
bun run typecheck
bun run lint
bun run format:check
bun run build:web
```

最終的には `bun run verify` を通す。

## 11. 受け入れ条件

1. `GET /api/graph/landscape/replay/compare` の一時 candidate を、明示操作で永続 item にできる
2. materialize は dry-run と write の両方を持つ
3. materialize は冪等で duplicate を作らない
4. pending/reviewing/resolved/dismissed の状態管理ができる
5. Graph UI から action item を作成、確認、resolve/dismiss できる
6. `knowledge_review_queue` の既存 wrong feedback flow を壊さない
7. production ranking と knowledge 本体は変わらない
8. verify が通る

## 12. 実装時の注意点

- 既存 `knowledge_review_queue_active_knowledge_unique` は migration SQL には存在するが、`src/db/schema.ts` 側には表現されていない。今回の実装ではこの table を触らない。
- replay compare は `retrieveKnowledge` を run ごとに呼ぶため、UI からの materialize は `limit=25` から始める。
- `materializeLimit` を必ず設け、初回で大量 item を作らない。
- `resolved` / `dismissed` item の自動再 open は AQ-1 ではやらない。必要なら `reopen` endpoint を後続で作る。
- community-level item は `knowledgeId=null` を許す。UI は knowledge item link 前提にしない。
- `evidence` と `payload` には十分な情報を残すが、巨大な run detail 全体は保存しない。

## 13. 後続候補

AQ-1 完了後に検討する。

1. `appliesTo` 修正 draft の生成
2. `knowledge_candidates` / distillation candidate pipeline への接続
3. candidate promotion gate の warning 表示
4. promotion gate の manual approval enforcement
5. contradiction detection の read-only item 化
6. full compile trajectory playback UI
