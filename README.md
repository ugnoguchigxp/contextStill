# memory-router

`memory-router` は、コーディングエージェント向けのローカルファースト Context Compiler です。  
入力元は `wiki`、会話ログは `vibe_memory`、会話ログ内の編集差分は `agent_diff` として扱い、作業目的に必要な最小コンテキストを組み立てます。

## データモデル

- `sources`: このプロジェクト配下の `./wiki` そのもの。人間が編集する Markdown はここに集約します。
- `source_fragments`: wiki ページ検索と `sourceRefs` 解決のための内部インデックスです。UI/API の入力口ではありません。
- `knowledge_items`: wiki や vibe memory から蒸留された、次回作業の判断・手順に使う知識です。`type` は `rule / procedure`、`status` は `draft / active / deprecated`、`scope` は `repo / global` だけを使います。
- `vibe_memories`: LLM との自然言語会話ログです。diff 本文は保存しません。
- `agent_diff_entries`: `vibe_memories` の会話中で発生した編集差分です。file content は保存せず、`diff_hunk` と抽出できた symbol 列を保存します。
- `vibe_memory_distillation_runs`: vibe memory から knowledge を蒸留した履歴です。処理済み判定、失敗再試行、生成 knowledge id を管理します。
- `source_distillation_runs` / `source_distillation_evidence`: wiki source fragment から knowledge を蒸留した履歴と、fetch した外部根拠の実行履歴です。
- `sync_states`: Codex / Antigravity ログ同期の file cursor と最終同期時刻です。

## 主要機能

- Context Compile（CLI / MCP / API）
- Knowledge 管理（作成・編集・削除）
- Wiki 管理（フォルダ、ページ、Git 履歴、diff、Markdown WYSIWYG）
- Vibe Memory 閲覧、削除
- Codex / Antigravity 会話ログの増分同期
- Vibe Memory から `rule / procedure` knowledge を Gemma4 で蒸留し、保存時に embedding 化
- Wiki source fragment から `rule / procedure` knowledge を Gemma4 で蒸留し、保存時に embedding 化
- Vibe Memory 内での Agent Diff / Symbol 畳み込み表示
- Knowledge Graph 可視化（`knowledge_items` の距離と relation を表示し、`vibe_memories` は蒸留元として扱う）
- Doctor 診断

Distillation の共通 runtime 方針は [docs/distillation-runtime-plan.md](docs/distillation-runtime-plan.md)、Source から Graph を作る方針は [docs/source-graph-flow.md](docs/source-graph-flow.md) にまとめています。Graph の主ノードは `knowledge_items` のままにし、source は蒸留元と根拠として扱います。

## Wiki 管理

既定のコンテンツルートは `./wiki` です。`wiki/` はこのプロジェクト側では gitignore され、独立した Git リポジトリとして運用できます。ルートに `.git` が無ければ自動初期化され、ページ操作時に commit します。

設定で切り替える場合:

```bash
MEMORY_ROUTER_SOURCE_CONTENT_ROOT=/abs/path/to/wiki
```

## セットアップ

必要環境:

- Bun 1.3+
- Docker（PostgreSQL + pgvector）

```bash
docker compose up -d
cp .env.example .env
bun install
bun run db:migrate
bun run verify
```

開発起動:

```bash
bun run dev
```

- UI: [http://localhost:5173](http://localhost:5173)
- API: 同一 origin の `/api/*`

## CLI

```bash
bun run compile --goal "fix context compiler" --intent edit --json
bun run import:wiki ./wiki/pages
bun run sync:agent-logs
bun run distill:vibe-memory -- --apply
bun run distill:sources -- --apply
bun run doctor
```

## Agent Log Sync

Codex と Antigravity の会話ログを `vibe_memories` に継続保存できます。Codex は既定で `~/.codex/sessions` と `~/.codex/archived_sessions` を見ます。Antigravity は既定で `~/.gemini/antigravity/brain` を見ます。別環境では `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` で workspace root を明示してください。初回取り込み範囲は `MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS` と `MEMORY_ROUTER_ANTIGRAVITY_LOG_INITIAL_LOOKBACK_HOURS` で調整できます。

一度だけ同期:

```bash
bun run sync:agent-logs
```

macOS LaunchAgent として定期実行:

```bash
./scripts/setup-automation.sh install
./scripts/setup-automation.sh load
./scripts/setup-automation.sh status
```

ログは `logs/agent-log-sync.log`、多重起動防止 lock は `logs/agent-log-sync.lock` を使います。

## Vibe Memory Distillation

`vibe_memories` と紐づく `agent_diff_entries` から、次回作業で再利用できる `rule / procedure` だけを抽出し、`knowledge_items` に `draft` として保存します。保存時に `${title}\n${body}` を passage embedding 化するため、Graph の semantic edge 距離計算にもそのまま使われます。

既定では local-llm の Gemma4 API を使います。Gemma4 には候補ごとの `score` を出させ、既定しきい値以上の候補だけを提示・保存します。保存前にも同じ score gate を通すため、低品質候補は `knowledge_items` に登録されません。

```bash
# dry-run: knowledge と run 履歴は保存しない
bun run distill:vibe-memory

# apply: draft knowledge と distillation run を保存
bun run distill:vibe-memory -- --apply

# 対象を絞る
bun run distill:vibe-memory -- --apply --limit 20 --session-id <session-id>
```

macOS LaunchAgent として継続実行:

```bash
./scripts/setup-distillation-automation.sh install
./scripts/setup-distillation-automation.sh load
./scripts/setup-distillation-automation.sh status
```

主要設定:

- `MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL`（既定 `http://127.0.0.1:44448`）
- `MEMORY_ROUTER_LOCAL_LLM_MODEL`（既定 `gemma-4-e4b-it`）
- `MEMORY_ROUTER_VIBE_DISTILLATION_BATCH_SIZE`
- `MEMORY_ROUTER_VIBE_DISTILLATION_MAX_INPUT_CHARS`
- `MEMORY_ROUTER_VIBE_DISTILLATION_MAX_OUTPUT_TOKENS`
- `MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS`
- `MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE`（既定 `0.75`）
- `MEMORY_ROUTER_VIBE_DISTILLATION_INTERVAL_SECONDS`（LaunchAgent の実行間隔）

## Source / Wiki Distillation

`import:wiki` は Markdown を `sources` / `source_fragments` に取り込みます。通常の wiki 本文はそのまま `knowledge_items` には登録せず、`distill:sources` が source fragment を Gemma4 で `rule / procedure` に蒸留します。保存時に `${title}\n${body}` を passage embedding 化し、`knowledge_source_links` で元 fragment と接続します。

Vibe memory と同じ共通 system context、`search_web` / `fetch_content` tool loop、score gate を使います。URL や外部仕様に依存する候補は fetched evidence がない場合に保存前 gate で落とします。

```bash
# dry-run
bun run distill:sources

# apply
bun run distill:sources -- --apply

# 対象を絞る
bun run distill:sources -- --apply --limit 20 --source-kind wiki
bun run distill:sources -- --apply --uri /abs/path/wiki/page.md
```

macOS LaunchAgent として継続実行:

```bash
./scripts/setup-source-distillation-automation.sh install
./scripts/setup-source-distillation-automation.sh load
./scripts/setup-source-distillation-automation.sh status
```

主要設定:

- `MEMORY_ROUTER_SOURCE_DISTILLATION_BATCH_SIZE`
- `MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_INPUT_CHARS`
- `MEMORY_ROUTER_SOURCE_DISTILLATION_MAX_OUTPUT_TOKENS`
- `MEMORY_ROUTER_SOURCE_DISTILLATION_INTERVAL_SECONDS`（LaunchAgent の実行間隔）
- `MEMORY_ROUTER_DISTILLATION_FAILURE_RETRY_DELAY_SECONDS`（failed retry の backoff）

## Embedding

既定では sibling repo `../local-llm/embedding` の embedding 実装を参照します。

- daemon 優先: `MEMORY_ROUTER_EMBEDDING_DAEMON_URL`
- fallback: Python CLI: `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_PYTHON -m e5embed.cli`

主要設定:

- `MEMORY_ROUTER_EMBEDDING_PROVIDER=auto|daemon|cli|disabled`
- `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_ROOT`
- `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_PYTHON`
- `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_MODEL_DIR`

## API

主要エンドポイント:

- `POST /api/context/compile`
- `GET /api/context/runs`
- `GET /api/doctor`
- `GET/POST/PUT/DELETE /api/knowledge`
- `GET /api/sources/tree`
- `GET/POST /api/sources/folders`
- `PUT/DELETE /api/sources/folders/*`
- `GET/POST /api/sources/pages`
- `GET/PUT/DELETE /api/sources/pages/*`
- `GET /api/sources/history/*`
- `GET /api/sources/diff/*?from=...&to=...`
- `GET/POST /api/vibe-memory`
- `GET/DELETE /api/vibe-memory/:id`
- `GET /api/agent-diffs`
- `GET /api/graph`

`GET /api/graph` は既定で `active / draft` の `knowledge_items` だけをノードにします。`vibe_memories` は raw transcript として検索・蒸留候補に使い、Graph の主ノードには含めません。`view=relation|semantic`、`relationAxes=session,project`、`status=current|active|draft|deprecated|all` で表示対象を切り替えられます。Relation view の edge は `sourceSessionId` / `repoKey` / `vibe_memories.metadata.projectRoot` から動的に合成され、永続 relation テーブルには依存しません。

`POST /api/vibe-memory` は自然言語の `content` に加えて `diff` または `agentDiffs[]` を受け取れます。`content` に混ざった diff block も保存前に取り除かれ、unified diff は `agent_diff_entries` に分解されます。TypeScript/JavaScript の主要シンボルは同じテーブルの symbol 列に保存されます。

## MCP

```bash
bun run start:mcp
```

公開ツール:

- `initial_instructions`
- `initial_instruction`（`initial_instructions` の互換 alias）
- `context_compile`
- `search_knowledge`
- `record_vibe_memory`
- `memory_search`
- `memory_fetch`
- `doctor`

標準利用順序:

1. `initial_instructions`
2. `context_compile`
3. 必要時のみ `search_knowledge` / `memory_search` / `memory_fetch`
4. 作業後に `record_vibe_memory`
5. `doctor` で状態確認

`record_vibe_memory` は自然言語の `content` に加えて `diff` / `agentDiffs[]` を受け取り、`vibe_memories` と `agent_diff_entries` を同一トランザクションで保存します。diff 本文は `vibe_memories.content` から分離されます。

`context_compile` は `repoPath` を受け取ると repo scoped 検索を優先し、scoped ヒットがない場合のみ degraded reason 付きで fallback します。`search_knowledge` は候補確認用の raw 出力を返し、通常の主導線は `context_compile` のままです。

詳細な MCP tool contract は [docs/mcp-tools.md](docs/mcp-tools.md) を参照してください。

## テスト

```bash
bun run verify
bun run verify:mcp
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
bun run test:e2e
```

`test:integration` は対象 DB のテーブルを truncate するため、通常の `memory_router` DB には実行しません。DB 名に `test` を含む検証用 DB を指定してください。
`verify:mcp` / `mcp:smoke` / `test:mcp:contract` は `DATABASE_URL` 未指定時に `memory_router_test` を既定で使います。

## 今後の改善計画

Context Compile と MCP 利用導線の詳細な改善計画は [docs/context-compile-mcp-improvement-plan.md](docs/context-compile-mcp-improvement-plan.md) にまとめています。

1. `context_compile` の source provenance を pack item 第一級情報としてさらに強化する。
2. `record_vibe_memory` の終了時フローを自動化し、Git diff から `agent_diff_entries` を確実に登録できる補助コマンドを追加する。
3. 蒸留済み draft knowledge のレビュー UI を強化し、wiki への反映候補と差分確認を扱えるようにする。
4. Doctor に degraded 回復動線を追加し、DB migration 未適用、embedding 不通、wiki Git 不整合を UI から切り分けやすくする。
