# Knowledge Landscape Trajectory / Contradiction 次フェーズ実装計画

> Status: ready to discuss / implementation draft
> Date: 2026-05-24 JST
> Last reviewed: 2026-05-24 JST
> Based on:
> - `docs/knowledge-landscape-concept-design.md`
> - `docs/knowledge-landscape-action-queue-implementation-plan.md`
> - `docs/knowledge-landscape-action-queue-next-phase-implementation-plan.md`

## 0. セルフレビュー結果

初版自己評価は **88 / 100**。主な不足は次の4点だった。

- ranking trace の保存粒度が曖昧で、実装時に row-per-stage か row-per-candidate か迷う余地があった
- contradiction detection の誤検知対策が薄く、review queue を noisy にするリスクがあった
- playback UI と mutable sandbox UI の境界が曖昧で、Graph page が肥大化するリスクがあった
- production ranking / auto-mutation をどこまで禁止するかが明文化されていなかった

改善内容:

- trace は **run/item 1行 + stage rank columns + JSON evidence** を MVP とし、event stream は後続に分離した
- contradiction は deterministic heuristic + scope overlap + evidence snippet + confidence threshold に限定した
- UI は trajectory playback MVP と sandbox comparison UI を別タスクに分けた
- この計画では production ranking、query expansion、自動 suppression、自動 repair を明示的に対象外にした

改訂後の自己評価は **95 / 100**。残リスクは storage volume と Graph UI complexity だが、MVP の cap、専用 component 分割、read-only rollout で制御可能である。

## 1. 背景

AQ-7〜AQ-10 で、Knowledge Landscape は review item、candidate draft、distillation pipeline、warning、manual approval gate まで接続済みになった。

残っている大きな未実装は次の4つである。

- compile trajectory playback
- 全候補 ranking trace の永続化
- contradiction detection の read-only review item 化
- mutable sandbox graph UI

この計画では、production ranking を変える前に、**なぜその context pack が選ばれたか**と、**どの knowledge 同士が運用上衝突して見えるか**を観測可能にする。

## 2. 目的

達成後の状態:

```txt
context_compile run
  -> candidate trace 保存
  -> run trajectory API / CLI / Graph UI で再生
  -> semantic/relation近傍の contradiction 候補を read-only review item 化
  -> replay sandbox の差分を Graph 上で比較
```

この計画は observability / reviewability を強化する。retrieval ranking、knowledge score、candidate finalize、production compile output を自動変更しない。

## 3. スコープ

### 3.1 実装する

- context compile の候補 trace 永続化
- run 単位の trajectory API / CLI
- Graph UI の trajectory playback MVP
- contradiction detection の deterministic read-only materialize
- contradiction review item の永続化
- replay comparison の baseline/sandbox 差分 UI MVP

### 3.2 実装しない

- production ranking boost / repulsion
- Basin-aware query expansion
- contradiction による自動 suppression
- contradiction からの自動 candidate draft 生成
- LLM-only contradiction 判定
- knowledge body の自動 rewrite / merge / split
- full animation timeline

## 4. 優先度

| Priority | Task | 理由 |
|---|---|---|
| P0 | LT-1 trace schema / persistence | playback、ranking explain、sandbox UI の基礎データになる |
| P0 | LT-2 trajectory API / CLI | UI より先に検証可能な contract を作る |
| P1 | LT-3 Graph trajectory playback MVP | ユーザーが compile run の経路を読む入口になる |
| P1 | LT-4 contradiction detection read-only | Action Queue の次の価値だが、誤検知を抑えて小さく始める |
| P1 | LT-5 contradiction UI | read-only detection を既存 Action Queue の運用に接続する |
| P2 | LT-6 mutable sandbox graph UI | trace と contradiction の後で見せる情報が増える |
| P3 | LT-7 snapshot cache | 性能問題が出るまで後回し |

## 5. Blocker / 判断が必要な点

### 5.1 Trace storage volume

候補全件を保存すると DB サイズが増える。MVP では以下で制御する。

- body text は保存しない
- `run_id`, `item_kind`, `item_id`, rank/score/reason のみを保存する
- `CONTEXT_COMPILE_TRACE_LIMIT` 相当の上限を設ける
- default cap は 200 candidates/run とする
- cap 超過時は run diagnostics に `candidateTraceTruncated=true` を残す

### 5.2 Candidate identity

trace は knowledge item を対象にする。source fragment や raw source candidate は後続扱いにする。

理由:

- `context_pack_items` と照合しやすい
- landscape community / usage feedback と join しやすい
- source trace まで含めると schema が肥大化する

### 5.3 Contradiction false positives

最初は read-only review item に限定する。priority と confidence を低めにし、materialize limit と reason filter で運用する。

誤検知対策:

- same / overlapping appliesTo がある pair のみ対象
- active knowledge 同士、または active vs deprecated の明示比較に限定
- relation neighbor または semantic neighbor のどちらかがある pair のみ対象
- polarity heuristic は body snippet と title snippet を evidence に残す
- confidence threshold 未満は materialize しない

### 5.4 Graph page complexity

Graph page は既に多機能である。新規 UI は component 分割を必須にする。

想定 component:

- `trajectory-panel.tsx`
- `trajectory-stage-table.tsx`
- `contradiction-review-list.tsx`
- `sandbox-comparison-panel.tsx`

### 5.5 Ranking behavior

この計画では ranking の挙動を変えない。trace は観測用であり、boost/repulsion/query expansion の入力に使うのは後続計画で扱う。

## 6. データモデル

### 6.1 新規テーブル: `context_compile_candidate_traces`

`src/db/schema.ts` / `drizzle/0040_context_compile_candidate_traces.sql`

- `id` uuid pk
- `run_id` uuid not null (`context_compile_runs.id` FK cascade)
- `item_kind` text not null
  - `rule | procedure`
- `item_id` uuid not null (`knowledge_items.id` FK cascade)
- `text_rank` integer null
- `text_score` real null
- `vector_rank` integer null
- `vector_score` real null
- `merged_rank` integer null
- `merged_score` real null
- `final_rank` integer null
- `final_score` real null
- `selected` boolean not null default false
- `suppressed` boolean not null default false
- `suppression_reason` text null
- `agentic_decision` text not null default `not_evaluated`
  - `not_evaluated | accepted | rejected | skipped`
- `ranking_reason` text null
- `community_key` text null
- `evidence` jsonb not null default `{}`
- `created_at` timestamp not null default now()

制約:

- unique(`run_id`, `item_kind`, `item_id`)
- status check for `item_kind`
- status check for `agentic_decision`

索引:

- index(`run_id`, `final_rank`)
- index(`item_id`, `created_at`)
- index(`run_id`, `selected`)
- index(`suppression_reason`)
- index(`community_key`, `created_at`)

### 6.2 既存 diagnostics への追加

`context_compile_runs.diagnostics.retrievalStats` に以下を追加する。

- `candidateTraceSavedCount`
- `candidateTraceTruncated`
- `candidateTraceLimit`
- `candidateTraceSkippedReason`

### 6.3 landscape review item enum 拡張

`landscape_review_items.source` に追加:

- `contradiction_detection`

`landscape_review_items.reason` に追加:

- `contradiction_review`

`landscape_review_items.proposed_action` に追加:

- `review_contradiction`

## 7. 実装タスク

### 7.1 LT-1: candidate trace persistence

対象:

- `src/db/schema.ts`
- `drizzle/0040_context_compile_candidate_traces.sql`
- `src/modules/context-compiler/context-compiler.repository.ts`
- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/knowledge/knowledge.service.ts`
- `src/shared/schemas/context-pack.schema.ts`

実装内容:

1. `searchKnowledgeForContext` の text/vector/merged result に rank と score を付与する
2. `context_compile` の final selection 後に trace rows を組み立てる
3. `contextPackItems` 保存と同じ run lifecycle で trace を保存する
4. cap 超過時は final selected items を必ず含め、残りは merged rank 上位から保存する
5. `force no write` / degraded run でも run が保存される場合は trace 保存を試みる

保存方針:

- full body は保存しない
- title は保存しない
- snippet が必要な場合は `evidence` に short locator のみ保存する
- exact text は既存 `knowledge_items` から読む

### 7.2 LT-2: trajectory API / CLI

対象:

- `src/modules/landscape/landscape-trajectory.repository.ts`（新規）
- `src/modules/landscape/landscape-trajectory.service.ts`（新規）
- `src/shared/schemas/landscape-trajectory.schema.ts`（新規）
- `api/modules/graph/graph.routes.ts`
- `src/cli/landscape.ts`

API:

- `GET /api/graph/landscape/trajectory/:runId`
- query: `{ includeCandidates?: boolean, limit?: number }`

返却:

- run summary
- stage counts
- selected knowledge ids
- candidate traces
- community summary
- missing trace warning

CLI:

```bash
bun run landscape --trajectory-run-id <runId> --json
bun run landscape --trajectory-run-id <runId> --limit 100
```

### 7.3 LT-3: Graph trajectory playback MVP

対象:

- `web/src/modules/admin/components/graph.page.tsx`
- `web/src/modules/admin/components/trajectory-panel.tsx`（新規）
- `web/src/modules/admin/repositories/admin.repository.ts`
- `test/components/admin/graph-page.test.tsx`

UI:

- Replay Review / risky run row から `View Trajectory`
- selected run の stage summary
- candidate table
  - text rank
  - vector rank
  - merged rank
  - final rank
  - selected
  - suppressed reason
  - community
- Graph 上の selected communities highlight
- trace がない run は `trace unavailable` と表示

MVP では timeline animation は行わない。table + community highlight で十分とする。

### 7.4 LT-4: contradiction detection read-only

対象:

- `src/modules/landscape/landscape-contradiction.service.ts`（新規）
- `src/modules/landscape/landscape-contradiction.repository.ts`（新規）
- `src/shared/schemas/landscape-contradiction.schema.ts`（新規）
- `src/modules/landscape/landscape-review-items.service.ts`
- `src/shared/schemas/landscape-review.schema.ts`
- `src/cli/landscape.ts`

検出対象:

- active rule/procedure pairs
- active vs deprecated pairs
- same repo / overlapping appliesTo
- same relation community or high semantic similarity

初期 heuristic:

- one item contains strong requirement markers
  - `must`, `required`, `always`, `必須`, `必ず`
- paired item contains avoidance markers
  - `avoid`, `never`, `do not`, `禁止`, `避ける`
- same target concept appears in title/body tokens
- deprecated item has high recent selection count while active replacement exists

出力:

- pair key
- knowledge ids
- reason
- confidence
- evidence snippets
- suggested action `review_contradiction`

Materialize:

- `bun run landscape --queue --queue-source contradiction_detection`
- `POST /api/graph/landscape/replay/queue` accepts `contradiction_detection`

### 7.5 LT-5: contradiction UI

対象:

- `web/src/modules/admin/components/graph.page.tsx`
- `web/src/modules/admin/components/contradiction-review-list.tsx`（新規）
- `web/src/modules/admin/repositories/admin.repository.ts`
- `test/components/admin/graph-page.test.tsx`

UI:

- Action Queue に `contradiction_review` を表示
- evidence に both knowledge ids / snippets / confidence を表示
- resolve / dismiss は既存 review item status update を使う
- candidate draft creation はこの phase では行わない

### 7.6 LT-6: mutable sandbox graph UI MVP

対象:

- `web/src/modules/admin/components/sandbox-comparison-panel.tsx`（新規）
- `web/src/modules/admin/components/graph.page.tsx`
- `web/src/modules/admin/repositories/admin.repository.ts`

UI:

- replay compare result の baseline / current / sandbox summary を並べる
- changed selected items を list 表示する
- added / removed / retained を色分けする
- Graph 上では affected communities を highlight する

対象外:

- sandbox rule editing
- ranking parameter editing
- write-back

### 7.7 LT-7: optional snapshot cache

これは性能問題が確認された場合のみ実装する。

対象:

- `landscape_snapshots` table
- on-demand refresh CLI
- admin cache status indicator

現時点では backlog とする。

## 8. API / schema contract

### 8.1 Trajectory result schema

```ts
type LandscapeTrajectoryResult = {
  run: {
    id: string;
    goal: string;
    retrievalMode: string | null;
    status: string;
    createdAt: string;
  };
  traceAvailable: boolean;
  warnings: string[];
  stageCounts: {
    textHit: number;
    vectorHit: number;
    merged: number;
    finalRanked: number;
    selected: number;
    suppressed: number;
  };
  candidates: Array<{
    itemKind: "rule" | "procedure";
    itemId: string;
    textRank: number | null;
    vectorRank: number | null;
    mergedRank: number | null;
    finalRank: number | null;
    finalScore: number | null;
    selected: boolean;
    suppressed: boolean;
    suppressionReason: string | null;
    agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
    rankingReason: string | null;
    communityKey: string | null;
  }>;
};
```

### 8.2 Contradiction review payload

`landscape_review_items.payload`:

```json
{
  "generatedBy": "landscape_contradiction_detection",
  "pairKey": "sha1:...",
  "leftKnowledgeId": "...",
  "rightKnowledgeId": "...",
  "leftMarkers": ["must"],
  "rightMarkers": ["avoid"],
  "overlap": {
    "repoPath": true,
    "technologies": ["typescript"],
    "changeTypes": ["implementation"]
  },
  "confidenceBreakdown": {
    "scopeOverlap": 0.3,
    "semanticOrRelationNeighbor": 0.3,
    "polarityConflict": 0.4
  }
}
```

## 9. テスト計画

### 9.1 Unit tests

- `test/context-compile-candidate-trace.test.ts`
  - text/vector/merged/final ranks are persisted
  - selected items are always included under trace cap
  - trace truncation diagnostics are set
- `test/landscape-trajectory.service.test.ts`
  - trajectory result returns stage counts
  - missing trace returns `traceAvailable=false`
- `test/landscape-contradiction.service.test.ts`
  - detects scoped must/avoid conflict
  - ignores unrelated appliesTo
  - ignores low confidence pair
  - idempotency key is stable

### 9.2 API tests

- `test/graph.routes.test.ts`
  - `GET /api/graph/landscape/trajectory/:runId`
  - contradiction source materialize
  - invalid source rejected

### 9.3 Component tests

- `test/components/admin/graph-page.test.tsx`
  - View Trajectory opens panel
  - missing trace warning displays
  - contradiction review item renders evidence
  - sandbox comparison shows added/removed/retained

### 9.4 Verification commands

```bash
bun run typecheck
bunx vitest run test/context-compile-candidate-trace.test.ts test/landscape-trajectory.service.test.ts test/landscape-contradiction.service.test.ts test/graph.routes.test.ts test/components/admin/graph-page.test.tsx
bun run verify
```

## 10. Rollout order

1. LT-1 trace schema / persistence
2. LT-2 trajectory API / CLI
3. LT-3 Graph trajectory playback MVP
4. LT-4 contradiction detection read-only
5. LT-5 contradiction UI
6. LT-6 mutable sandbox graph UI MVP
7. LT-7 snapshot cache only if needed

Each phase should be independently shippable. LT-1/LT-2 should land before UI work. LT-4 must remain read-only until review item noise is measured.

## 11. 完了条件

- context compile run の候補 trace が保存される
- selected item は trace cap があっても必ず保存される
- run 単位で trajectory を API / CLI から取得できる
- Graph UI で trajectory summary と candidate table を確認できる
- contradiction candidates を read-only review item として materialize できる
- contradiction review item は既存 Action Queue 上で resolve / dismiss できる
- production ranking、query expansion、auto suppression は変わっていない
- `bun run verify` が通る

## 12. 後続バックログ

- trace event stream table
- source fragment / wiki source candidate trace
- full animated trajectory playback
- contradiction candidate draft generation
- LLM-assisted contradiction explanation
- production ranking experiment gate
- Basin-aware query expansion dry-run
- snapshot cache / retention policy
