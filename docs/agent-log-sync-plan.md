# Codex / Antigravity 会話ログ同期計画

最終更新: 2026-05-14

## 1. 目的

Codex と Antigravity の会話ログを cron バッチ相当の定期処理で監視し、増分だけを
`vibe_memories` に保存し続ける。保存した会話ログは、その後の検索、Context Compile、
agent diff 抽出、knowledge 蒸留の入力として使う。

この計画では Gnosis の実装を参考にするが、memoryRouter の最終モデルに合わせて次の境界を守る。

- `source` は `wiki` そのものだけを指す
- `vibe_memory` は LLM との会話ログを指す
- `agent_diff_entries` は `vibe_memory` 内の diff と symbol 情報を保持する
- `knowledge` は source / vibe_memory / agent_diff から後段で蒸留された再利用可能な知識を指す
- `ai_artifacts` や `artifact_symbols` の概念は復活させない

## 2. Gnosis から引き継ぐもの

Gnosis 側では以下の構造で外部エージェントログの継続保存を実現している。

- `src/services/ingest.ts`
  - Codex JSONL を再帰的に走査する
  - `response_item` の `message` だけを取り込む
  - `input_text` / `output_text` / `text` / `summary_text` を本文化する
  - JSONL の末尾が改行で終わっていない場合は未確定行として次回に回す
  - Antigravity は session 配下の `.system_generated/logs/overview.txt` を読む
  - ファイルごとの offset / mtime を cursor として返す
- `src/services/sync.ts`
  - `sync_state` から前回 cursor を読む
  - source ごとに ingest を実行する
  - session 単位に message をまとめ、件数と文字数で chunk 化する
  - transcript を `vibe_memories` に保存する
  - `session_id + dedupe_key` で重複挿入を避ける
  - cursor 更新と memory 挿入を transaction で扱う
- `scripts/automation/com.gnosis.sync.plist`
  - LaunchAgent の `StartInterval` で定期実行する
  - stdout / stderr を `logs/sync.log` に集約する
- `scripts/setup-automation.sh`
  - plist の install / load / unload / uninstall / status を管理する

memoryRouter ではこの骨格を引き継ぎ、KnowFlow の queue や Gnosis 固有の synthesis task は移植しない。

## 3. memoryRouter 側の不足点

現状の memoryRouter には `vibe_memories` と `agent_diff_entries` はあるが、定期ログ同期に必要な次の要素が不足している。

- 同期状態を保存するテーブルがない
- `vibe_memories` に deterministic dedupe 用の列がない
- Codex / Antigravity のログ parser がない
- 増分取り込み CLI がない
- LaunchAgent 用の plist と setup script がない
- 取り込み結果を doctor / log で確認する標準動線がない

## 4. 追加するデータモデル

### 4.1 `sync_states`

外部ログ source ごとの cursor を保存する。

| column | type | purpose |
| --- | --- | --- |
| `id` | text primary key | `codex_logs` / `antigravity_logs` |
| `last_synced_at` | timestamp | 最後に観測した mtime または同期時刻 |
| `cursor` | jsonb | ファイルごとの `{ offset, mtimeMs }` |
| `metadata` | jsonb | warning count、対象 root などの補助情報 |
| `created_at` | timestamp | 作成日時 |
| `updated_at` | timestamp | 更新日時 |

cursor は Gnosis と同じく file path を key にした map を基本形にする。

```json
{
  "/Users/example/.codex/sessions/2026/05/14/session.jsonl": {
    "offset": 12345,
    "mtimeMs": 1778760000000
  }
}
```

### 4.2 `vibe_memories.dedupe_key`

`vibe_memories` に `dedupe_key text` を追加し、`session_id + dedupe_key` の unique index を張る。

dedupe key は次を結合して SHA-256 化する。

- source id
- memory session id
- chunk index
- chunk content

これにより同じログを複数回 cron が読んでも、重複した `vibe_memory` は増えない。

### 4.3 既存 `agent_diff_entries` の扱い

diff と symbol は既存の `agent_diff_entries` を使う。

- `vibe_memory_id`: 元になった会話 chunk
- `diff_hunk`: unified diff または抽出した差分本文
- `file_path`: diff 対象ファイル
- `symbol_name` / `symbol_kind` / `signature` / `start_line` / `end_line`: diff から抽出した symbol 情報

新しい artifact 系テーブルは作らない。

## 5. 設定

`src/config.ts` に次を追加する。

| env | default | purpose |
| --- | --- | --- |
| `MEMORY_ROUTER_CODEX_SESSION_DIR` | `~/.codex/sessions` | Codex 現行 session JSONL の root |
| `MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIR` | `~/.codex/archived_sessions` | Codex archived session JSONL の root |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity/brain` | Antigravity workspace/session root |
| `MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS` | `3600` | LaunchAgent の実行間隔 |
| `MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS` | `168` | 初回同期時に遡る時間。`0` で全件対象 |
| `MEMORY_ROUTER_AGENT_LOG_MAX_MESSAGES_PER_CHUNK` | `120` | 1 memory chunk の最大 message 数 |
| `MEMORY_ROUTER_AGENT_LOG_MAX_CHARS_PER_CHUNK` | `12000` | 1 memory chunk の最大文字数 |
| `MEMORY_ROUTER_AGENT_LOG_SYNC_LOCK_TTL_SECONDS` | `1800` | 多重起動防止 lock の寿命 |

Antigravity の root は環境差があるため、既定値が存在しない場合は env で明示する。存在しない場合は
Antigravity だけ skip し、Codex 同期は継続する。

## 6. 実装モジュール

### 6.1 Parser

追加候補: `src/modules/agent-log-sync/ingest.service.ts`

責務:

- `ingestCodexLogs(since, cursor)`
- `ingestAntigravityLogs(since, cursor)`
- `normalizeIngestCursor(cursor)`
- `extractCodexTextContent(raw)`
- `filterSensitiveData(text)`
- recursive JSONL scan
- partial JSONL line の持ち越し
- ファイル縮小時の offset reset

Codex では Gnosis と同じく `response_item` の `payload.type === "message"` のみを対象にする。
`payload.role` が `user` / `assistant` 以外の record は保存しない。

Antigravity はまず Gnosis と同じ `overview.txt` 差分読み取りから始める。overview の内容は tool / file view /
自然言語会話に分け、`vibe_memories.content` には自然言語会話だけを保存する。

### 6.2 Sync Orchestrator

追加候補: `src/modules/agent-log-sync/sync.service.ts`

責務:

1. `sync_states` から source ごとの cursor を読む
2. Codex / Antigravity parser を実行する
3. message を `memorySessionId` ごとに group 化する
4. group を chunk 化する
5. transcript を組み立てる
6. `dedupe_key` を生成する
7. `vibe_memories` に insert する
8. 可能なら同じ transaction 内で `sync_states` を更新する
9. diff を抽出できる chunk は `agent_diff_entries` に保存する
10. summary を stdout と structured return で返す

保存する `vibe_memories.metadata` の標準形:

```json
{
  "source": "Codex",
  "sourceId": "codex_logs",
  "kind": "agent_log_chunk",
  "memoryPipeline": "raw_for_distillation",
  "sessionFiles": ["..."],
  "messageCount": 12,
  "roles": ["user", "assistant"],
  "chunkIndex": 0,
  "dedupeKey": "..."
}
```

`memoryPipeline` は蒸留前の会話ログであることを示すだけに留め、ここでは knowledge 化しない。

### 6.3 CLI

追加候補: `src/cli/sync-agent-logs.ts`

実行例:

```bash
bun run sync:agent-logs
```

出力例:

```json
{
  "ok": true,
  "imported": 8,
  "sources": [
    {
      "id": "codex_logs",
      "checkedFiles": 42,
      "messages": 130,
      "insertedMemories": 7,
      "insertedDiffs": 3,
      "warnings": []
    },
    {
      "id": "antigravity_logs",
      "checkedFiles": 2,
      "messages": 1,
      "insertedMemories": 1,
      "insertedDiffs": 0,
      "warnings": []
    }
  ]
}
```

`package.json` には次を追加する。

```json
{
  "scripts": {
    "sync:agent-logs": "bun run src/cli/sync-agent-logs.ts"
  }
}
```

## 7. cron / LaunchAgent

macOS では system cron よりも LaunchAgent を標準動線にする。Gnosis と同様に plist template と setup script を置く。

追加候補:

- `scripts/automation/com.memory-router.agent-log-sync.plist`
- `scripts/setup-automation.sh`

plist の方針:

- `ProgramArguments`: `bun run src/cli/sync-agent-logs.ts`
- `WorkingDirectory`: project root
- `StartInterval`: `MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS` の値を反映
- `StandardOutPath`: `logs/agent-log-sync.log`
- `StandardErrorPath`: `logs/agent-log-sync.log`
- `RunAtLoad`: 初期値は `false`

setup script の subcommand:

- `install`: plist template を `~/Library/LaunchAgents` に配置
- `load`: launchctl に登録
- `unload`: 登録解除
- `uninstall`: plist 削除
- `status`: `launchctl print gui/$UID/<label>` の要点表示
- `run-once`: LaunchAgent ではなく CLI を一度だけ直接実行

多重起動対策として、CLI 起動時に lock を取る。まずは DB の `sync_states` metadata か
project-local lock file のどちらかで実装する。DB transaction 内の lock が扱いやすければ DB に寄せる。

## 8. agent diff 抽出

最初の保存単位は自然言語会話だけに正規化した `vibe_memory` とする。chunk 内に unified diff を検出できる場合は、
diff 本文を `vibe_memory.content` から分離し、`agent_diff_entries` だけに保存する。

実装順:

1. 既存 `recordVibeMemoryWithDiffEntries` / `normalizeAgentDiffEntries` を batch sync から再利用できる形にする
2. Codex assistant message 内の diff fence または `*** Begin Patch` 形式を抽出し、会話本文から取り除く
3. unified diff parser で `file_path` と hunk を取り出す
4. 既存の symbol 列に、取得できる範囲の `symbol_name` / `symbol_kind` / `start_line` / `end_line` を入れる
5. symbol 解析できない場合も diff 本文は保存する

symbol 化は完全性を要求しすぎない。重要なのは「diff 原文を `agent_diff_entries.diff_hunk` として失わないこと」と
「検索や knowledge 化の根拠として file / symbol で引けること」。

## 9. doctor / 運用確認

`src/cli/doctor.ts` に agent log sync の確認項目を追加する。

確認項目:

- Codex session dir が存在するか
- Codex archived session dir が存在するか
- Antigravity log dir が設定されているか
- `sync_states` に `codex_logs` / `antigravity_logs` が存在するか
- 最終同期時刻が freshness threshold 内か
- 直近 run の warning / failed source があるか
- LaunchAgent plist が install 済みか
- LaunchAgent が load 済みか

doctor は「壊れているか」だけでなく、「次に実行すべきコマンド」を出す。

例:

```text
agent-log-sync: degraded
- Codex sessions: ok
- Antigravity logs: not configured
- Last codex sync: 2026-05-14T10:20:00+09:00
- LaunchAgent: not loaded
next: bun run sync:agent-logs
next: ./scripts/setup-automation.sh install && ./scripts/setup-automation.sh load
```

## 10. テスト計画

### Unit

- Codex JSONL parser
  - string content
  - array content
  - unsupported record skip
  - partial trailing line skip
  - invalid JSON skip
- Antigravity overview reader
  - missing root skip
  - missing overview skip
  - offset 以降だけ読む
- cursor normalize
  - unknown shape を空 cursor にする
  - file shrink 時に offset reset
- chunking
  - message count limit
  - char limit
- dedupe key
  - 同一 input で同一 key
  - content 変更で別 key

### Integration

- fixture log dir から初回同期して `vibe_memories` が増える
- 2回目同期では `vibe_memories` が増えない
- JSONL に追記すると追記分だけ増える
- sync 中に warning が出ても該当 source だけ skip し、他 source は継続する
- diff を含む Codex message から `agent_diff_entries` が作られる
- `sync_states.cursor` が transaction 後に更新される

### Manual smoke

```bash
bun run db:migrate
bun run sync:agent-logs
bun run doctor
./scripts/setup-automation.sh install
./scripts/setup-automation.sh load
./scripts/setup-automation.sh status
tail -f logs/agent-log-sync.log
```

## 11. リスクと対策

| risk | impact | mitigation |
| --- | --- | --- |
| Codex JSONL format が変わる | 取り込み漏れ | parser test fixture を複数形式で持つ。unknown record は warning metadata に残す |
| Antigravity log root が環境依存 | Antigravity だけ未同期 | env 必須扱いにして doctor で明示する |
| 初回 import が大きすぎる | DB / embedding 負荷 | default lookback を 168h にし、全件 import は `0` opt-in |
| 機密情報が会話ログに含まれる | DB に secret 保存 | Gnosis の `secretFilter` 相当を移植し、保存前に redact する |
| cron 多重起動 | 重複処理 / cursor 競合 | lock と `session_id + dedupe_key` unique index の二重防御 |
| parser warning が見えない | 壊れても気づけない | CLI summary、log、doctor に warning を出す |
| diff 抽出が不完全 | symbol 検索が弱い | `vibe_memory` は自然言語会話に限定し、抽出できた diff は `diff_hunk` に必ず残す。symbol は best effort にする |

## 12. 実装フェーズ

### P1. 同期の最小縦断

- `sync_states` migration 追加
- `vibe_memories.dedupe_key` migration 追加
- config 追加
- Codex parser 追加
- Antigravity overview reader 追加
- sync orchestrator 追加
- `sync:agent-logs` CLI 追加
- parser / sync unit test 追加

完了条件:

- fixture から `vibe_memories` に自然言語 conversation chunk を保存できる
- 2回連続実行しても重複しない
- `bun run verify` が通る

### P2. 定期実行

- plist template 追加
- setup script 追加
- logs directory 運用追加
- doctor に設定 / freshness / LaunchAgent status を追加

完了条件:

- `./scripts/setup-automation.sh install/load/status` で状態確認できる
- `logs/agent-log-sync.log` に実行結果が残る
- LaunchAgent 経由で `sync:agent-logs` が実行される

### P3. agent diff 連携

- Codex transcript から diff block を抽出
- 既存 `agent_diff_entries` に保存
- file / symbol 検索の test 追加
- Context Compile で agent diff が根拠候補として拾えることを確認

完了条件:

- diff を含む Codex fixture から `agent_diff_entries` が作られる
- `memory_search` で file path / symbol 名から該当 `vibe_memory` を見つけられる

### P4. 蒸留フロー

- `vibe_memory` を直接 `knowledge` にしない
- distillation CLI または MCP tool から明示的に knowledge 候補を作る
- 候補は `draft` で保存し、Context Compile に混ぜる条件を明確化する

完了条件:

- 会話ログ取り込みと knowledge 作成が別操作として分かれている
- knowledge 化の根拠として `vibe_memory` / `agent_diff_entries` を辿れる

## 13. 完了定義

- Codex と Antigravity のログを増分取り込みできる
- 取り込み結果は `vibe_memories` に保存される
- diff を含むログは `vibe_memories.content` から分離され、`agent_diff_entries` に保存される
- 同一ログを複数回処理しても重複しない
- cursor は source ごと、file ごとに保持される
- LaunchAgent で定期実行できる
- doctor と log で停止、未設定、warning を確認できる
- `source = wiki`、`vibe_memory = 会話ログ`、`agent_diff = 会話中の diff` の境界が崩れない
