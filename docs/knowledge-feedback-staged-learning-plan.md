# Knowledge Feedback 段階適用 実装計画

## 1. 目的

`context_compile` 後に選出 knowledge の妥当性を学習させる。ただし、単発ノイズや誤クリックで `importance` / `confidence` を壊さない。

段階は次の順で固定する。

1. `used / off_topic / wrong` を compile run 単位で保存する
2. 自動反映はまず `dynamicScore` のみに限定する
3. `importance / confidence` は `off_topic` が強く継続した場合だけ小さく減点する
4. `wrong` は自動減点に使わず、必ずレビューキューへ送る

## 2. 現状整理（2026-05-22）

- 実装済み
  - compile 選出履歴（`context_pack_items`）
  - `dynamicScore` 再計算（compile選出数 / agentic採用数 / up/down）
  - 手動 feedback API（`up/down`）
- 未実装
  - `used / off_topic / wrong` の compile run 単位イベント
  - run detail からの verdict 保存 API
  - `off_topic` 専用の `dynamicScore` 減点
  - `wrong` 専用レビューキュー
  - 閾値条件付き `importance / confidence` 減点

## 3. 方針

### 3.1 `wrong` は品質減点に混ぜない

`wrong` は「場違い」より重大で、内容の正誤確認が必要なシグナルである。自動スコア減点に混ぜると、誤クリックや一時的な誤判定で knowledge の品質指標を壊しやすい。

そのため `wrong` は次だけを行う。

- `knowledge_usage_events` に保存
- `knowledge_review_queue` に enqueue
- `dynamicScore` / `importance` / `confidence` は直接変更しない

### 3.2 1 compile run につき 1 knowledge 1 verdict

同じ run detail で同じ knowledge を何度も評価できると、イベント数が膨らみランキングが歪む。

`knowledge_usage_events` は `unique(run_id, knowledge_id)` を持つ。再送時は新規挿入ではなく upsert で verdict を更新する。

### 3.3 compile run 由来だけを初期スコープにする

今回の対象は `context_compile` の結果評価である。`run_id` は `not null` とし、compile run 外の評価イベントは作らない。

将来、Knowledge detail など compile run 外の評価が必要になった場合は、別 API と別制約で拡張する。

## 4. データモデル

### 4.1 新規テーブル: `knowledge_usage_events`

- `id` uuid PK
- `run_id` uuid not null references `context_compile_runs(id)` on delete cascade
- `knowledge_id` uuid not null references `knowledge_items(id)` on delete cascade
- `verdict` text enum: `used | off_topic | wrong`
- `actor` text enum: `user | agent | system`
- `reason` text nullable（最大160文字）
- `metadata` jsonb default `{}`
- `created_at` timestamp not null default now
- `updated_at` timestamp not null default now

制約:

- `unique(run_id, knowledge_id)`
- `verdict` check
- `actor` check

インデックス:

- `(knowledge_id, created_at desc)`
- `(run_id)`
- `(verdict, created_at desc)`
- `(knowledge_id, verdict, created_at desc)`

サービス層制約:

- `knowledge_id` は対象 `run_id` の `context_pack_items` に含まれる `rule/procedure` だけ許可する
- 選出されていない knowledge への feedback は `400` とする

### 4.2 新規テーブル: `knowledge_review_queue`

- `id` uuid PK
- `knowledge_id` uuid not null references `knowledge_items(id)` on delete cascade
- `trigger_event_id` uuid not null references `knowledge_usage_events(id)` on delete cascade
- `trigger_verdict` text not null（初期値は `wrong` のみ）
- `status` text enum: `pending | reviewing | resolved | dismissed`
- `proposed_action` text enum: `review_only | demote_to_draft_candidate`
- `note` text nullable
- `created_at` timestamp not null default now
- `updated_at` timestamp not null default now

制約:

- `trigger_verdict = 'wrong'`
- 同一 `knowledge_id` に `pending/reviewing` が複数できないよう partial unique index を張る

インデックス:

- `(status, created_at asc)`
- `(knowledge_id, status)`

upsert との関係:

- verdict が `wrong` に更新されたら queue を作る
- 同じ `knowledge_id` に未解決 queue があれば新規作成しない
- 同じ `trigger_event_id` の verdict が `wrong` から非 `wrong` に更新された場合、対応する `pending` queue は `dismissed` にする

### 4.3 新規テーブル: `knowledge_quality_adjustments`

`importance / confidence` の自動減点履歴を保持する。`audit_logs` は retention が短いため、cooldown 判定の正としない。

- `id` uuid PK
- `knowledge_id` uuid not null references `knowledge_items(id)` on delete cascade
- `adjustment_kind` text enum: `off_topic_quality_decrement`
- `window_start_at` timestamp not null
- `window_end_at` timestamp not null
- `negative_run_count` integer not null
- `off_topic_rate` real not null
- `importance_delta` real not null
- `confidence_delta` real not null
- `created_at` timestamp not null default now

インデックス:

- `(knowledge_id, adjustment_kind, created_at desc)`
- `(created_at desc)`

### 4.4 既存 `knowledge_items` の扱い

- `knowledge_items` への列追加はしない
- `dynamicScore` は既存列を引き続き使う
- `importance / confidence` は条件付き品質減点ジョブだけが変更する
- イベント数の materialized counter は初期実装では作らない

## 5. API / サービス設計

### 5.1 新規 API

`POST /api/context/runs/:id/knowledge-feedback`

入力:

- `items: Array<{ knowledgeId: string; verdict: "used" | "off_topic" | "wrong"; reason?: string }>`

バリデーション:

- `runId` が存在する
- `items` は 1 から 100 件
- 1 request 内で同一 `knowledgeId` が重複しない
- 各 `knowledgeId` は対象 run の selected knowledge に含まれる
- `reason` は最大160文字

動作:

- `knowledge_usage_events` に `unique(run_id, knowledge_id)` で upsert
- verdict 変更時は `updated_at` を更新
- `wrong` は queue enqueue
- `wrong -> used/off_topic` 変更時は、その event に紐づく `pending` queue を `dismissed`
- 影響を受けた knowledge だけ `dynamicScore` を再計算

レスポンス:

- `savedCount`
- `updatedCount`
- `queueCreatedCount`
- `queueDismissedCount`
- `affectedKnowledgeIds`

### 5.2 `dynamicScore` 反映

既存の `computeDynamicScore` を拡張し、usage event の集計を追加する。

追加する signal:

- `usageUsedCount30d`
- `usageOffTopicCount30d`

初期式:

- 既存 score:
  - compile select: `min(35, log1p(compileSelectCount) * 10)`
  - recent select: `min(25, recentSelectCount30d * 3)`
  - agentic accept: `min(20, agenticAcceptCount * 4)`
  - explicit upvote: `min(20, explicitUpvoteCount * 10)`
  - explicit downvote: `-min(40, explicitDownvoteCount * 15)`
- 追加 score:
  - used: `+min(10, usageUsedCount30d * 1.5)`
  - off_topic: `-min(30, usageOffTopicCount30d * 3)`
- `wrong` は score に入れない
- 最終値は `0..100` に clamp

再計算方法:

- APIで保存・更新された `knowledgeId` だけを対象にする
- `context_pack_items` から既存 select count / recent select count を集計
- `knowledge_usage_events` から直近30日の `used/off_topic` を集計
- `knowledge_items.dynamicScore` を更新する

### 5.3 条件付き品質減点ジョブ

CLI: `bun run knowledge:apply-feedback-quality`

対象:

- active knowledge のみ
- `wrong` は対象外

窓:

- 直近14日

指標:

- `off_topic_run_count = count(distinct run_id where verdict = 'off_topic')`
- `used_run_count = count(distinct run_id where verdict = 'used')`
- `off_topic_rate = off_topic_run_count / (used_run_count + off_topic_run_count)`

発火条件:

- `off_topic_run_count >= 5`
- `off_topic_rate >= 0.6`
- 同じ knowledge に `off_topic_quality_decrement` が直近14日以内に存在しない

実行:

- `importance = max(0, importance - 2)`
- `confidence = max(0, confidence - 2)`
- `knowledge_quality_adjustments` に履歴保存
- `audit_logs` にも補助ログを記録

実行しない条件:

- `used_run_count + off_topic_run_count = 0`
- `wrong` だけが多い
- cooldown 中
- knowledge が `draft/deprecated`

### 5.4 `wrong` レビューキュー

`wrong` は人間レビューを起動するためのシグナルに限定する。

初期挙動:

- `wrong` event 保存時に `knowledge_review_queue` へ `pending` 追加
- `proposed_action` は `demote_to_draft_candidate`
- 同じ knowledge に未解決 queue があれば追加しない

レビュー結果:

- `resolved`: 人間が確認し対応済み
- `dismissed`: 誤クリックや問題なし

実装範囲:

- 今回は enqueue と status 更新 API まで
- 専用レビュー画面は別タスクでもよい

## 6. UI 方針

対象: `context_compile` run detail

- Selected Knowledge (Audit) 各項目に verdict 操作を追加
  - `Used`
  - `Off-topic`
  - `Wrong`
- 既存 `up/down` は compile run detail には出さない
- 既存 `up/down` API は Knowledge page 互換として残す
- 送信済み verdict がある場合は現在値を表示し、再クリックで更新できる
- submit 後に保存件数と queue 追加/解除件数を表示する

## 7. 移行・互換

- 既存 `POST /api/knowledge/:id/feedback (up/down)` は維持
- compile run detail の新UIは `used/off_topic/wrong` だけを使う
- `dynamicScore` は既存 up/down と新 usage event を統合する
- 既存 compile 履歴から `used` を自動 backfill しない
  - 選出されたことと「役立った」は同義ではないため
- 必要なら `dynamicScore` の再計算 CLI を追加する

## 8. テスト計画

### 8.1 単体

- `computeDynamicScore`
  - `usageUsedCount30d` で微増する
  - `usageOffTopicCount30d` で減点する
  - `wrong` は入力 signal に存在せず score に影響しない
- 品質減点条件
  - `off_topic_run_count < 5` では減点しない
  - `off_topic_rate < 0.6` では減点しない
  - `wrong` だけでは減点しない
  - cooldown 中は減点しない

### 8.2 API

- 正常系
  - run feedback を保存できる
  - 同一 `(runId, knowledgeId)` 再送は upsert になる
  - `wrong` で queue が作られる
  - `wrong -> used/off_topic` で対応 queue が `dismissed` になる
- 異常系
  - request 内の重複 `knowledgeId`
  - run 不在
  - selected knowledge ではない `knowledgeId`
  - verdict 不正

### 8.3 統合

- compile run 作成 -> feedback 投入 -> `dynamicScore` 反映
- `off_topic` 条件未達で `importance/confidence` 不変
- `off_topic` 条件達成 + cooldown外で `importance/confidence` が `-2`
- `wrong` 多数でも `importance/confidence` は不変で queue だけ作られる

## 9. ロールアウト手順

1. DB migration
   - `knowledge_usage_events`
   - `knowledge_review_queue`
   - `knowledge_quality_adjustments`
2. repository / service 実装
3. API 実装
4. `dynamicScore` 再計算拡張
5. run detail UI 最小実装
6. 品質減点 CLI 実装
7. 単体・API・統合テスト追加
8. `bun run verify`

## 10. 受け入れ基準

- run 単位で `used/off_topic/wrong` が保存される
- 同一 run / knowledge の重複イベントで score が膨らまない
- `dynamicScore` は `used/off_topic` を反映する
- `wrong` は `dynamicScore` / `importance` / `confidence` を直接変更しない
- `wrong` はレビューキューへ積まれる
- 単発ミスでは `importance/confidence` が下がらない
- `off_topic` が閾値を満たした場合だけ `importance/confidence` が小さく下がる
- 既存 `up/down` API は壊れない
- 全テストと `bun run verify` が通る
