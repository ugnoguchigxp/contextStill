# memory-router

`memory-router` は、コーディングエージェント向けのローカルファースト Context Compiler です。  
入力元は `wiki`、会話ログは `vibe_memory`、会話ログ内の編集差分は `agent_diff` として扱い、作業目的に必要な最小コンテキストを組み立てます。

## データモデル

- `sources`: このプロジェクト配下の `./wiki` そのもの。人間が編集する Markdown はここに集約します。
- `source_fragments`: wiki ページ検索と `sourceRefs` 解決のための内部インデックスです。UI/API の入力口ではありません。
- `knowledge_items`: wiki や vibe memory から蒸留された、次回作業の判断・手順に使う知識です。`type` は `rule / procedure`、`status` は `draft / active / deprecated`、`scope` は `repo / global` だけを使います。
- `vibe_memories`: LLM との自然言語会話ログです。diff 本文は保存しません。
- `agent_diff_entries`: `vibe_memories` の会話中で発生した編集差分です。file content は保存せず、`diff_hunk` と抽出できた symbol 列を保存します。
- `sync_states`: Codex / Antigravity ログ同期の file cursor と最終同期時刻です。

## 主要機能

- Context Compile（CLI / MCP / API）
- Knowledge 管理（作成・編集・削除）
- Wiki 管理（フォルダ、ページ、Git 履歴、diff、Markdown WYSIWYG）
- Vibe Memory 閲覧、削除
- Codex / Antigravity 会話ログの増分同期
- Vibe Memory 内での Agent Diff / Symbol 畳み込み表示
- Knowledge Graph 可視化（`knowledge_items` の距離と relation を表示し、`vibe_memories` は蒸留元として扱う）
- Doctor 診断

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
bun run doctor
```

## Agent Log Sync

Codex と Antigravity の会話ログを `vibe_memories` に継続保存できます。Codex は既定で `~/.codex/sessions` と `~/.codex/archived_sessions` を見ます。Antigravity は既定で `~/.gemini/antigravity/brain` を見ます。別環境では `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` で workspace root を明示してください。

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

`GET /api/graph` は既定で `active / draft` の `knowledge_items` だけをノードにします。`vibe_memories` は raw transcript として検索・蒸留候補に使い、Graph の主ノードには含めません。`edgeMode=semantic|relations|both`、`status=current|active|draft|deprecated|all` で表示対象を切り替えられます。

`POST /api/vibe-memory` は自然言語の `content` に加えて `diff` または `agentDiffs[]` を受け取れます。`content` に混ざった diff block も保存前に取り除かれ、unified diff は `agent_diff_entries` に分解されます。TypeScript/JavaScript の主要シンボルは同じテーブルの symbol 列に保存されます。

## MCP

```bash
bun run start:mcp
```

公開ツール:

- `initial_instructions`
- `context_compile`
- `record_vibe_memory`
- `memory_search`
- `memory_fetch`
- `doctor`

`record_vibe_memory` は自然言語の `content` に加えて `diff` / `agentDiffs[]` を受け取り、`vibe_memories` と `agent_diff_entries` を同一トランザクションで保存します。diff 本文は `vibe_memories.content` から分離されます。

## テスト

```bash
bun run verify
bun run test:integration
bun run test:e2e
```

## 今後の改善計画

1. `initial_instructions` を強化し、作業開始時の取得、実装後の記録、wiki からの蒸留までの標準ループをさらに明文化する。
2. `record_vibe_memory` の終了時フローを自動化し、Git diff から `agent_diff_entries` を確実に登録できる補助コマンドを追加する。
3. `agent_diff_entries` から knowledge 化候補を抽出するバッチを追加し、wiki と knowledge の差分レビューを UI で確認できるようにする。
4. Doctor に degraded 回復動線を追加し、DB migration 未適用、embedding 不通、wiki Git 不整合を UI から切り分けやすくする。
