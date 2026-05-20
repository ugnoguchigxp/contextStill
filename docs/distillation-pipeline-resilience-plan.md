# Distillation Pipeline Resilience 実装計画

作成日: 2026-05-20
レビュー更新日: 2026-05-20
実装更新日: 2026-05-20
対象リポジトリ: `memory-router`

## 実装状況

2026-05-20 時点で、この計画の Stage 1 から Stage 9 は実装済み。

- candidate cap は削除済み。候補数は truncate せず、reader/tool/token/deadline で制御する。
- `importance <= 50` は `lowImportanceRejectThreshold` で reject し、`coverEvidence` と `finalizeDistille` の両方で保存を防ぐ。
- source-only 候補も LLM value gate を通す。
- target lease fencing、10 分 target timeout、retry 上限時 skip、resume/checkpoint を実装済み。
- pipeline lock は target 処理単位で取得し、作成時刻から 11 分超過で削除できる。
- LaunchAgent は `run-continuous` + `KeepAlive` に更新済み。
- `doctor` は queue 停止、stale running、stale lock、higher-priority queue blocking を構造化して報告する。

## レビュー結果

この計画は、現行コードを確認したうえで実装に移れる粒度まで詰めた版である。

初版から修正した重要点:

- `distillationMaxCandidates` / `distillationTools.maxCandidates` は削除し、候補数 cap は置かない。
- 候補は多く抽出し、後段の LLM 重要度判定で knowledge 化可否を決める。
- `importance <= 50` は knowledge 化しない。閾値は定数化する。
- source-only 候補も heuristic だけで保存せず、LLM value gate を通す。
- target timeout は 10 分、pipeline lock stale は作成時刻から 11 分とする。
- stale lock 削除後に古い worker が書き戻さないよう、target lease fencing を入れる。
- continuous worker は process 生存中ずっと file lock を保持しない。lock は target 処理単位で取得・解放する。
- retry / resume は既存 `find_candidate_results` と `cover_evidence_results` を再利用する。
- doctor に queue 停止検知を追加する。

## 目的

`distill-pipeline` を常時回し、1 target、stale lock、LLM/tool timeout、retry 対象の candidate が queue 全体を止めない状態にする。

最終状態:

- backlog がある限り、target 間の空き時間を最小化して処理し続ける。
- 1 target は最大 10 分で必ず `completed`、`skipped`、または `paused` に遷移する。
- pipeline lock は作成時刻から 11 分を超えたら stale とみなし、次の処理を止めない。
- 古い worker が timeout / stale recovery 後に target を上書きできない。
- retry は有限で、同じ target が無限に queue を塞がない。
- retry は既存の候補抽出・evidence 判定結果を再利用する。
- doctor が queue 停止、stale running、stale lock、knowledge 未増加を検知する。

## 実装前に確認したコード上の前提

主な現行実装:

- pipeline entrypoint: `src/cli/distill-pipeline.ts`
- pipeline runner: `src/modules/distillationPipeline/runner.ts`
- target state repository: `src/modules/selectDistillationTarget/repository.ts`
- candidate extraction: `src/modules/findCandidate/domain.ts`
- evidence coverage: `src/modules/coverEvidence/domain.ts`
- finalizer: `src/modules/finalizeDistille/domain.ts`
- distillation runtime: `src/modules/distillation/distillation-runtime.service.ts`
- file lock: `src/cli/file-lock.ts`
- doctor distillation inspector: `src/modules/doctor/inspectors/distillation-run.inspector.ts`
- LaunchAgent template: `scripts/automation/com.memory-router.distill-pipeline.plist`

実装前に確認した問題:

- `findCandidate` は `distillationTools.maxCandidates` を参照しているが、実装は `Math.max(32, ...)` なので設定値 `2` は実質効いていない。
- `coverEvidence` は candidate を逐次処理するため、候補が多い target は長時間 `running` になる。
- `distill-pipeline` は file lock を CLI 実行全体で保持する。
- `updateDistillationTargetPhase()` / `finishDistillationTargetState()` などは target id だけで更新でき、古い worker の書き戻しを防げない。
- source-only 候補は `inferImportance()` の heuristic 値で `knowledge_ready` になり得る。
- LaunchAgent は `StartInterval=120` の `run-once` 実行で、backlog がある時も interval 待ちが発生する。

## 定数方針

`src/constants.ts` に次を追加・整理する。

```ts
distillationTargetTimeoutMs: 600_000,
distillationTargetStaleSeconds: 660,
distillationPipelineLockStaleSeconds: 660,
distillationLowImportanceRejectThreshold: 50,
distillationContinuousIdleSleepMs: 15_000,
distillationContinuousErrorSleepMs: 60_000,
distillationInventoryRefreshIntervalMs: 300_000,
```

削除する定数・config:

- `distillationMaxCandidates`
- `GroupedConfig.distillationTools.maxCandidates`

置換する定数・config:

- `distillationMinCandidateImportance` は削除し、`distillationLowImportanceRejectThreshold` に置き換える。

`src/config.types.ts` と `src/config.ts` も同じ構造へ更新する。

## 実装ステージ

### Stage 1: candidate cap 削除

対象:

- `src/constants.ts`
- `src/config.ts`
- `src/config.types.ts`
- `src/modules/findCandidate/domain.ts`
- `test/find-candidate.test.ts`

作業:

- `distillationMaxCandidates` を削除する。
- `GroupedConfig.distillationTools.maxCandidates` を削除する。
- `desiredCandidateLimit()` を削除する。
- `candidates = candidates.slice(0, candidateLimit)` を削除する。
- 候補数は `maxTokens`、reader read limit、target timeout で制御する。

受け入れ条件:

- `rg "distillationMaxCandidates|maxCandidates|minCandidateImportance"` で旧設定参照が残らない。
- `findCandidate` が 3 件以上の候補を返しても truncate されない unit test がある。

### Stage 2: LLM value gate と低重要度 rejection

対象:

- `src/modules/coverEvidence/domain.ts`
- `src/modules/finalizeDistille/domain.ts`
- `src/modules/coverEvidence/types.ts`
- `src/constants.ts`
- `test/cover-evidence.test.ts`
- `test/finalize-distille.test.ts`

方針:

候補は `findCandidate` で多く残す。knowledge 化の入口は `coverEvidence` の value gate に寄せる。

`coverEvidence` に `runValueAssessment()` を追加する。

入力:

```ts
type ValueAssessmentInput = {
  candidate: CoverEvidenceCandidate;
  sourceReferences: CoverEvidenceReference[];
  sourceContentExcerpt: string;
  provider: DistillationProviderSetting;
  model: string;
  signal?: AbortSignal;
};
```

LLM 出力:

```json
{
  "status": "knowledge_ready",
  "candidate": {
    "type": "rule",
    "title": "...",
    "body": "...",
    "importance": 72,
    "confidence": 80
  },
  "reason": null
}
```

許容 status:

- `knowledge_ready`
- `insufficient`

判定:

- `importance <= groupedConfig.distillation.lowImportanceRejectThreshold` は `insufficient` にする。
- reason は `low_importance` にする。
- `low_importance` は retry しない terminal rejection とする。
- `coverEvidence` の status enum は増やさない。既存の `insufficient` を使う。

source-only 候補:

- `source_support` と dedupe を通ったあと、必ず `runValueAssessment()` を通す。
- heuristic の `inferImportance()` は LLM value gate に渡す初期値としてのみ使う。
- LLM value gate が parse / provider failure の場合は retryable result にする。

external evidence 候補:

- `runExternalEvidence()` の LLM 出力にも同じ threshold を適用する。
- `fetch_content` 成功なしで `knowledge_ready` になった場合は既存通り `external_fetch_evidence_missing` にする。

finalizer guard:

- `runFinalizeDistille()` は `result.candidate.importance <= threshold` の場合、knowledge を保存せず `rejected` を返す。
- reason は `low_importance`。
- これにより古い `cover_evidence_results` からの低重要度保存も防ぐ。

受け入れ条件:

- `importance=50` の `coverEvidence` result は `insufficient / low_importance` になる。
- `importance=51` は他 gate を満たせば `knowledge_ready` になれる。
- `finalizeDistille` は `importance=50` を保存しない。
- source-only 候補でも LLM value gate が呼ばれる。

### Stage 3: target lease fencing

対象:

- `src/modules/selectDistillationTarget/repository.ts`
- `src/modules/distillationPipeline/runner.ts`
- `test/distillation-pipeline.test.ts`
- `test/repositories.integration.test.ts`

目的:

stale lock 削除、timeout、stale running recovery の後に、古い worker が同じ target を `completed` や `paused` に上書きしないようにする。

現行 schema には `lockedBy`、`lockedAt`、`heartbeatAt` があるため migration は不要。

追加する概念:

```ts
type TargetLease = {
  targetStateId: string;
  lockedBy: string;
  attemptCount: number;
};
```

`claimNextDistillationTargetState()` が返した row から lease を作る。

repository API 変更:

```ts
updateDistillationTargetPhase({ id, phase, lease })
updateDistillationTargetHeartbeat(id, lease)
finishDistillationTargetState({ id, ..., lease })
pauseDistillationTargetState({ id, ..., lease })
skipDistillationTargetState({ id, ..., lease })
```

更新条件:

```sql
where id = $id
  and status = 'running'
  and locked_by = $lease.lockedBy
  and attempt_count = $lease.attemptCount
```

例外:

- manual requeue
- stale recovery
- inventory refresh

lease mismatch 時:

- throw せず、runner には `lease_lost` として返す。
- target は古い worker からは変更しない。
- runner result は `skipped` 扱いではなく `lost` 相当の内部結果にする。公開 status に新 enum を足さず、pipeline result の `outcomeKind` を `lease_lost` にする。

受け入れ条件:

- lease が一致しない `finishDistillationTargetState()` は target を更新しない。
- stale recovery 後に古い worker が完了を書いても completed にならない。
- 現行 DB schema のまま実装できる。

### Stage 4: target-level 10 分 deadline

対象:

- `src/modules/distillationPipeline/runner.ts`
- `src/modules/findCandidate/domain.ts`
- `src/modules/coverEvidence/domain.ts`
- `src/modules/finalizeDistille/domain.ts`
- `src/modules/distillation/distillation-runtime.service.ts`
- `test/distillation-pipeline.test.ts`

作業:

- `runClaimedTarget()` の開始時に `AbortController` を作る。
- timeout は `groupedConfig.distillation.targetTimeoutMs`。
- deadline context を下流へ渡す。

推奨型:

```ts
type DistillationExecutionContext = {
  lease: TargetLease;
  signal: AbortSignal;
  startedAt: Date;
  deadlineAt: Date;
};
```

`runDistillationCompletion()` の変更:

- `DistillationRuntimeOptions` に `signal?: AbortSignal` を追加する。
- `DistillationChatRequest` に `signal?: AbortSignal` を追加する。
- `withRequestTimeout(timeoutMs, task, parentSignal?)` に変更する。
- provider fetch は request timeout と parent signal のどちらでも abort できるようにする。
- loop の各 chat call 前、tool call 前後で `throwIfAborted()` を呼ぶ。

tool executor:

- 初期実装では executor signature は変えない。
- `search_web` / `fetch_content` は既に短い timeout を持つため、tool call 前後の signal check で十分とする。
- 将来必要なら executor に signal を渡す。

timeout 時の target 遷移:

- current attempt が retry 上限未満: `paused`
- reason: `target_timeout`
- `nextRetryAt`: retry delay
- metadata: `timedOutAt`, `timeoutMs`, `phase`, `attemptCount`
- current attempt が retry 上限以上: `skipped`
- outcomeKind: `target_timeout_retry_limit_exceeded`

注意:

- `attemptCount` は claim 時に増える値を正とする。
- timeout handling では attemptCount を追加で増やさない。
- stale recovery でも attemptCount を不用意に二重加算しないよう見直す。

受け入れ条件:

- slow `coverEvidence` を短縮 timeout で動かす test で、target が `running` のまま残らない。
- timeout 後に runner が次 target を処理できる。
- abort 後の古い処理が lease fencing で書き戻せない。

### Stage 5: retry / skip policy

対象:

- `src/modules/distillationPipeline/runner.ts`
- `src/modules/selectDistillationTarget/repository.ts`
- `src/modules/coverEvidence/runner.ts`
- `test/distillation-pipeline.test.ts`

retryable:

- `parse_failed`
- `tool_failed`
- `provider_failed`
- `target_timeout`

terminal:

- `duplicate`
- `near_duplicate`
- `insufficient`
- `low_importance`
- `no_candidate`
- `all_rejected`

policy:

- retryable があり、ready が 0 件なら `paused`。
- ready が 1 件以上あれば ready を finalize し、retryable は metadata に残して target は `completed` にしてよい。
- retry 上限を超えた timeout / retryable failure は `skipped`。
- `failed` は DB 不整合や finalizer の予期しない保存失敗など、人間の確認が必要なものに限定する。

受け入れ条件:

- retryable only は `paused`。
- retryable + ready は `completed`。
- retry 上限超過は `skipped`。
- `skipped` target があっても次 target が claim される。

### Stage 6: resume / checkpoint

対象:

- `src/modules/distillationPipeline/runner.ts`
- `src/modules/findCandidate/repository.ts`
- `src/modules/coverEvidence/repository.ts`
- `src/modules/finalizeDistille/domain.ts`
- `test/distillation-pipeline.test.ts`

追加 repository API:

```ts
listFindCandidateResultsByTargetStateId(targetStateId: string): Promise<FindCandidateResultRow[]>
listCoverEvidenceResultsByTargetStateId(targetStateId: string): Promise<CoverEvidenceResultRow[]>
```

resume rules:

- target に `find_candidate_results` が 1 件以上あれば、`findCandidate` を再実行しない。
- candidate に `cover_evidence_results` があれば既存結果を使う。
- terminal result は再処理しない。
- retryable result は retry 到達時、または `--force-refresh-evidence` の時だけ再処理する。
- `finalizeDistille` は既存 `cover-evidence-result://<id>` source URI で idempotent にする。

candidate processing order:

1. existing cover result が terminal: skip candidate
2. existing cover result が `knowledge_ready`: finalize
3. existing cover result が retryable and retry allowed: rerun cover evidence
4. no cover result: run cover evidence

受け入れ条件:

- `covering_evidence` 途中 timeout 後の再実行で、処理済み candidate が再処理されない。
- 未処理 candidate だけ進む。
- 同じ `coverEvidenceResultId` から重複 knowledge が作られない。

### Stage 7: 11 分 stale lock cleanup

対象:

- `src/cli/file-lock.ts`
- `src/cli/distill-pipeline.ts`
- `src/constants.ts`
- `test/file-lock.test.ts`

方針:

pipeline lock は target 処理単位で取得・解放する。continuous worker の process lifetime 全体では保持しない。

`acquireFileLock()` を拡張する。

```ts
type AcquireFileLockOptions = {
  lockFile: string;
  ttlSeconds: number;
  label: string;
  wait?: boolean;
  waitTimeoutMs?: number;
  pollMs?: number;
  staleCreatedAgeSeconds?: number;
  removeWhenCreatedAgeExceeded?: boolean;
};
```

pipeline lock では:

```ts
staleCreatedAgeSeconds: groupedConfig.distillation.pipelineLockStaleSeconds,
removeWhenCreatedAgeExceeded: true
```

動き:

- lock metadata の `createdAt` が 11 分より古い場合は stale とみなす。
- `removeWhenCreatedAgeExceeded=true` の場合、owner pid が生きていても削除対象にする。
- stale lock 削除前に `recoverStaleDistillationTargets()` を呼び、古い worker の target lease を外す。
- stale lock 削除時は stderr に `lock_stale_removed` を出す。

共有 lock への影響:

- default behavior は現行維持にする。
- owner process が生きている lock を年齢だけで削除するのは pipeline lock に限定する。

受け入れ条件:

- createdAt が 11 分より古い pipeline lock は削除される。
- 11 分未満の pipeline lock は削除されない。
- default lock は owner process alive を優先する現行挙動を保つ。

### Stage 8: gapless continuous worker

対象:

- `src/cli/distill-pipeline.ts`
- `scripts/setup-distill-pipeline-automation.sh`
- `scripts/automation/com.memory-router.distill-pipeline.plist`
- `docs/distillation-conveyor.md`
- `test/distillation-pipeline.test.ts`

新 CLI option:

```bash
bun run src/cli/distill-pipeline.ts --write --kind auto --continuous
```

run-once:

- 手動検証用に残す。
- 1 target だけ処理して終了する。

continuous:

- process は生存し続ける。
- target 処理ごとに pipeline lock を取得し、処理後に解放する。
- backlog があれば次 target をすぐ claim する。
- backlog がなければ idle sleep する。
- provider / DB error 時は error sleep する。
- inventory refresh は毎 target ではなく interval 管理する。

worker loop:

1. interval 到達時だけ inventory refresh
2. stale target recovery
3. retryable paused release
4. file lock acquire
5. claim next target
6. target なしなら lock release + idle sleep
7. target ありなら run with 10 分 deadline
8. lock release
9. 次 loop

LaunchAgent:

- `StartInterval` ではなく `RunAtLoad + KeepAlive` を使う。
- `ProgramArguments` は `distill-pipeline.ts --write --kind auto --continuous` を指す。
- `run-once` 用の setup script command は残す。

受け入れ条件:

- backlog がある状態で 2 target 以上を interval 待ちなしで連続処理する。
- idle 状態で CPU を使い続けない。
- process crash 後に LaunchAgent が再起動する。

### Stage 9: doctor queue 停止検知

対象:

- `src/modules/doctor/inspectors/distillation-run.inspector.ts`
- `src/modules/doctor/doctor.service.ts`
- `src/shared/schemas/doctor.schema.ts`
- `test/doctor.service.test.ts`

追加 schema:

```ts
queueHealth: {
  pending: number;
  running: number;
  paused: number;
  skipped: number;
  failed: number;
  oldestPendingAt: string | null;
  oldestPendingAgeMinutes: number | null;
  oldestRunningHeartbeatAt: string | null;
  oldestRunningHeartbeatAgeMinutes: number | null;
  lastCompletedAt: string | null;
  lastKnowledgeCreatedAt: string | null;
  lastProgressAt: string | null;
  lastProgressAgeMinutes: number | null;
  lockFileExists: boolean;
  lockCreatedAt: string | null;
  lockAgeSeconds: number | null;
  staleLock: boolean;
}
```

追加 reason:

- `DISTILLATION_QUEUE_STALLED`
- `DISTILLATION_RUNNING_STALE`
- `DISTILLATION_LOCK_STALE`
- `DISTILLATION_NO_RECENT_KNOWLEDGE`
- `DISTILLATION_WORKER_NOT_LOADED`

判定:

- pending があるのに last progress が閾値以上古い。
- running heartbeat が 11 分以上古い。
- lock createdAt が 11 分以上古い。
- LaunchAgent が未ロード。
- continuous worker 期待時に LaunchAgent state が running でない。

nextActions:

```text
./scripts/setup-distill-pipeline-automation.sh load
bun run distill-target:release-stale
bun run distill:pipeline -- --write --limit 1 --kind auto
```

受け入れ条件:

- stale lock fixture で `DISTILLATION_LOCK_STALE` が出る。
- pending があるが progress が古い fixture で `DISTILLATION_QUEUE_STALLED` が出る。
- LaunchAgent unloaded で `DISTILLATION_WORKER_NOT_LOADED` が出る。

## 実装順

1. 定数・config 整理、candidate cap 削除。
2. LLM value gate と low importance guard。
3. target lease fencing。
4. target-level 10 分 deadline。
5. retry / skip policy。
6. resume / checkpoint。
7. 11 分 stale lock cleanup。
8. continuous worker と LaunchAgent 更新。
9. doctor queue health。
10. `docs/distillation-conveyor.md` と README 必要箇所を更新。

この順序にする理由:

- 候補数 cap 削除と低重要度 rejection は意味論の変更なので先に固定する。
- timeout / stale lock より先に lease fencing を入れないと、古い worker 書き戻しの競合が残る。
- resume は timeout と continuous worker の前に入れると、長い target の再実行コストを抑えられる。
- doctor は最後に新しい runtime 形へ合わせる。

## 受け入れ条件

- `distillationMaxCandidates` と `distillationTools.maxCandidates` がコードから消えている。
- 候補抽出は 3 件以上でも truncate されない。
- source-only 候補も LLM value gate を通る。
- `importance <= 50` の候補は knowledge に保存されない。
- 1 target が 10 分 deadline を超えた場合、`running` のまま残らない。
- 11 分超過 pipeline lock が次実行を止めない。
- stale recovery 後に古い worker が target を上書きできない。
- retry 後に既存 candidate / cover evidence を再利用する。
- backlog がある間は continuous worker が次 target を即 claim する。
- doctor が queue 停止、stale running、stale lock、worker unloaded を理由付きで報告する。

## 品質ゲート

最低限:

```bash
bun run typecheck
bun run test:unit
bun run doctor
```

distillation 周辺の変更後:

```bash
bunx vitest run \
  test/file-lock.test.ts \
  test/find-candidate.test.ts \
  test/cover-evidence.test.ts \
  test/finalize-distille.test.ts \
  test/distillation-pipeline.test.ts \
  test/doctor.service.test.ts
```

safe DB integration:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
```

運用確認:

```bash
./scripts/setup-distill-pipeline-automation.sh install
./scripts/setup-distill-pipeline-automation.sh load
./scripts/setup-distill-pipeline-automation.sh status
bun run distill:status
bun run doctor
```

実運用確認では次を見る。

- `queued` が減る。
- `completed` または `skipped` が増える。
- `running` が 11 分以上固定しない。
- `logs/distillation-pipeline.lock` が 11 分以上残らない。
- `knowledge_items.max(created_at)` が進む。
