# selectDistillationTarget ドメイン実装計画

作成日: 2026-05-19

## 目的

新しい蒸留処理で、次に処理する対象を安定して選ぶ専用ドメインを作る。

優先順位は次の通りに固定する。

1. 未蒸留の Wiki file を優先する。
2. Wiki file がすべて蒸留済み、または処理可能な Wiki file がない場合だけ vibe memory を対象にする。
3. Wiki file の順序は、`wiki/pages` からの相対 path のアルファベット順にする。

このドメインは候補抽出を行わない。`findCandidate` は、選ばれた入力から候補を出す責務に閉じ込める。

## ドメイン境界

`selectDistillationTarget` が持つ責務:

- Wiki file と vibe memory の target inventory を作る。
- target の蒸留状態を保存する。
- 優先順位に従って次の target を claim する。
- 実行中 target の lock / heartbeat / stale reclaim を管理する。
- target の最終結果を `completed` / `skipped` / `failed` として確定する。

`selectDistillationTarget` が持たない責務:

- Markdown 読み込みと圧縮。
- vibe memory の圧縮。
- LLM candidate 抽出。
- evidence 補強。
- knowledge 作成。
- embedding 生成。

責務分割:

- `selectDistillationTarget`: 次の対象選択と進捗保存。
- `readFile`: Wiki file を token window で読む。
- `memoryReader`: vibe memory を圧縮または原文で読む。
- `findCandidate`: 入力から candidate を抽出する。
- `coverEvidence`: candidate の根拠を補強する。
- `finalizeDistille`: candidate を保存可能な knowledge に確定する。
- runner / worker: 上記ドメインを順番に呼び、成功・失敗を `selectDistillationTarget` に戻す。

## 対象単位

Wiki は旧実装の `source_fragments` ではなく、まず file 単位で扱う。

理由:

- `readFile` ドメインが file path と token window を前提にしている。
- Wiki はユーザーが有用なルールやベストプラクティスとして整理しているため、fragment の古い import 状態より file path を source of truth にした方が分かりやすい。
- どの file が蒸留済みかを直接見られる。

target kind:

- `wiki_file`
- `vibe_memory`

target key:

- `wiki_file`: `wiki/pages` からの相対 path。例: `best-practice/hono_backend.md`
- `vibe_memory`: `vibe_memories.id`

input hash:

- `wiki_file`: file content の sha256。
- `vibe_memory`: `vibe_memories.content` と紐づく `agent_diff_entries.diff_hunk` を安定順で連結した sha256。

同じ target key でも input hash が変わった場合は、再蒸留対象として扱う。

## 状態管理

単純な boolean `distilled` ではなく、状態として保存する。

推奨テーブル: `distillation_target_states`

主要カラム:

- `id`
- `target_kind`: `wiki_file` / `vibe_memory`
- `target_key`
- `source_uri`
- `input_hash`
- `distillation_version`
- `status`: `pending` / `running` / `completed` / `skipped` / `failed` / `paused`
- `phase`: `selected` / `reading` / `finding_candidate` / `covering_evidence` / `finalizing` / `stored`
- `priority_group`: `wiki` / `vibe_memory`
- `sort_key`
- `attempt_count`
- `locked_by`
- `locked_at`
- `heartbeat_at`
- `last_error`
- `last_outcome_kind`
- `candidate_count`
- `knowledge_ids`
- `metadata`
- `created_at`
- `updated_at`
- `completed_at`

unique 制約:

- `(target_kind, target_key, input_hash, distillation_version)`

`distillation_version` は、蒸留ロジックが大きく変わったときに全 target を再対象化するために使う。

## 選択ルール

`selectNextTarget()` は次の順序で claim する。

1. `status in ('pending', 'paused')` かつ実行可能な Wiki file。
2. Wiki file がなければ、`status in ('pending', 'paused')` の vibe memory。

Wiki file の order:

1. `sort_key asc`
2. `created_at asc`
3. `id asc`

`sort_key` は `wiki/pages` からの相対 path を lower case にした値にする。

vibe memory の order:

1. `created_at asc`
2. `id asc`

当面は vibe memory をサイズ順にしない。Wiki が尽きた後の fallback なので、まず時系列で処理する方が挙動を説明しやすい。

claim は DB transaction 内で行う。

- 対象行を `for update skip locked` 相当で取得する。
- `status='running'`、`phase='selected'`、`locked_by`、`locked_at`、`heartbeat_at` を更新する。
- claim 後に runner が処理する。

stale reclaim:

- `running` のまま `heartbeat_at` が一定時間古い target は、次回 inventory refresh または select 時に `pending` へ戻す。
- `attempt_count` が上限を超えた target は `failed` にする。

## Inventory refresh

runner の開始時と no-target sleep 後に inventory を refresh する。

Wiki refresh:

1. `wiki/pages/**/*.md` を再帰的に列挙する。
2. 空 file は target にしない。
3. content hash を計算する。
4. `(wiki_file, relativePath, inputHash, distillationVersion)` がなければ `pending` で upsert する。
5. 既に同じ path の古い input hash が `completed` でも、file が変わっていれば新しい input hash は `pending` になる。

vibe memory refresh:

1. `vibe_memories` を対象にする。
2. 紐づく `agent_diff_entries` を安定順で含めて input hash を計算する。
3. まだ state がなければ `pending` で upsert する。

削除済み Wiki file:

- 既存 target を消さず、metadata に `missing: true` を付けて `skipped` にする。
- audit で追えるように物理削除はしない。

## 連続実行ループ

新しい runner は、1 target の結果を確実に保存してから次 target を claim する。

処理順:

1. `refreshInventory()`
2. `selectNextTarget()`
3. target がなければ sleep して 1 に戻る。
4. target を読む。
   - `wiki_file`: `readFile`
   - `vibe_memory`: `memoryReader`
5. `findCandidate` を呼ぶ。
6. LLM 応答を受け取ったら raw response / parse result / candidate count を保存する。
7. candidate がなければ `skipped(no_candidate)` を保存して 1 に戻る。
8. candidate があれば `coverEvidence` を呼ぶ。
9. evidence 結果を保存する。
10. `finalizeDistille` を呼ぶ。
11. knowledge 保存と embedding 生成を完了させる。
12. knowledge ID と最終 outcome を `distillation_target_states` に保存する。
13. `completed` または `skipped` として確定して 1 に戻る。

重要な不変条件:

- localLLM の応答を受け取る前に target を完了扱いにしない。
- embedding が必要な knowledge は、embedding の保存まで完了してから target を `completed` にする。
- LLM response / candidate / evidence / knowledge の保存が失敗した場合は、target を `completed` にしない。
- target の最終状態更新は、保存済み knowledge ID と同じ transaction、または transaction 後に失敗しても再実行で重複しない idempotency key を使って行う。

## 失敗処理

失敗は `failed` に直行させず、種類ごとに扱う。

- `llm_timeout`: `paused` にして retry。
- `llm_provider_error`: `paused` にして retry。
- `embedding_error`: `paused` にして retry。knowledge が未完成なら completed にしない。
- `invalid_candidate`: target は `skipped` にできるが、candidate rejection は metadata に残す。
- `no_candidate`: 正常な `skipped`。
- `read_error`: file missing なら `skipped(missing_source)`、一時的 I/O なら `paused`。

retry delay は最初は定数でよい。指数 backoff は最初から入れない。

## Audit / Doctor

最低限保存する audit:

- target inventory refreshed
- target claimed
- target phase changed
- localLLM call started / completed / failed
- embedding started / completed / failed
- target completed / skipped / failed

Doctor で出す項目:

- pending Wiki count
- pending vibe memory count
- running target
- stale running count
- last completed target
- last error
- Wiki が尽きて vibe memory に移行しているか

## 状態確認とリカバリー

新しい蒸留では、target の現在状態を `distillation_target_states` で確認できるようにする。

状態の意味:

- `pending`: まだ処理されていない。次回 selection の候補。
- `running`: worker が claim 済み。`heartbeat_at` が更新されている間は正常に処理中。
- `paused`: 一時エラーにより再試行待ち。`nextRetryAt` 相当の値は metadata または将来カラムで持つ。
- `completed`: knowledge 保存と必要な embedding 保存まで完了済み。
- `skipped`: 正常に処理したが knowledge 化しない。例: `no_candidate`, `missing_source`, `invalid_candidate`。
- `failed`: retry 上限を超えた、または人間の介入が必要な失敗。

phase の意味:

- `selected`: target を claim した直後。
- `reading`: `readFile` または `memoryReader` で入力を読んでいる。
- `finding_candidate`: localLLM で candidate 抽出中、または抽出結果保存中。
- `covering_evidence`: evidence 補強中。
- `finalizing`: knowledge 化、embedding、source link 保存中。
- `stored`: 最終保存は完了し、target 完了更新の直前または直後。

通常確認 CLI:

- `bun run select-target:smoke`
  - DB の persisted status を参照しつつ、現時点で次に選ばれる target だけを pretty JSON で表示する。
  - inventory upsert や claim は行わない。
  - Wiki pending がある場合は Wiki file を返す。
  - Wiki がなければ vibe memory を返す。
- `bun run select-target:smoke -- --from-state-table`
  - 既に refresh 済みの `distillation_target_states` だけを見て次の target を返す。

状態確認 CLI:

- `bun run distill-target:refresh`
  - Wiki / vibe memory inventory を `distillation_target_states` に upsert する。
- `bun run distill-target:status`
  - 現在の Queue 状態を表示する。
  - `queued` は `pendingWiki + pendingVibeMemory`。
  - `mode` が `wiki_first` なら Wiki がまだ残っている。
  - `mode` が `vibe_memory_fallback` なら Wiki が尽きて vibe memory 側へ移っている。
- `bun run distill-target -- claim`
  - stale running と retry 可能な paused を処理してから、次の target を `running` として claim する。
  - runner から使うための低レベル確認コマンドであり、手動実行後は完了・skip・requeue のいずれかで閉じる。
- `bun run distill-target -- heartbeat --id <target-state-id>`
  - running target の `heartbeat_at` を更新する。

Doctor に追加する確認:

- pending Wiki count
- pending vibe memory count
- running count
- paused count
- stale running count
- failed count
- last completed target
- last skipped reason
- last failed target と `last_error`
- current mode: `wiki_first` / `vibe_memory_fallback`

詰まり判定:

- `running` だが `heartbeat_at` が stale threshold より古い。
- `paused` が多く、retry 予定時刻を過ぎても処理されていない。
- `failed` が増え続ける。
- Wiki pending があるのに vibe memory が選ばれている。
- `finding_candidate` で止まっている場合は localLLM 側、`finalizing` で止まっている場合は knowledge / embedding 側を疑う。

自動リカバリー:

1. stale running を検出したら `pending` へ戻し、`attempt_count` を増やす。
2. `attempt_count` が上限未満なら再選択可能にする。
3. 上限を超えたら `failed` にし、`last_error` と `last_outcome_kind` を保存する。
4. `paused` は retry delay 経過後に `pending` へ戻す。
5. missing Wiki file は retry せず `skipped(missing_source)` にする。

手動リカバリー CLI:

- `distill-target:release-stale`: stale running を pending に戻す。
- `bun run distill-target -- release-paused`: retry 時刻を過ぎた paused target を pending に戻す。
- `bun run distill-target -- requeue --id <target-state-id> --reason <reason>`: failed / skipped / paused / running target を pending に戻す。
- `bun run distill-target -- pause --id <target-state-id> --reason <reason>`: 問題 target を明示的に paused にする。
- `bun run distill-target -- mark-skipped --id <target-state-id> --reason <reason>`: 人間判断で skip する。

手動リカバリー時の原則:

- `completed` target は、input hash または distillation version が変わらない限り再実行しない。
- `running` target を手動で戻す前に heartbeat を確認する。
- localLLM / embedding の結果保存が途中の場合、knowledge の duplicate key / idempotency key を確認してから requeue する。
- requeue は audit に必ず残す。

## 実装フェーズ

### Phase 1: ドメイン骨格と状態テーブル

実装済み:

- `src/modules/selectDistillationTarget/domain.ts`
- `src/modules/selectDistillationTarget/repository.ts`
- `src/modules/selectDistillationTarget/inventory.service.ts`
- `drizzle/0019_distillation_target_states.sql`

完了条件:

- Wiki file inventory を作れる。
- vibe memory inventory を作れる。
- `selectNextTarget()` が Wiki を優先し、Wiki が尽きたら vibe memory を返す。
- claim / heartbeat / release / complete / skip / fail ができる。

### Phase 2: smoke CLI

実装済み:

- `src/cli/select-distillation-target-smoke.ts`
- `package.json` script: `select-target:smoke`
- `src/cli/distillation-target.ts`
- `package.json` scripts:
  - `distill-target`
  - `distill-target:status`
  - `distill-target:refresh`
  - `distill-target:release-stale`

確認内容:

- Wiki pending がある場合は alphabet order の最初の Wiki file を返す。
- Wiki が全部 completed の場合だけ vibe memory を返す。
- completed target は再選択されない。
- input hash が変わると pending として再選択される。

### Phase 3: runner skeleton

追加予定:

- `src/cli/distill-loop.ts`
- `src/modules/distillation-loop/runner.service.ts`

この段階では LLM を呼ばず、target claim から phase 更新、skip までの dry run を作る。

完了条件:

- no target のとき sleep する。
- 1 target の状態確定後に次 target を claim する。
- Ctrl-C / SIGTERM で running target を安全に release または heartbeat 停止できる。

### Phase 4: findCandidate 接続

追加予定:

- `selectDistillationTarget` で claim した target を `readFile` / `memoryReader` に渡す adapter。
- `findCandidate` を呼ぶ runner step。
- LLM raw response と parsed candidate を保存する minimum store。

完了条件:

- localLLM の結果を受け取り、candidate 保存に成功してから次 phase へ進む。
- no candidate は target を `skipped(no_candidate)` にする。

### Phase 5: coverEvidence / finalizeDistille 接続

追加予定:

- `coverEvidence` step。
- `finalizeDistille` step。
- knowledge 保存と embedding 保存の完了確認。

完了条件:

- knowledge ID が保存された target だけ `completed` になる。
- embedding failure では `completed` にしない。
- 同じ target を retry しても duplicate knowledge を作らない。

### Phase 6: 常駐運用

追加予定:

- launchd / worker 設定。
- Doctor inspector。
- Audit UI または existing audit への表示。

完了条件:

- Wiki pending がある間は Wiki だけを処理する。
- Wiki がなくなったら vibe memory を処理する。
- localLLM / embedding の処理完了と保存完了を待ってから次 target に進む。
- no target のときだけ sleep し、target があれば絶え間なく処理を続ける。

## 最初に避けること

- `findCandidate` に target selection を入れない。
- LLM に「どの file を処理するか」を選ばせない。
- Wiki の有用度を正規表現や keyword prefilter で選別しない。
- 完了状態を boolean だけにしない。
- localLLM 応答前、embedding 保存前に completed にしない。
- 旧 `source_distillation_runs` の成功/失敗だけを新ロジックの進捗判定に使わない。

## 推奨する最小初期動作

最初の実装は単一 worker / 単一 target 処理でよい。

複数並列、優先度スコア、複雑な retry、UI での手動 requeue は後回しにする。

まずは次を確実に満たす。

1. Wiki file を alphabet order で全部処理する。
2. Wiki が尽きたら vibe memory に移る。
3. 各 target の状態が DB に残る。
4. LLM / embedding / storage の完了順序が壊れない。
5. crash しても stale target を再開できる。
