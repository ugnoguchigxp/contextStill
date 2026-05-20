# Distillation Conveyor 運用メモ

## 目的

新しい蒸留フローを常時回す。

- `selectDistillationTarget`
- `findCandidate`
- `coverEvidence`
- `finalizeDistille`

上記を `distill-pipeline` で 1 target ずつ実行する。

## 実行導線

### 手動

```bash
bun run distill:pipeline:once
```

### 常駐（LaunchAgent）

```bash
./scripts/setup-distill-pipeline-automation.sh install
./scripts/setup-distill-pipeline-automation.sh load
./scripts/setup-distill-pipeline-automation.sh status
```

`load` 時に legacy `com.memory-router.vibe-distillation` と
`com.memory-router.source-distillation` を bootout して二重実行を防ぐ。

## 監視ポイント

### target queue

```bash
bun run distill-target:status
```

見る値:

- `queued` が減ること
- `completed` が増えること
- `running` が長時間固定しないこと
- `paused` / `failed` が連続で増えないこと

### 進捗カウンタ

```bash
bun run distill-progress
```

返却:

- `candidateCount`
- `knowledgeCount`
- `failedCount`
- `skippedCount`

## 詰まり時のリカバリー

### stale running 回復

```bash
bun run distill-target:release-stale
```

### paused 回復

```bash
bun run src/cli/distillation-target.ts release-paused
```

### 1件だけ再投入

```bash
bun run src/cli/distillation-target.ts requeue --id <target_state_id> --reason manual_requeue
```

## 注意

- `distill-pipeline` は `logs/distillation-pipeline.lock` を使う。
- legacy の `distillation.lock` と分離済み。
- 外部接続（LLM/Web/embedding）障害時は target が `paused` に寄る。
