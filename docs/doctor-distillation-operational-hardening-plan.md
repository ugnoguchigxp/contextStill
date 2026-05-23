# Doctor / Distillation Operational Hardening 実装計画

> Status: implementation plan
> Date: 2026-05-23
> Scope: Phase 1 `doctor` degraded reason の分類改善、Phase 2 distillation lock/queue 停滞の再現可能な診断・修復。

## 1. 目的

`memory-router` の価値評価で弱点になっている「運用ヘルスが degraded のまま残りやすい」「distillation queue の停滞原因が手作業でしか切り分けにくい」を先に潰す。

この計画では新機能を広げない。対象は次の 2 点に限定する。

1. `doctor` を、通常開発・テストDB・本番相当の違いを表現できる診断にする
2. distillation の lock / queue / paused / stale running を dry-run で安全に診断し、許可された範囲だけ repair できるようにする

## 2. 現状整理

2026-05-23 の実DB `doctor` は `degraded`。DB、pgvector、embedding daemon、agentic LLM、MCP tool surface は正常だが、次が残っている。

- `KNOWLEDGE_ZERO_USE_HIGH`
- `DEGRADED_RATE_HIGH`
- `USABLE_PACK_RATE_LOW`
- `VIBE_DISTILLATION_NEVER_RAN`
- `ANTIGRAVITY_LOGS_SYNC_STALE`

distillation は次の状態。

- `vibeDistillation.jobs.queued = 4249`
- `vibeDistillation.queueHealth.blockedByHigherPriority = true`
- `sourceDistillation.runs.okRuns = 30`
- `sourceDistillation.jobs.running = 1`
- `sourceDistillation.jobs.paused = 1`
- `sourceDistillation.jobs.lastError = manual_pause_repeated_hang_covering_evidence`
- pipeline lock は存在するが、現時点では `staleByCreatedAge = false`

既存実装として、次は利用できる。

- `doctor` reason catalog: `src/shared/doctor/doctor-reasons.ts`
- `doctor` schema: `src/shared/schemas/doctor.schema.ts`
- `doctor` aggregation: `src/modules/doctor/doctor.service.ts`
- distillation inspector: `src/modules/doctor/inspectors/distillation-run.inspector.ts`
- stale running release: `recoverStaleDistillationTargets`
- retryable paused release: `releaseRetryablePausedDistillationTargets`
- queue status / claim / requeue / pause CLI: `src/cli/distillation-target.ts`
- file lock acquisition / stale removal: `src/cli/file-lock.ts`

## 3. 非目標

- compile benchmark はこの計画に含めない
- README onboarding smoke はこの計画に含めない
- 認証・認可の追加はこの計画に含めない
- distillation の候補品質そのものの改善はこの計画に含めない
- `doctor` warning を単に隠して green に見せる変更はしない

## 4. Phase 1: Doctor reason を運用判断できる形にする

### 4.1 仕様

`doctor` の reason を、現在の `critical | warning | info` だけでなく、運用判定用の分類を持たせる。`severity` は表示上の強さ、`impactLevel` は `doctor.status` 判定に使う強さとして分ける。

追加概念:

| field | 値 | 用途 |
| --- | --- | --- |
| `impactLevel` | `blocking | degraded | maintenance | skipped` | status 判定に使う |
| `environmentScope` | `all | configured_only | non_empty_db | strict_only` | 環境差を表す |
| `commands.inspect` | string nullable | 非破壊の確認コマンド |
| `commands.repairDryRun` | string nullable | 修復候補だけを表示するコマンド |
| `commands.repairApply` | string nullable | 明示実行時だけ使う修復コマンド |
| `evidence` | object nullable | 実行時に付与する閾値、件数、対象 id などの根拠 |

判定方針:

- `blocking`: 通常利用を止める。`doctor.status` は `degraded` または `failed`
- `degraded`: 主要品質を下げる。通常 `degraded`
- `maintenance`: 整理対象だが、主要機能が動くなら status を落とさない
- `skipped`: 環境上チェック対象外。status を落とさない

`failed` は DB 不通、必須テーブル欠落、schema validation 不能など、診断自体が信頼できない場合に限定する。

`reasons` 配列には active な問題だけを入れる。`skipped` は `reasons` へ混ぜず、`skippedChecks` または `summary.skipped` に出す。これにより、既存利用者が `reasons.length > 0` を問題有無として見ても誤判定しない。

### 4.2 具体的な分類ルール

初期分類は次で固定する。`environmentScope` は「チェックを active reason にする前提」、`normalImpact` と `strictImpact` は通常/strict での status 判定上の強さを表す。

| code | environmentScope | normalImpact | strictImpact | skipped 条件 |
| --- | --- | --- | --- | --- |
| `DB_UNREACHABLE` | all | blocking/failed | blocking/failed | なし |
| `MISSING_REQUIRED_TABLES` | all | blocking/failed | blocking/failed | なし |
| `MCP_PRIMARY_TOOLS_MISSING` | all | blocking | blocking | なし |
| `EMBEDDING_PROVIDER_UNAVAILABLE` | all | degraded | blocking | なし |
| `AGENTIC_LLM_UNREACHABLE` | all | maintenance | degraded | agentic compile が disabled の場合 |
| `DEGRADED_RATE_HIGH` | non_empty_db | degraded | degraded | compile run がない場合 |
| `USABLE_PACK_RATE_LOW` | non_empty_db | degraded | degraded | compile run がない場合 |
| `KNOWLEDGE_ZERO_USE_HIGH` | non_empty_db | maintenance | degraded | active knowledge が閾値未満の場合 |
| `HITL_DRAFT_BACKLOG_HIGH` | non_empty_db | maintenance | degraded | draft backlog が空の場合 |
| `*_NEVER_RAN` | configured_only | degraded | degraded | 対象データも queue もない場合 |
| `*_SYNC_STALE` | configured_only | maintenance | degraded | sync state が存在せず、対象ログもない場合 |
| `*_PIPELINE_LOCK_STALE` | all | blocking | blocking | なし |
| `*_QUEUE_STOPPED` | all | blocking | blocking | なし |
| `*_QUEUE_STALE_RUNNING` | all | blocking | blocking | なし |

`configured_only` の判定は「パスが設定されている」だけでは足りない。既定値で常に設定済みに見えるため、次のいずれかを満たす場合だけ active にする。

- 対象 sync state が存在し `cursorFiles > 0`
- 対象 source / vibe memory / target queue が存在する
- LaunchAgent が installed または loaded
- strict mode

このルールにより、初回セットアップ直後の空DBで `*_NEVER_RAN` が失敗のように見えることを避ける。一方、実DBのように `vibeDistillation.jobs.queued > 0` なのに成功 run がない場合は通常 mode でも `degraded` として残す。

### 4.3 実装タスク

1. `DoctorReasonDetail` を拡張する
   - 対象: `src/shared/doctor/doctor-reasons.ts`
   - 対象: `src/shared/schemas/doctor.schema.ts`
   - 追加 field は後方互換を意識して optional から始める

2. reason catalog に operational metadata を追加する
   - 既存 `label / severity / area / description / impact / action` は維持
   - `impactLevel` と `environmentScope` を catalog に定義
   - catalog は静的情報のみ持つ。件数や閾値などの `evidence` は `doctor.service.ts` または inspector 側で付与する
   - 未定義 code の fallback は `impactLevel = degraded` にする

3. `doctor` status 判定を reason count から impact 判定へ変更する
   - 対象: `src/modules/doctor/doctor.service.ts`
   - `failed`: blocking かつ DB/schema 系
   - `degraded`: blocking/degraded が 1 件以上
   - `ok`: maintenance/skipped/info のみ
   - `reasons`: skipped を除いた active reason code のみ
   - `reasonDetails`: active reason の詳細のみ
   - `skippedChecks`: skipped reason の詳細を必要最小限で保持する

4. `doctor --strict` を追加する
   - 対象: `src/cli/doctor.ts`
   - `runDoctor({ strict: true })` のように渡す
   - strict では `maintenance` の一部を `degraded` に昇格する
   - package script 経由では `bun run doctor -- --strict` を正式表記にする

5. `doctor` output に summary を追加する
   - 例: `summary: { blocking: 0, degraded: 2, maintenance: 3, skipped: 1 }`
   - UI と CLI が「なぜ degraded か」を一目で出せるようにする

6. Doctor UI を最小追従する
   - 対象: `web/src/modules/admin/components/doctor.page.tsx`
   - `critical/warning/info` だけでなく `impactLevel` を表示
   - skipped/maintenance は警告カードと視覚的に分ける

7. テストを更新する
   - `test/doctor-reasons.test.ts`
   - `test/doctor.service.test.ts`
   - `test/schemas.test.ts`
   - `test/mcp.contract.test.ts` または schema snapshot 相当

### 4.4 完了条件

- `bun run doctor` が blocking/degraded/maintenance/skipped の内訳を返す
- `bun run doctor -- --strict` が strict 用の判定を返す
- 空に近いテストDBで `*_NEVER_RAN` が本来の失敗のように見えない
- 実DBで `KNOWLEDGE_ZERO_USE_HIGH` が maintenance として表示される
- `DEGRADED_RATE_HIGH` と `USABLE_PACK_RATE_LOW` は degraded として残る
- `reasons` に skipped code が混入しない
- `bun run verify` と `bun run verify:mcp` が通る

## 5. Phase 2: Distillation lock/queue repair を安全に実装する

### 5.1 仕様

distillation repair は 2 段階にする。

1. `dry-run`: 何が詰まっているか、何を直せるかを一覧する
2. `apply`: safe action のみ実行する

初期コマンド案:

```bash
bun run distill:repair -- --json
bun run distill:repair -- --kind wiki --json
bun run distill:repair -- --kind vibe --apply --limit 10 --json
```

既存 `distill-target release-stale` / `release-paused` / `requeue` は残し、`distill:repair` は運用向けの統合入口にする。

### 5.2 repair 対象

| condition | dry-run 表示 | apply 動作 |
| --- | --- | --- |
| stale file lock かつ pid dead、かつ recent running target なし | `remove_stale_file_lock` | lock file 削除 |
| stale file lock かつ pid alive | `inspect_live_worker` | 自動削除しない |
| stale file lock だが recent running target あり | `running_target_holds_lock` | 自動削除しない |
| stale running job | `release_stale_running` | `recoverStaleDistillationTargets` |
| retryable paused job | `release_retryable_paused` | `releaseRetryablePausedDistillationTargets` |
| manual paused job | `manual_paused` | 自動変更しない |
| queued > 0 かつ running = 0 かつ not blocked | `queue_stopped` | 自動変更しない。LaunchAgent/log 確認を提示 |
| vibe blocked by wiki/candidate | `blocked_by_higher_priority` | 自動変更しない。blocker counts を表示 |
| running job が新しい | `running_recent` | 自動変更しない |

file lock については、現行 `acquireFileLock()` の stale-created-age 削除が pid 生存確認より先に評価される。Phase 2 ではこの挙動も hardening 対象にし、pid alive の lock を age だけで削除しない順序へ変更する。

apply は一度に大量更新しない。`--limit` を追加し、初期値は 50 件、最大 500 件にする。stale running / retryable paused の更新は bounded batch で実行し、dry-run と apply の出力に対象件数と適用件数を必ず含める。

用語は実装上の判定と一致させる。

- recent running target: `status = running` かつ `heartbeatAt ?? lockedAt ?? updatedAt` が stale threshold より新しい target
- stale running job: `status = running` かつ上記 timestamp が stale threshold 以下の target
- retryable paused job: `status = paused` かつ `nextRetryAt` が null または現在時刻以下で、`lastError` が manual stop 系ではない target
- manual paused job: `status = paused` かつ `lastError` または metadata が `manual_pause` / `manual_pause_repeated_hang_covering_evidence` を示す target

### 5.3 追加データ

`doctor` と repair dry-run が原因を説明できるよう、distillation inspector の queue health に blocker breakdown を追加する。

追加候補:

```ts
blockers?: {
  pendingKnowledgeCandidates: number;
  runningKnowledgeCandidates: number;
  staleRunningKnowledgeCandidates: number;
  retryableKnowledgeCandidates: number;
  manualPausedKnowledgeCandidates: number;
  pendingWiki: number;
  runningWiki: number;
  staleRunningWiki: number;
  retryableWiki: number;
  manualPausedWiki: number;
};
```

`vibe_memory` が `blockedByHigherPriority = true` のとき、単に true ではなく「wiki が 19 pending / 1 running / 1 manual paused」のように出せるようにする。

### 5.4 実装タスク

1. repair service を追加する
   - 新規: `src/modules/distillationRepair/repair.service.ts`
   - 入力: `{ kind, apply, staleSeconds, maxAttempts, limit }`
   - 出力: `{ mode, actions, applied, skipped, warnings }`
   - `actions[]` には `safeToApply`, `requiresManualReview`, `reason`, `evidence` を含める

2. safe action 判定を実装する
   - stale lock は `file-lock.ts` の pid 生存確認ロジックを `readFileLockState()` のような共有関数として切り出す
   - pid alive の lock は削除しない
   - pid dead でも recent running target があれば削除しない
   - DB 更新は既存 repository maintenance 関数を使う
   - `recoverStaleDistillationTargets` と `releaseRetryablePausedDistillationTargets` は `limit` 対応する
   - 長い transaction は作らず、集計と更新を分ける

3. CLI を追加する
   - 新規: `src/cli/distill-repair.ts`
   - `package.json`: `distill:repair`
   - default は dry-run
   - `--kind auto|wiki|vibe|candidate`
   - `--limit <n>`
   - `--apply` がない限り DB/file system を変更しない
   - `--json` は受け取るが、出力は常に JSON

4. `doctor` nextActions を repair command に寄せる
   - 対象: `src/modules/doctor/inspectors/distillation-run.inspector.ts`
   - stale lock / stale running / retryable paused / queue stopped に具体コマンドを表示
   - manual paused は reason と target count を表示する
   - apply command は直接出しすぎず、まず dry-run を案内する

5. blocker breakdown を追加する
   - 対象: `distillation-run.inspector.ts`
   - schema: `doctor.schema.ts`
   - tests: `test/doctor.service.test.ts`, `test/schemas.test.ts`

6. `distill-target status` と整合させる
   - `distill-target status` は現在の summary
   - `distill:repair` は「何を安全に直せるか」
   - 同じ集計ロジックを repository に寄せ、二重実装を避ける

7. 再現テストを追加する
   - stale file lock + dead pid
   - stale file lock + live pid
   - stale file lock + dead pid + recent running target
   - stale running job
   - retryable paused job
   - manual paused job
   - vibe blocked by wiki
   - queue stopped but no safe automatic fix

### 5.5 完了条件

- `bun run distill:repair -- --json` が dry-run で安全な action plan を返す
- `bun run distill:repair -- --apply --limit 10 --json` が safe action だけ適用する
- manual paused job は apply でも変更されない
- pid alive の file lock は削除されない
- recent running target がある file lock は削除されない
- stale running は既存の retry limit を尊重して pending/skipped へ遷移する
- `doctor` が `blockedByHigherPriority` の内訳を表示できる
- `doctor` の nextActions が `distill:repair` を案内する
- `bun run verify` と `bun run verify:mcp` が通る

## 6. 推奨実装順

1. Doctor schema を optional field で拡張する
2. reason catalog に `impactLevel` / `environmentScope` を追加する
3. `doctor` status 判定を impact ベースに変更する
4. `doctor --strict` と summary/skippedChecks を追加する
5. Doctor UI とテストを追従する
6. distillation repair service を dry-run のみで追加する
7. blocker breakdown を doctor と repair に接続する
8. stale lock / stale running / retryable paused の apply を追加する
9. `verify` / `verify:mcp` / 実DB `doctor` で閉じる

この順にすると、Phase 1 だけでも価値が出る。Phase 2 の apply 実装中に問題が出ても、dry-run と doctor 改善は先に利用できる。

## 7. 検証計画

必須:

```bash
bun run test:unit
bun run verify
bun run verify:mcp
bun run doctor
bun run doctor -- --strict
bun run distill:repair -- --json
```

Phase 2 apply 実装後:

```bash
bun run distill:repair -- --apply --limit 10 --json
bun run distill-target:status -- --json
bun run doctor
```

実DBで `--apply` を実行する前に、必ず dry-run 出力の `safeToApply = true` の件数と対象 reason を確認する。CI / unit test では seeded test DB または mock filesystem を使い、実DBへの apply を検証条件にしない。

追加で確認すること:

- `doctor` の status が maintenance/skipped だけで degraded にならない
- strict mode では本番相当の未実行・未同期が degraded として残る
- dry-run と apply の出力構造が同じ
- repair apply は対象件数と変更件数を返す
- stale lock 削除は pid dead の場合に限定される
- stale lock 削除は recent running target がない場合に限定される

## 8. リスクと対策

| リスク | 対策 |
| --- | --- |
| doctor が甘くなりすぎる | strict mode と impact summary を追加し、隠したのではなく分類したことを見える化する |
| repair が安全でない job を動かす | manual paused / pid alive / recent running は apply 対象外にし、`safeToApply` を action ごとに返す |
| DB 更新が長い transaction になる | 集計クエリと更新処理を分け、既存 repository maintenance 関数を使う |
| schema 拡張で MCP contract が壊れる | optional field から始め、contract/schema tests を更新する |
| queue blocker の説明が複雑になる | doctor は要約、repair dry-run は詳細という分担にする |

## 9. 最初の PR の切り方

1 PR で全て入れるより、次の 3 PR に分ける。apply 系は dry-run がレビューされた後に入れる。

### PR 1: Doctor operational classification

- `DoctorReasonDetail` 拡張
- impact ベース status 判定
- `doctor --strict`
- `summary` / `skippedChecks`
- Doctor UI の最小追従
- tests / verify

### PR 2: Distillation repair dry-run and blocker evidence

- `distill:repair`
- repair service
- blocker breakdown
- doctor nextActions 更新
- dry-run tests / verify / verify:mcp

### PR 3: Distillation repair apply

- safe action apply
- file lock hardening
- bounded batch update
- apply tests / verify / verify:mcp

PR 1 が通った時点で、現状の degraded が「本当に止めるべきもの」と「メンテ対象」に分離される。PR 2 で distillation 停滞の再現・診断導線を足す。PR 3 で初めて自動修復を有効にする。
