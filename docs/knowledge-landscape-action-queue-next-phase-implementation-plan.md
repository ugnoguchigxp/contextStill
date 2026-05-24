# Knowledge Landscape Action Queue 次フェーズ 実装計画

> Status: ready to implement
> Date: 2026-05-24 JST
> Last reviewed: 2026-05-24 JST
> Based on:
> - `docs/knowledge-landscape-action-queue-implementation-plan.md`（AQ-1 完了）

## 0. ドキュメントレビュー結果

初版レビュー時点の自己評価は **8.4 / 10**。減点理由は次の3点だった。

- candidate 冪等キーの生成規則が曖昧で、再実行時に key ぶれの余地がある
- approval 更新 endpoint が review item 単位のみで、link 複数時の対象識別が不十分
- `runFinalizeDistille` での manual approval 判定経路が実装単位で具体化されていない

この改訂版では上記3点を具体仕様へ落とし込み、**9.2 / 10** を目標品質とする。

## 1. 背景

`Knowledge Landscape Action Queue` は AQ-1 で永続化・API・CLI・Admin UI まで実装済みで、以下が運用可能になっている。

- `landscape_review_items` への materialize（`replay_compare` / `landscape_snapshot` / `semantic_relation_comparison` / `promotion_gate`）
- `POST /api/graph/landscape/replay/queue`
- `GET /api/graph/landscape/review-items`
- `PATCH /api/graph/landscape/review-items/:id`
- `bun run landscape --queue-*` 系 CLI
- Graph Admin からの create / resolve / dismiss

一方で、AQ-1 計画の「後続候補」は未実装である。

1. `appliesTo` 修正 draft 生成
2. `knowledge_candidates` / distillation pipeline への接続
3. candidate promotion gate warning 表示
4. promotion gate の manual approval enforcement
5. contradiction detection の read-only item 化
6. full compile trajectory playback UI

この計画では、1〜4 を次フェーズの本実装スコープとして定義し、5〜6 は後続バックログとして整理する。

## 2. 目的

Landscape Review Item を「発見して終わり」ではなく、candidate 起票・蒸留・最終反映の運用フローまで接続する。

達成後の状態:

```txt
Landscape review item (pending/reviewing)
  -> candidate draft 生成 (idempotent)
  -> distillation pipeline 実行
  -> promotion gate warning 可視化
  -> manual approval がない場合は finalize を拒否
```

## 3. スコープ

### 3.1 実装する（AQ-7〜AQ-10）

- review item から candidate draft を生成する service / API / UI 操作
- review item と candidate のトレーサビリティ保存
- candidate 一覧での landscape 起点 warning 表示
- finalize 時の manual approval enforcement

### 3.2 実装しない（この計画の外）

- contradiction の自動判定ロジック
- full compile trajectory playback の新規可視化 UI
- ranking / `knowledge_items` への自動スコア補正

## 4. 設計判断

### 4.1 candidate 生成は idempotent にする

既存 `registerCandidate` は毎回ランダム `targetKey` を生成するため、同じ review item から重複 candidate を作り得る。  
次フェーズでは review item 起点専用 service を追加し、`targetKind + targetKey + distillationVersion` unique を使って重複を抑止する。

`candidate_key` は次の canonical 化を必須化する。

1. `suggestedAppliesTo` は key 昇順、配列値は trim + lower + 重複除去 + 昇順で正規化
2. `evidence` は trim + 重複除去後に昇順化（保存順とは分離）
3. `reason`, `proposedAction`, `communityKey`, `knowledgeId` を連結
4. 上記 JSON を stable stringify して sha1 を計算

これにより順序揺れによる key ぶれを防ぐ。

### 4.2 review item と candidate のリンクを明示保存する

`payload` への埋め込みのみでは検索・運用が弱い。  
リンクテーブルを追加し、review item から `target_state_id` / `find_candidate_result_id` を辿れるようにする。

### 4.3 manual approval は finalize の入口で強制する

warning 表示だけでは運用漏れが起きるため、`runFinalizeDistille` 側で gate 判定を行う。  
approval 未付与の場合は `status="rejected"` とし、理由を返す。

## 5. データモデル変更（AQ-7/AQ-10）

### 5.1 新規テーブル: `landscape_review_item_candidate_links`

`src/db/schema.ts` / `drizzle/0039_landscape_review_item_candidate_links.sql`

- `id` uuid pk
- `review_item_id` uuid not null (`landscape_review_items.id` FK, cascade)
- `target_state_id` uuid not null (`distillation_target_states.id` FK, cascade)
- `find_candidate_result_id` uuid not null (`find_candidate_results.id` FK, cascade)
- `candidate_key` text not null（review item 起点の deterministic key）
- `status` text not null default `draft_created`
  - `draft_created | review_required | approved | rejected | finalized`
- `approval_note` text null
- `approved_by` text null
- `approved_at` timestamp null
- `created_at` / `updated_at`

制約:

- unique(`review_item_id`, `candidate_key`)
- unique(`target_state_id`, `find_candidate_result_id`)
- status check (`draft_created|review_required|approved|rejected|finalized`)

索引:

- index(`review_item_id`, `status`, `created_at`)
- index(`target_state_id`)
- index(`find_candidate_result_id`)

### 5.2 status 遷移ルール（link）

- `draft_created -> review_required | approved | rejected`
- `review_required -> approved | rejected`
- `approved -> finalized | rejected`
- `rejected -> approved`（再審査のみ許可）
- `finalized` は終端

`approval_note` は `approved` / `rejected` 遷移時にのみ更新する。

### 5.3 既存テーブルの軽微拡張

`landscape_review_items` の `payload` に以下を格納する（検索キーはリンクテーブル優先）。

- `lastCandidateTargetStateId`
- `lastCandidateResultId`
- `lastCandidateCreatedAt`

## 6. 実装タスク

### 6.1 AQ-7: review item -> candidate draft 生成

対象:

- `src/modules/landscape/landscape-review-candidate.service.ts`（新規）
- `src/modules/landscape/landscape-review-candidate.repository.ts`（新規）
- `src/shared/schemas/landscape-review-candidate.schema.ts`（新規）
- `api/modules/graph/graph.routes.ts`
- `src/cli/landscape.ts`
- `web/src/modules/admin/components/graph.page.tsx`

実装内容:

1. 入力 review item 群（`pending|reviewing`）から candidate draft を生成
2. `proposedAction` ごとに candidate テンプレートを分岐
   - `refine_applies_to` / `repair_reachability`: procedure 形式で `Use when / Workflow / Verification / Avoid` を必須化
   - `review_wrong` / `promotion_gate_review`: rule 形式で運用警告を記述
3. deterministic `candidate_key` を生成  
   例: `landscape-review-item:{reviewItemId}:{reason}:{sha1(suggestedAppliesTo+evidence)}`
4. `distillation_target_states` / `find_candidate_results` を transaction で作成（既存なら再利用）
5. link テーブルに upsert
6. `find_candidate_results.origin.source = "landscape_review_item"` を保存
7. `find_candidate_results.origin.reviewItemId` / `origin.candidateKey` を保存

API:

- `POST /api/graph/landscape/review-items/candidates`
  - body: `{ ids?: string[], status?: "pending"|"reviewing", limit?: number, dryRun?: boolean }`
  - ルール:
    - `ids` 指定時は `status` フィルタを無視し、指定 id のみ処理
    - `ids` 未指定時は `status` + `limit`（priority desc, created_at asc）で対象選定
    - `dryRun=true` は DB write を行わず、生成予定の `targetKey/candidateKey` のみ返す

CLI:

- `bun run landscape --queue-create-candidates [--queue-status pending] [--queue-limit 20] [--queue-dry-run]`

UI:

- Replay Review card に `Create Candidate Drafts` ボタン追加
- item row に `Draft linked` 状態表示

### 6.2 AQ-8: distillation pipeline 接続

対象:

- `src/cli/distill-pipeline.ts`（必要ならオプション追加）
- `src/modules/distillationPipeline/runner.ts`
- `api/modules/candidates/candidates.repository.ts`
- `web/src/modules/admin/components/candidates.page.tsx`

実装内容:

1. landscape 起点 candidate を `targetKind=knowledge_candidate` で既存 pipeline に流す（新規 kind は増やさない）
2. candidate 一覧で landscape 起点を識別可能にする
   - `origin.source=landscape_review_item` を第一判定とし、link table join は補助に使う
3. review item から candidates 画面へ遷移可能にする（`targetStateId` クエリ）
4. `src/cli/distill-pipeline.ts` に `--target-state-id`（単数）を追加し、対象 candidate のみ実行可能にする

### 6.3 AQ-9: promotion gate warning 表示

対象:

- `api/modules/candidates/candidates.repository.ts`
- `web/src/modules/admin/components/candidates.page.tsx`
- `web/src/modules/admin/components/graph.page.tsx`

実装内容:

1. warning 判定ルール:
   - review item reason が `promotion_gate_review`
   - または link status が `review_required`
2. candidates 一覧に warning badge と理由表示を追加
3. graph の review item 行から warning 詳細（reason/evidence）を参照可能にする

### 6.4 AQ-10: manual approval enforcement

対象:

- `src/modules/finalizeDistille/domain.ts`
- `src/modules/landscape/landscape-review-candidate.repository.ts`
- `api/modules/graph/graph.routes.ts`（approval 更新 endpoint）
- `src/shared/schemas/landscape-review-candidate.schema.ts`

実装内容:

1. approval endpoint 追加
   - `PATCH /api/graph/landscape/review-items/:id/candidate-links/:linkId`
   - body: `{ status: "approved" | "rejected", note?: string, actor?: string }`
2. `runFinalizeDistille` で `targetKind=knowledge_candidate` かつ landscape link ありの場合に approval を確認
3. 未承認の場合は finalize を拒否  
   `reason = "landscape_manual_approval_required"`
4. 承認済みの場合のみ通常 finalize を許可し、link status を `finalized` に更新
5. 判定手順:
   - `coverEvidenceResultId` から `find_candidate_results.id` を引く
   - link が存在しない candidate は既存挙動（approval 不要）で通す
   - link が存在する candidate は `approved` 以外を拒否
   - `finalized` 済みは idempotent 成功として通す

## 7. テスト計画

### 7.1 追加・更新対象

- `test/landscape-review-items.test.ts`
  - review item -> candidate draft 生成
  - idempotent 再実行で duplicate なし
- `test/graph.routes.test.ts`
  - candidate draft 作成 endpoint
  - approval endpoint
- `test/components/admin/graph-page.test.tsx`
  - Create Candidate Drafts ボタン
  - warning 表示
- `test/components/admin/knowledge-candidates-page.test.tsx`
  - warning badge 表示
  - `targetStateId` フィルタ導線
- `test/distillation-pipeline-runner.test.ts`
  - `targetStateId` 指定時に対象外 candidate を処理しない
- `test/finalize-distille.test.ts`（既存へケース追加）
  - 未承認拒否 / 承認後通過

### 7.2 実行コマンド

```bash
bun run test:unit
bun run test:unit:api
bun run verify
```

## 8. ロールアウト順序

1. AQ-7（draft 生成 + link 保存）
2. AQ-8（pipeline 接続と candidates 導線）
3. AQ-9（warning 可視化）
4. AQ-10（manual approval enforcement）

各フェーズは PR を分ける。AQ-10 は最後に入れて、運用停止リスクを局所化する。

## 9. 完了条件

- review item から candidate draft を idempotent に生成できる
- review item と candidate の双方向追跡が可能
- candidates 画面で promotion gate warning が識別できる
- manual approval なしの finalize が拒否される
- 既存 AQ-1 の materialize/list/status 更新機能が回帰しない

## 10. 後続バックログ（今回対象外）

1. contradiction detection を read-only review item として追加
2. full compile trajectory playback UI の実装
