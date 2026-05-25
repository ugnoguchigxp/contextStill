# Queue Migration Plan

> Status: implementation-ready plan
> Review score: 9/10 after revision
> Scope: 旧 `distillation_target_states` 状態機械を廃止し、4つの専用キューを distillation の唯一の実行経路にする。
> Non-goal: `context_compile` の retrieval/ranking 挙動、`knowledge_items` の review/promote workflow、source ingestion の UI そのものはこの移行では変えない。

この文書での **Queue** は、memory-router の distillation 用キュー実行系を指す。汎用的なジョブキュー全般ではなく、`findingCandidate` / `coveringEvidence` / `premiumCoveringEvidence` / `finalizeDistille` の4キューをまとめた名称として使う。

## 目的

既存の `distillation_target_states` 中心の段階混在キューを廃止し、以下の4つの単機能キューへ一気に移行する。

- `findingCandidate`: source から candidate を作り続ける。担当は Azure OpenAI round-robin を含む設定依存。
- `coveringEvidence`: candidate を local-llm で評価し続ける。2回失敗した retryable job は premium へ昇格する。
- `premiumCoveringEvidence`: `coveringEvidence` と同等の評価を Cloud LLM / Azure OpenAI round-robin で実行する。
- `finalizeDistille`: evidence が集まった candidate を draft knowledge 化する。担当 provider や保存方針は設定依存。

この移行では互換レイヤーを厚くせず、旧 runner / 旧 queue API / 旧 Queue UI / 旧 automation を削除対象に含める。

## レビュー結果

初稿の評価は 7/10。方向性は妥当だったが、実装者が迷う箇所が残っていた。

改善した不足点:

- 既存 domain 関数が旧テーブルに依存している箇所の切り離し契約を追加した。
- 4キュー間の handoff contract と status transition を明文化した。
- migration / cutover / rollback の順序を、実DB操作として破綻しない粒度にした。
- API/UI が見る正規化 view model と、queue 別に出すべき情報を固定した。
- doctor / observability / live smoke の確認項目を追加した。

残すリスク:

- 旧 `distillation_target_states` を物理 drop するタイミングは、backup と Queue live smoke 成功後に限定する。
- Landscape manual approval のリンク張り替えは traceability を壊しやすいため、migration script に dry-run report を必須にする。

## 現状の問題

現行実装は `distillation_target_states` が source target、claim state、phase、retry、worker heartbeat、final outcome をすべて持っている。`runDistillationPipeline` は同じ target lease の中で `findCandidate -> coverEvidence -> finalizeDistille` を進め、さらに並列 find lane / cover lane / retryable paused / priority group / checkpoint pause を同じ状態機械で扱っている。

この構造では以下が起きやすい。

- `findCandidate` と `coverEvidence` の待ち理由が同じ target row に混ざる。
- `attempt_count` が target 全体の試行回数になり、candidate 単位の失敗回数と一致しない。
- `coverEvidence` を独立に回したいだけでも、旧 pipeline の phase と priority の影響を受ける。
- UI が「4つの実キュー」ではなく「1つの target state の現在 phase」を見ている。
- 修復時に result table と target state の両方を直す必要があり、運用ミスが起きやすい。

## 目標アーキテクチャ

新系統は「各キューは自分の入力を claim し、自分の出力を次キューへ enqueue する」だけにする。

```text
source inventory / register_candidate / landscape candidates
  -> finding_candidate_queue
  -> found_candidates
  -> covering_evidence_queue
  -> evidence_coverage_results
  -> finalize_distille_queue
  -> knowledge_items(draft)

covering_evidence_queue retryable failure x2
  -> premium_covering_evidence_queue
  -> evidence_coverage_results
  -> finalize_distille_queue
```

`findingCandidate` は常時稼働するが、input は2種類を許可する。

- `source_target`: wiki / vibe / websource のように LLM で candidate 抽出が必要なもの。
- `provided_candidate`: `register_candidate` や Landscape 由来のように、すでに candidate 本文があるもの。この場合は LLM 抽出をせず、正規化して `found_candidates` に保存し、`coveringEvidence` へ渡す。

## 設計決定

| 論点 | 決定 | 理由 |
|---|---|---|
| キュー分割 | 4キュー4テーブルにする | phase と retry が混ざる現行問題を根本的に消すため |
| candidate 保存 | `found_candidates` を中間 truth にする | cover/premium/finalize が同じ candidate identity を参照できるため |
| evidence 保存 | `evidence_coverage_results` を cover/premium 共通結果にする | premium 昇格後も finalize の入力 contract を変えないため |
| retry | `coveringEvidence` は retryable failure 2回で premium へ昇格 | local-llm の不安定さを Cloud LLM に逃がす境界を固定するため |
| worker lock | global pipeline file lock は廃止 | 4キューを独立に流し続ける目的と矛盾するため |
| old API compatibility | `/api/queue` のURLは維持し response を Queue 新契約へ更新 | UI とナビの接続点は保ち、内部契約は作り直すため |
| table drop | Queue smoke 成功後の final cleanup migration で実行 | rollback 可能性と「クリーニング仕切る」方針の両方を満たすため |

## Handoff Contract

| From | To | Trigger | Transaction に含める更新 |
|---|---|---|---|
| source inventory | `finding_candidate_queue` | inventory refresh / register / landscape candidate creation | queue upsert、source metadata merge、event append |
| `finding_candidate_queue` | `found_candidates` | candidate 抽出成功、または provided candidate 正規化成功 | found candidate insert、finding job complete、covering queue enqueue |
| `covering_evidence_queue` | `covering_evidence_queue` | retryable failure かつ attempt `< max_attempts` | result upsert、job pause/pending、next_run_at 更新、event append |
| `covering_evidence_queue` | `premium_covering_evidence_queue` | retryable failure かつ attempt `>= max_attempts` | result upsert、cover job complete/escalated、premium queue enqueue |
| `covering_evidence_queue` | terminal | duplicate / near_duplicate / insufficient | result upsert、cover job complete、event append |
| `covering_evidence_queue` | `finalize_distille_queue` | `knowledge_ready` | result upsert、cover job complete、finalize queue enqueue |
| `premium_covering_evidence_queue` | terminal | duplicate / near_duplicate / insufficient / retry exhausted | result upsert、premium job complete or failed、event append |
| `premium_covering_evidence_queue` | `finalize_distille_queue` | `knowledge_ready` | result upsert、premium job complete、finalize queue enqueue |
| `finalize_distille_queue` | `knowledge_items` | draft 保存成功 | knowledge upsert、source link upsert、finalize job complete |

## 新DBスキーマ

### 共通方針

- 4キューは別テーブルにする。
- 各キューは `pending | running | completed | failed | skipped | paused` を持つ。
- 各キューの `attempt_count` はそのキューだけの試行回数にする。
- worker lease は各 queue table の `locked_by`, `locked_at`, `heartbeat_at` で閉じる。
- queue handoff は transaction 内で行う。
- 重複 enqueue は unique key で止める。
- operational UI 用に `distillation_queue_events` を追加する。
- 全キューに `distillation_version`, `priority`, `metadata` を持たせる。
- `status`, `queue_name`, `producer_queue`, `input_kind`, `source_kind` は check constraint で固定する。

### `finding_candidate_queue`

主な列:

- `id`
- `input_kind`: `source_target | provided_candidate`
- `source_kind`: `wiki_file | vibe_memory | web_ingest | knowledge_candidate`
- `source_key`
- `source_uri`
- `distillation_version`
- `payload`
- `status`
- `priority`
- `attempt_count`
- `next_run_at`
- `locked_by`, `locked_at`, `heartbeat_at`
- `last_error`, `last_outcome_kind`
- `created_at`, `updated_at`, `completed_at`

unique key:

- `(input_kind, source_kind, source_key, distillation_version)`

### `found_candidates`

主な列:

- `id`
- `finding_job_id`
- `candidate_index`
- `type`
- `title`
- `content`
- `source_summary`
- `origin`
- `metadata`
- `created_at`, `updated_at`

unique key:

- `(finding_job_id, candidate_index)`

### `covering_evidence_queue`

主な列:

- `id`
- `found_candidate_id`
- `distillation_version`
- `status`
- `priority`
- `attempt_count`
- `max_attempts`: 初期値 `2`
- `provider_policy`: `local`
- `next_run_at`
- `locked_by`, `locked_at`, `heartbeat_at`
- `last_error`, `last_outcome_kind`
- `created_at`, `updated_at`, `completed_at`

unique key:

- `(found_candidate_id)`

### `premium_covering_evidence_queue`

主な列:

- `id`
- `found_candidate_id`
- `source_covering_job_id`
- `distillation_version`
- `status`
- `priority`
- `attempt_count`
- `provider_policy`: `cloud`
- `next_run_at`
- `locked_by`, `locked_at`, `heartbeat_at`
- `last_error`, `last_outcome_kind`
- `created_at`, `updated_at`, `completed_at`

unique key:

- `(found_candidate_id)`

### `evidence_coverage_results`

`coveringEvidence` と `premiumCoveringEvidence` の共通結果テーブルにする。どちらが作ったかは `producer_queue` と `producer_job_id` で追跡する。

主な列:

- `id`
- `found_candidate_id`
- `producer_queue`: `coveringEvidence | premiumCoveringEvidence`
- `producer_job_id`
- `distillation_version`
- `status`: `knowledge_ready | duplicate | near_duplicate | insufficient | parse_failed | tool_failed | provider_failed`
- `stage`
- `type`, `title`, `body`
- `importance`, `confidence`
- `applies_to`
- `references`, `duplicate_refs`, `tool_events`
- `reason`
- `metadata`
- `created_at`, `updated_at`

unique key:

- `(found_candidate_id, producer_queue)`

### `finalize_distille_queue`

主な列:

- `id`
- `evidence_result_id`
- `distillation_version`
- `status`
- `priority`
- `attempt_count`
- `provider_policy`: 設定依存
- `locked_by`, `locked_at`, `heartbeat_at`
- `last_error`, `last_outcome_kind`
- `knowledge_id`
- `created_at`, `updated_at`, `completed_at`

unique key:

- `(evidence_result_id)`

### `distillation_queue_events`

UI と doctor 用の軽量イベントログ。

主な列:

- `id`
- `queue_name`
- `queue_job_id`
- `event_type`
- `message`
- `metadata`
- `created_at`

## Status Transition

全キュー共通:

| Current | Event | Next | 条件 |
|---|---|---|---|
| `pending` | claim | `running` | lock 取得成功 |
| `paused` | retry due | `running` | `next_run_at <= now()` |
| `running` | success | `completed` | output handoff 成功 |
| `running` | terminal skip | `skipped` | 入力が消えた、または candidate なし |
| `running` | retryable failure | `paused` | max attempt 未満 |
| `running` | retry exhausted | `failed` | premium でも回復不能 |
| `running` | lease stale | `pending` | stale recovery が lock を解放 |

キュー別の終端:

| Queue | `completed` の意味 | `skipped` の意味 | `failed` の意味 |
|---|---|---|---|
| `findingCandidate` | `found_candidates` と cover queue を作成済み | source が存在しない、または candidate 0件 | 抽出が retry 上限まで失敗 |
| `coveringEvidence` | terminal result、finalize enqueue、または premium 昇格済み | candidate が削除済み | premium enqueue 前に queue 自体が破損 |
| `premiumCoveringEvidence` | terminal result または finalize enqueue 済み | candidate が削除済み | Cloud LLM でも retry 上限まで失敗 |
| `finalizeDistille` | draft knowledge 保存済み、または既存 knowledge 確認済み | evidence が `knowledge_ready` でない | 保存/embedding/link が retry 上限まで失敗 |

## Worker設計

### 共通 queue primitive

新規モジュールを追加する。

- `src/modules/queue/core/claim.ts`
- `src/modules/queue/core/state.ts`
- `src/modules/queue/core/events.ts`
- `src/modules/queue/core/types.ts`

claim は各テーブルで以下に統一する。

```sql
select id
from <queue_table>
where status in ('pending', 'paused')
  and (next_run_at is null or next_run_at <= now())
order by created_at asc, id asc
for update skip locked
limit 1
```

global pipeline lock は廃止する。必要なら per-queue advisory lock だけ使う。worker concurrency は queue ごとに設定し、ある queue の long-running job が他 queue の claim を止めないことを invariants にする。

### 既存 domain 関数の切り離し

現行の `runFindCandidate`, `runCoverEvidenceForCandidate`, `runFinalizeDistille` は、それぞれ旧テーブルを直接読む箇所を持つ。Queue では中身の prompt / parser / quality 判定は再利用し、DB identity 依存だけを剥がす。

| 現行依存 | Queue での変更 |
|---|---|
| `runFindCandidate` が `targetStateId` から `distillation_target_states` を読む | `FindCandidateSourceInput` を追加し、`source_kind`, `source_key`, `source_uri`, `payload` を直接受け取る。旧CLIが残る期間だけ adapter を置く |
| `findCandidateResults` repository が `distillation_target_states` join を返す | `found_candidates` repository に置換し、source lineage は `finding_candidate_queue` と `found_candidates.origin` から返す |
| `runCoverEvidenceForCandidate` が `find_candidate_results.id` を前提にする | `CoverEvidenceCandidateInput` を追加し、`found_candidate_id` から title/content/source summary/source lineage を読む |
| `coverEvidenceResults.id = findCandidateResults.id` の1:1主キー | `evidence_coverage_results.id` を独立IDにし、`found_candidate_id + producer_queue` unique で dedupe する |
| `runFinalizeDistille` が `coverEvidenceResultId` から旧 cover/find を辿る | `FinalizeEvidenceInput` を追加し、`evidence_coverage_results` と `found_candidates` から metadata/source trace を組み立てる |
| Landscape approval gate が旧 candidate id を見る | `landscape_review_item_candidate_links` に `found_candidate_id` / `finding_job_id` を追加するか、migration で旧IDから Queue ID への mapping table を作る |

この切り離しをせずに旧 row を adapter で偽装すると、旧状態機械が実行経路に残るため今回の目的に反する。

### `findingCandidate` worker

責務:

- source inventory を定期 refresh して `finding_candidate_queue` に upsert する。
- `source_target` は既存 `runFindCandidate` の抽出ロジックを再利用する。
- `provided_candidate` は LLM 抽出を省略し、`found_candidates` に正規化保存する。
- candidate が保存されたら `covering_evidence_queue` へ enqueue する。

provider:

- `taskRouting.findCandidate` を Queue 新契約に合わせて拡張し、source / vibe / provided の route を持たせる。
- Azure OpenAI は既存 deployment 設定を使い、provider pressure を provider+model+deployment 単位で記録する。

### `coveringEvidence` worker

責務:

- `covering_evidence_queue` を claim する。
- local-llm route で `runCoverEvidenceForCandidate` 相当を実行する。
- `knowledge_ready` なら `evidence_coverage_results` を保存し、`finalize_distille_queue` へ enqueue する。
- terminal rejection は job を `completed` にする。
- retryable failure は `attempt_count < 2` なら再queue、`attempt_count >= 2` なら `premium_covering_evidence_queue` に enqueue して自分は `completed/escalated_to_premium` にする。

provider:

- default は `local-llm`。
- fallback は原則なし。premium 昇格を fallback として扱う。

### `premiumCoveringEvidence` worker

責務:

- `premium_covering_evidence_queue` を claim する。
- Cloud LLM / Azure OpenAI round-robin route で `coveringEvidence` と同じ評価を実行する。
- `knowledge_ready` なら `evidence_coverage_results` を保存し、`finalize_distille_queue` へ enqueue する。
- terminal / retry exhausted は job を終端状態にする。

provider:

- `taskRouting.premiumCoveringEvidence` を追加する。
- Azure OpenAI deployment round-robin と provider pressure は `findingCandidate` と同じ基盤を使う。

### `finalizeDistille` worker

責務:

- `finalize_distille_queue` を claim する。
- `evidence_coverage_results.status = knowledge_ready` のものだけ `runFinalizeDistille` 相当で draft knowledge 化する。
- 既存の `cover-evidence-result://<id>` に相当する deterministic source URI を Queue result id で維持する。
- 既存 knowledge があれば再作成せず、link / metadata の補完だけ行う。
- landscape manual approval の gate は Queue の `found_candidate_id` から辿れる形に移す。

provider:

- `taskRouting.finalizeDistille` を維持しつつ、保存 status / scope / embedding behavior を `distillationRuntime.finalize` として明示する。

### Supervisor

`queue-supervisor` は4つの worker loop を同一 process で起動してよい。ただし、内部では queue ごとに独立した async loop にする。

最低限の loop:

```text
Promise.all([
  runQueueLoop("findingCandidate"),
  runQueueLoop("coveringEvidence"),
  runQueueLoop("premiumCoveringEvidence"),
  runQueueLoop("finalizeDistille"),
])
```

各 loop は `claim -> run -> handoff -> sleep only if idle` を守る。`findingCandidate` が provider cooldown でも、`coveringEvidence` と `finalizeDistille` は止めない。

## API/UI計画

### API

旧 `/api/queue` は Queue へ置き換える。互換は持たせない。

- `GET /api/queue/stats`: 4キュー別の status counters、oldest pending、running、failed、escalated を返す。
- `GET /api/queue/active`: 4キュー横断の running job を返す。
- `GET /api/queue?queue=<name>&status=<status>&query=<text>`: 選択中キューの一覧を返す。
- `POST /api/queue/:queue/:id/pause`
- `POST /api/queue/:queue/:id/resume`
- `POST /api/queue/:queue/:id/retry`

response は queue ごとに shape を分けすぎず、UI 用に以下へ正規化する。

- `queueName`
- `id`
- `status`
- `attemptCount`
- `subjectTitle`
- `subjectDetail`
- `provider`
- `model`
- `lastError`
- `lastOutcomeKind`
- `lockedBy`
- `heartbeatAt`
- `createdAt`
- `updatedAt`
- `completedAt`
- `nextRunAt`
- `metadataSummary`

queue 別 detail:

| Queue | `subjectTitle` | `subjectDetail` | 追加表示 |
|---|---|---|---|
| `findingCandidate` | source key/title | source kind + source uri | candidate count, input kind |
| `coveringEvidence` | candidate title | local provider/model + reason | found candidate id, evidence status |
| `premiumCoveringEvidence` | candidate title | cloud provider/model + reason | source covering job id, escalation reason |
| `finalizeDistille` | evidence title | draft knowledge id / embedding status | source reference count, source link count |

### UI

`web/src/modules/admin/components/queue.page.tsx` を Queue 前提で作り直す。

- 上部に4キューの counters を横並びで表示する。
- 本体は segmented control / tabs で `findingCandidate`, `coveringEvidence`, `premiumCoveringEvidence`, `finalizeDistille` を切り替える。
- 選択中キューだけ table を表示する。
- active worker panel は4キュー横断で表示する。
- filter は queue tab, status, query の3つに絞る。
- row detail は queue ごとに最小限を出す。
  - finding: source kind/key, candidate count
  - cover/premium: candidate title, evidence status, reason
  - finalize: evidence result, knowledge id, embedding status
- 旧 pipeline phase stepper は削除する。Queue では phase ではなく queue name が実行段階になる。
- テーブルは横スクロール可能にし、viewport 内で header / filters / pagination が見える密度にする。
- pause/resume/retry は icon button にし、tooltip と disabled reason を必ず出す。
- `premiumCoveringEvidence` tab では escalated count と local failure reason を上部 metric に出す。

## Settings計画

`RuntimeSettingsEditable.taskRouting` を以下へ拡張する。

- `findCandidate.source`
- `findCandidate.vibe`
- `findCandidate.provided`
- `coveringEvidence.local`
- `premiumCoveringEvidence.cloud`
- `finalizeDistille`

`distillationRuntime` を以下へ拡張する。

- `queuePollIntervalMs`
- `queueIdleSleepMs`
- `findingCandidateConcurrency`
- `coveringEvidenceConcurrency`
- `premiumCoveringEvidenceConcurrency`
- `finalizeDistilleConcurrency`
- `coveringEvidenceMaxAttempts`: default `2`
- `premiumCoveringEvidenceMaxAttempts`
- `queueStaleRunningSeconds`

既存の Azure OpenAI deployment 設定は再利用する。round-robin の cursor は DB に置き、worker process restart で偏らないようにする。

## Observability / Doctor

`doctor` と Queue UI は Queue table から同じ集計を使う。

必須 signal:

- queue 別 `pending`, `running`, `paused`, `failed`, `completed`, `skipped`
- queue 別 oldest pending age
- queue 別 stale running count
- queue 別 retryable paused count
- `coveringEvidence -> premiumCoveringEvidence` escalation count
- `premiumCoveringEvidence` recovery rate
- `finalizeDistille` draft created count
- provider/model/deployment ごとの cooldown state
- worker heartbeat age

critical:

- `running` が stale threshold を超え、かつ worker PID が生きていない。
- `coveringEvidence` pending があるのに local loop が一定時間 heartbeat を出していない。
- `finalizeDistille` pending が増え続け、draft 作成がない。

warning:

- premium escalation rate が高い。
- Azure OpenAI deployment の cooldown が全 deployment で継続している。
- old pipeline LaunchAgent がまだ loaded。

## 旧コード削除対象

削除または Queue 実装に置換する。

- `src/modules/distillationPipeline/runner.ts`
- `src/cli/distill-pipeline.ts`
- `src/cli/distill-pipeline-automation.ts`
- `scripts/automation/com.memory-router.distill-pipeline.plist`
- `scripts/automation/windows/com.memory-router.distill-pipeline.task.xml`
- `src/modules/selectDistillationTarget/repository.ts` の queue state / claim / repair 系
- `src/modules/selectDistillationTarget/repository-state-transitions.ts`
- `src/modules/selectDistillationTarget/repository-maintenance.ts`
- `src/cli/distillation-target.ts`
- `src/cli/distillation-progress.ts`
- `api/modules/queue/queue.repository.ts`
- `web/src/modules/admin/components/queue-telemetry-panel.tsx`
- `web/src/modules/admin/components/queue-registry-panel.tsx`
- 旧 pipeline / target state 前提の tests
- README / README.jp の旧 pipeline コマンド記述

再利用する。

- `src/modules/findCandidate/domain.ts`
- `src/modules/coverEvidence/domain.ts`
- `src/modules/coverEvidence/helpers.ts`
- `src/modules/coverEvidence/prompts.ts`
- `src/modules/finalizeDistille/domain.ts`
- `src/modules/distillation/*`
- `src/modules/settings/*`
- `src/modules/sources/web/*` の websource markdown 化
- `distillation_evidence_cache`

置換して残す可能性があるもの:

- `src/modules/selectDistillationTarget/inventory.service.ts`: source inventory upsert ロジックだけ `findingCandidate` enqueue 用に移植する。
- `src/modules/selectDistillationTarget/domain.ts`: target kind / sort key helper は Queue source kind helper として薄く残してよい。
- `src/modules/coverEvidence/reprocess-candidate.service.ts`: manual reprocess は Queue retry API に置き換える。

## 移行手順

### Phase 0: freeze と backup

1. `bun run automation:distill-pipeline -- unload` で旧 daemon を止める。
2. `scripts/backup-db.sh` でDB backup を作る。
3. `distillation_target_states`, `find_candidate_results`, `cover_evidence_results`, `knowledge_items` の Queue 移行前 counts を保存する。
4. `launchctl print` / Windows task status で旧 automation が停止していることを記録する。

### Phase 1: Queue schema

1. Drizzle schema と migration を追加する。
2. queue event / status enum / queue name enum を追加する。
3. Queue repository の claim / complete / fail / pause / resume を実装する。
4. 4キューそれぞれの repository test を追加する。

### Phase 2: stage workers

1. `findingCandidate` worker を実装する。
2. `coveringEvidence` worker を実装する。
3. `premiumCoveringEvidence` worker を実装する。
4. `finalizeDistille` worker を実装する。
5. 各 worker は単体で `--once --queue <name>` 実行できるようにする。

新CLI案:

```bash
bun run src/cli/queue.ts --queue findingCandidate --once
bun run src/cli/queue.ts --queue coveringEvidence --once
bun run src/cli/queue.ts --queue premiumCoveringEvidence --once
bun run src/cli/queue.ts --queue finalizeDistille --once
bun run src/cli/queue-supervisor.ts --continuous
```

### Phase 3: settings と automation

1. settings schema/default/runtime-cache/UI を Queue に拡張する。
2. Queue supervisor LaunchAgent を追加する。
3. 旧 LaunchAgent install/load/status コマンドを削除し、package scripts を Queue へ差し替える。
4. `doctor` の distillation domain を Queue stats に差し替える。

### Phase 4: API/UI

1. `/api/queue` repository を Queue tables へ差し替える。
2. Queue page を4キュー tab UI に作り直す。
3. active worker panel を queue-aware にする。
4. Playwright か component test で queue tab/filter/action を確認する。

### Phase 5: one-time migration

旧テーブルから Queue へ一回だけ移行する script を用意する。

script:

```bash
bun run src/cli/queue-migrate.ts --dry-run
bun run src/cli/queue-migrate.ts --write --backup
```

変換ルール:

- `distillation_target_states` に candidate がない source target は `finding_candidate_queue`。
- 既存 `find_candidate_results` で cover result がないものは `covering_evidence_queue`。
- retryable な旧 `cover_evidence_results` は、旧 target attempt が2未満なら `covering_evidence_queue`、2以上なら `premium_covering_evidence_queue`。
- `knowledge_ready` で未finalize の旧 `cover_evidence_results` は `evidence_coverage_results` と `finalize_distille_queue`。
- すでに finalized 済みのものは Queue result に history として残すか、移行対象外として archive する。

dry-run report:

- old rows by status/kind/phase
- migrated rows by Queue
- skipped rows and reason
- old id -> Queue id mapping count
- landscape approval link remap count
- would-drop table list

移行後に旧 runtime code を削除する。旧テーブルは Queue smoke 成功まで残し、final cleanup migration で drop する。今回「クリーニング仕切る」方針なので、同一ブランチ内で drop まで完了してよいが、backup artifact、dry-run report、Queue live smoke 成功を drop の前提条件にする。

### Phase 5.5: cutover gate

旧コード削除へ進む前に以下を満たす。

1. 旧 daemon unloaded。
2. Queue migration dry-run と write が成功。
3. Queue supervisor `--once` で4キューがそれぞれ claim 可能。
4. Queue UI が Queue API だけを読んでいる。
5. `rg "runDistillationPipeline|distillation_target_states|distill-target:|distill:pipeline"` の残存が migration/docs/history-only に限定されている。

### Phase 6: legacy cleanup

1. package scripts から `distill:pipeline`, `distill-target`, `distill-progress` を削除または Queue 名に置換する。
2. README / README.jp の Queue / distillation 説明を Queue に更新する。
3. 旧 tests を削除し、Queue worker/repository/API/UI tests に置換する。
4. `rg "distillation_target_states|distill:pipeline|selectDistillationTarget|cover_evidence_checkpoint|priorityGroup"` で残存参照を確認し、必要な history-only 参照以外を消す。
5. final cleanup migration で旧 queue tables を drop する。

## Rollback方針

rollback は「旧コードへ戻す」ではなく、cutover 前後で手順を分ける。

| タイミング | rollback |
|---|---|
| Queue schema 追加後、cutover 前 | Queue worker を止め、旧 daemon を再load。新テーブルは残してよい |
| migration write 後、旧 table drop 前 | backup から旧3テーブルを復元し、旧 daemon を再load |
| 旧 table drop 後 | DB backup restore が必要。ここまで進む条件は live smoke 成功後に限定する |

rollback 用に、migration script は old id -> Queue id mapping を JSON backup に残す。

## 検証計画

必須:

```bash
bun run db:migrate
bun test test/queue*.test.ts
bun test test/queue.routes.test.ts
bun test test/components/admin/queue-page.test.tsx
bun run typecheck
bun run lint
bun run verify
```

test matrix:

| 領域 | 必須ケース |
|---|---|
| repository | claim skip locked、pause/resume、stale recovery、unique enqueue |
| findingCandidate | source target 抽出、provided candidate 正規化、candidate 0件 skip |
| coveringEvidence | ready -> finalize enqueue、terminal rejection、retry 1回目、2回失敗 premium 昇格 |
| premiumCoveringEvidence | ready -> finalize enqueue、terminal rejection、retry exhausted failed |
| finalizeDistille | draft create、existing knowledge dedupe、embedding unavailable、landscape approval required |
| API | 4キュー stats、tab filter、pause/resume/retry、active worker |
| UI | 4 tabs、status counters、row action disabled reason、premium escalation display |
| migration | dry-run counts、write idempotency、old->new mapping、already finalized skip |

live smoke:

1. 旧 daemon が止まっていることを確認する。
2. Queue supervisor を load する。
3. テスト source を1件 enqueue する。
4. `finding_candidate_queue -> covering_evidence_queue -> finalize_distille_queue` の順に row が進むことをDBで確認する。
5. local-llm 失敗を2回作って `premium_covering_evidence_queue` へ昇格することを確認する。
6. Queue UI で4キューを切り替えて status/count/action が見えることを確認する。
7. `knowledge_items.status = draft` の作成と metadata source trace を確認する。
8. `doctor` が old daemon loaded warning を出さず、Queue health を返すことを確認する。
9. Queue supervisor restart 後も round-robin cursor と stale recovery が破綻しないことを確認する。

## 完了条件

- 4つの queue table だけが distillation 実行経路になっている。
- 旧 `distillation_target_states` state machine に依存する worker が残っていない。
- `coveringEvidence` の2回失敗後 premium 昇格が unit/integration test で保証されている。
- `finalizeDistille` は duplicate execution でも knowledge を二重作成しない。
- Queue UI は4キューを切り替えて監視できる。
- old LaunchAgent / package scripts / README 記述が Queue に置換されている。
- live smoke で daemon、DB row、UI、draft knowledge 作成まで確認済み。

## 実装順の推奨

最初のPRで分割しすぎると旧系統との二重運用期間が長くなるため、この作業は1本の大きな移行ブランチで進める。ただし作業内部の checkpoint は以下で区切る。

1. schema + repositories
2. workers + CLI
3. settings + automation
4. API + UI
5. migration + legacy deletion
6. docs + full verification

この順なら、旧コードを最後まで温存しつつ Queue を先に完成させ、移行 script と deletion を同じ流れで閉じられる。
