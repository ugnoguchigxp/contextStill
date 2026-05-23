# Source Distillation Pipeline Lock Runbook

## 目的

`SOURCE_DISTILLATION_PIPELINE_LOCK_STALE` が発火した際に、
「実害のある停止」と「lock age による誤検知」を同じ手順で切り分ける。

## 監視コマンド（固定）

以下を 1 セットで実行する。

```bash
bun run distill:monitor:source-lock
```

実行内容（手動時の等価コマンド）:

```bash
launchctl print gui/$(id -u)/com.memory-router.distill-pipeline
bun run src/cli/distillation-target.ts status --json
bun run distill:repair -- --kind wiki --json
```

## 判定ルール

1. `lock.staleByCreatedAge = true` だけでは critical 扱いしない。
2. `runnableQueued = queued + retryablePaused` が 0 の場合は、lock stale 単独で blocking としない。
3. `runnableQueued > 0` かつ `running = 0` かつ `blockedByHigherPriority = false` の場合は、実害ありとして調査を継続する。
4. lock owner PID が生存している場合は lock を削除しない。

## 対応フロー

1. `distill:monitor:source-lock` を実行して現状を採取する。
2. `distill:repair -- --kind wiki --json` の action を確認する。
3. action が `inspect_live_worker` の場合:
   - worker 継続中。lock 削除は行わない。
   - `distillation-target status` の `running/staleRunning/completed` 変化を監視する。
4. action が `queue_stopped` の場合:
   - LaunchAgent と log を確認し、必要なら worker reload を実施する。
5. action が `remove_stale_file_lock` で `safeToApply=true` の場合のみ:
   - `bun run distill:repair -- --kind wiki --apply --limit 50 --json` を実行する。

## 正常化の確認

- `bun run doctor` で `SOURCE_DISTILLATION_PIPELINE_LOCK_STALE` が消えている。
- `distillation-target status` で `running` の heartbeat が進む、または `completed` が増える。

## 禁止事項

- PID 生存中の lock を手動で削除しない。
- lock age のみを根拠に critical と断定しない。
