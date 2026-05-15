<p align="center">
  <strong>memory-router</strong><br/>
  <em>AI コーディングエージェントのための Local-first Context Compiler</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/memoryRouter/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/memoryRouter/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#仕組み">仕組み</a> ·
  <a href="#mcp-連携">MCP 連携</a> ·
  <a href="#cli-リファレンス">CLI</a> ·
  <a href="#api-リファレンス">API</a> ·
  <a href="docs/mcp-tools.md">MCP Tool Contract</a>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English README</a>
</p>

---

## memory-router とは

**memory-router** は、コーディングセッションの会話ログ、Wiki、ドキュメントから再利用可能な **ルール** と **手順** を蒸留し、AI コーディングエージェントに最適なコンテキストを — トークンバジェット内で — コンパイルするローカルファーストのナレッジエンジンです。

```
┌─────────────┐   ┌──────────────┐   ┌──────────────────┐
│  Wiki / Docs │   │ Agent Logs   │   │  Manual Rules    │
│  (Markdown)  │   │ (Codex,      │   │  (register_      │
│              │   │  Antigravity)│   │   knowledge)     │
└──────┬───────┘   └──────┬───────┘   └────────┬─────────┘
       │                  │                    │
       ▼                  ▼                    │
   import:wiki     sync:agent-logs             │
       │                  │                    │
       ▼                  ▼                    │
┌──────────────────────────────┐               │
│  蒸留 (ローカル LLM)          │               │
│  ┌────────┐ ┌─────────────┐  │               │
│  │ Score  │ │ Tool Loop   │  │               │
│  │ Gate   │ │ search_web  │  │               │
│  │ ≥0.75  │ │ fetch_url   │  │               │
│  └────────┘ └─────────────┘  │               │
└──────────────┬───────────────┘               │
               │                               │
               ▼                               ▼
        ┌──────────────────────────────────────────┐
        │         knowledge_items                   │
        │   type: rule | procedure                  │
        │   status: draft → active → deprecated     │
        │   scope: repo | global                    │
        │   + passage embedding (pgvector)          │
        └──────────────────┬───────────────────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │  context_compile    │
                │  トークンバジェット配分 │
                │  rules:45%          │
                │  procedures:35%     │
                │  sources:20%        │
                └─────────┬───────────┘
                          │
                          ▼
                ┌─────────────────────┐
                │  Context Pack       │
                │  (Markdown 出力)     │
                │  → エージェントへ     │
                └─────────────────────┘
```

### 既存手法との比較

| 機能 | memory-router | 一般的な RAG | CLAUDE.md / Cursor Rules |
|---|---|---|---|
| 知識の蒸留 | ✅ LLM + score gate | ❌ raw 検索 | ❌ 手動記述 |
| evidence / instruction の分離 | ✅ 完全分離 | ❌ 混在 | ❌ instruction のみ |
| 外部エビデンスの検証 | ✅ tool loop | ❌ | ❌ |
| リポジトリスコープ | ✅ DB レベル | △ namespace | ❌ global のみ |
| コンパイル品質の追跡 | ✅ degraded reasons + 実行履歴 | ❌ | ❌ |
| ライフサイクル管理 | ✅ draft/active/deprecated | ❌ | ❌ |
| MCP 標準準拠 | ✅ 公式 SDK | ❌ | ❌ |

---

## クイックスタート

### 前提条件

- [Bun](https://bun.sh/) 1.3+
- [Docker](https://www.docker.com/)（PostgreSQL + pgvector 用）
- ローカル LLM サーバー（蒸留用、任意。例: Gemma4 対応の [local-llm](https://github.com/user/local-llm)）
- Embedding サービス（任意、daemon または CLI）

### セットアップ

```bash
# 1. クローンとインストール
git clone https://github.com/user/memory-router.git
cd memory-router
bun install

# 2. PostgreSQL + pgvector を起動
docker compose up -d

# 3. 環境変数を設定
cp .env.example .env
# 必要に応じて .env を編集（デフォルトでローカル開発が可能）

# 4. データベースマイグレーション
bun run db:migrate

# 5. プロジェクトの初期化
bun run init:project -- --distill-sources-apply --json
```

`init:project` の出力には、次アクション（`compile` / `doctor` / draft review）が含まれます。
まずは次のコマンドで動作確認できます。

```bash
bun run doctor
bun run compile --goal "このリポジトリの開発フローを把握したい" --intent plan --json
```

### 開発サーバーの起動

```bash
bun run dev
```

- **UI**: http://localhost:5173
- **API**: 同一オリジンの `/api/*`

---

## 仕組み

memory-router は 3 段階のパイプラインで動作します。

### ステージ 1: 収集

複数のソースから raw evidence を取り込みます。

```bash
# Markdown ドキュメントをインポート
bun run import:wiki ./wiki/pages

# エージェント会話ログを同期（Codex / Antigravity）
bun run sync:agent-logs
```

### ステージ 2: 蒸留

ローカル LLM を使い、raw evidence を構造化された **ルール** と **手順** に変換します。

```bash
# 会話ログから蒸留（まず dry-run で確認）
bun run distill:vibe-memory
bun run distill:vibe-memory -- --apply

# Wiki / ドキュメントから蒸留
bun run distill:sources
bun run distill:sources -- --apply
```

蒸留パイプラインの動作:
1. raw evidence をローカル LLM（デフォルト: Gemma4）に送信
2. LLM は `search_web` / `fetch_content` ツールを使い、外部の主張を検証可能
3. スコアが閾値未満（デフォルト: 0.75）の候補は自動的に却下
4. 合格した候補は passage embedding 付きの `draft` knowledge として保存

### ステージ 3: コンパイル

現在のタスクに最適な、トークンバジェット内のコンテキストパックを生成します。

```bash
bun run compile --goal "認証ミドルウェアを修正する" --intent edit
```

コンパイラの動作:
1. intent と goal キーワードからリトリーバルモードを解決
2. リポジトリスコープで knowledge を検索（ハイブリッド: 全文 + ベクトル）
3. 重み付きスコア（importance, confidence, source evidence）でランキング
4. トークンバジェットをセクションに配分（rules → procedures → sources）
5. 診断情報付きの構造化 Markdown コンテキストパックを返却

---

## MCP 連携

memory-router は [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) サーバーを提供し、AI コーディングエージェントとシームレスに連携できます。

### MCP サーバーの起動

```bash
bun run start:mcp
```

### エージェントへの設定

MCP クライアントの設定に追加:

```json
{
  "mcpServers": {
    "memory-router": {
      "command": "bun",
      "args": ["run", "start:mcp"],
      "cwd": "/path/to/memory-router"
    }
  }
}
```

### 公開 MCP ツール

| ツール | 用途 | 使用タイミング |
|---|---|---|
| `initial_instructions` | エージェントへの操作ガイダンス | セッション開始時に 1 回 |
| `context_compile` | タスク用コンテキストパック生成 | **主導線** — 毎タスクの作業前に |
| `search_knowledge` | knowledge 候補の直接検索 | `context_compile` の結果を深掘りしたい時 |
| `register_knowledge` | 新しいルールや手順の登録 | 再利用可能なパターンを発見した時 |
| `list_knowledge` | draft/active/deprecated 一覧の取得 | 知識のライフサイクルを管理したい時 |
| `update_knowledge` | 状態/タイトル/本文/メタデータの更新 | 知識の昇格や廃止を行いたい時 |
| `memory_search` | 過去の会話・差分を検索 | 特定の過去コンテキストを探す時 |
| `memory_fetch` | 特定メモリの詳細取得 | 特定の会話を精査する時 |
| `doctor` | システム診断 | compile が degraded/failed の時 |

### 推奨ワークフロー

```
1. initial_instructions     → 操作ルールを取得
2. context_compile          → タスク固有のコンテキストを取得（主導線）
3. search_knowledge         → 必要に応じて深掘り（補助）
4. ... 作業を実行 ...
5. register_knowledge       → 再利用可能な発見を保存
6. doctor                   → 問題発生時にシステム状態を確認
```

MCP ツールの完全な入出力仕様は [docs/mcp-tools.md](docs/mcp-tools.md) を参照してください。

---

## CLI リファレンス

| コマンド | 説明 |
|---|---|
| `bun run init:project` | 初回オンボーディング（インポート、プリセット、蒸留、テストコンパイルを一括実行） |
| `bun run compile` | コンテキストパックをコンパイル |
| `bun run import:wiki <path>` | Markdown を sources にインポート |
| `bun run import:markdown <file>` | 単一 Markdown ファイルをインポート |
| `bun run sync:agent-logs` | Codex / Antigravity のログを同期 |
| `bun run distill:vibe-memory` | 会話ログから knowledge を蒸留 |
| `bun run distill:sources` | Wiki ソースから knowledge を蒸留 |
| `bun run doctor` | システム診断を実行 |
| `bun run backfill:knowledge-project-context` | 既存 knowledge にプロジェクトコンテキストをバックフィル |

### コールドスタート・フロー

新規リポジトリで `init:project` を使用すると、初期設定から動作確認までを一貫して行えます。

```bash
# wiki インポート + グローバルプリセット投入 + テストコンパイル
bun run init:project -- --wiki-root ./wiki/pages

# ソース蒸留を含める (dry-run)
bun run init:project -- --wiki-root ./wiki/pages --distill-sources

# ソース蒸留を実行し、生成された draft knowledge を保存する
bun run init:project -- --wiki-root ./wiki/pages --distill-sources-apply
```

- グローバルプリセットのエントリは `scope: global` として保存されます。
- リポジトリ固有の知識は `import:wiki` / `distill:sources` を通じて `scope: repo` に保持されます。
- テストコンパイルで関連アイテムが見つからない場合、具体的な次アクションが表示されます。

### 使用例

```bash
# intent 指定と JSON 出力
bun run compile --goal "コンテキストコンパイラを修正" --intent edit --json

# 件数を制限して蒸留
bun run distill:vibe-memory -- --apply --limit 20
bun run distill:vibe-memory -- --apply --session-id <id>

# 特定ソースを指定して蒸留
bun run distill:sources -- --apply --uri /path/to/page.md
bun run distill:sources -- --apply --source-kind wiki --limit 20
```

---

## API リファレンス

REST API は Web UI に使用され、独立して利用することもできます。

| メソッド | エンドポイント | 説明 |
|---|---|---|
| `POST` | `/api/context/compile` | コンテキストパックをコンパイル |
| `GET` | `/api/context/runs` | 最近のコンパイル実行を一覧 |
| `GET` | `/api/doctor` | システム診断レポート |
| `GET` | `/api/knowledge` | knowledge 一覧 / 検索 |
| `POST` | `/api/knowledge` | knowledge 作成 |
| `PUT` | `/api/knowledge/:id` | knowledge 更新 |
| `DELETE` | `/api/knowledge/:id` | knowledge 削除 |
| `GET` | `/api/sources/tree` | Wiki ソースツリー |
| `GET/POST` | `/api/sources/folders` | フォルダ一覧 / 作成 |
| `PUT/DELETE` | `/api/sources/folders/:id` | フォルダ更新 / 削除 |
| `GET/POST` | `/api/sources/pages` | ページ一覧 / 作成 |
| `GET/PUT/DELETE` | `/api/sources/pages/:id` | ページ取得 / 更新 / 削除 |
| `GET` | `/api/sources/history/:id` | ページの Git 履歴 |
| `GET` | `/api/sources/diff/:id` | コミット間の差分 |
| `GET/POST` | `/api/vibe-memory` | vibe memory 一覧 / 作成 |
| `GET/DELETE` | `/api/vibe-memory/:id` | vibe memory 取得 / 削除 |
| `GET` | `/api/agent-diffs` | agent diff エントリ一覧 |
| `GET` | `/api/graph` | Knowledge Graph データ |

API サーバーの起動:

```bash
bun run start:api
```

---

## データモデル

memory-router は **evidence（証拠）** と **instruction（指示）** を明確に分離します。

### Evidence 層

| テーブル | 説明 |
|---|---|
| `sources` | Wiki コンテンツルート。人間が編集する Markdown はここに集約。 |
| `source_fragments` | Wiki ページの内部検索インデックス。ユーザーの入力口ではない。 |
| `vibe_memories` | AI エージェントとの自然言語会話ログ。diff 本文は含まない。 |
| `agent_diff_entries` | 会話中のコード差分。`diff_hunk` と抽出したシンボルを保存。 |

### Knowledge 層

| テーブル | 説明 |
|---|---|
| `knowledge_items` | 蒸留されたルールと手順。`type: rule \| procedure`、`status: draft \| active \| deprecated`、`scope: repo \| global`。 |
| `knowledge_source_links` | knowledge と元ソースエビデンスの接続。 |

### 処理層

| テーブル | 説明 |
|---|---|
| `vibe_memory_distillation_runs` | 会話ログからの蒸留履歴。 |
| `source_distillation_runs` | Wiki ソースからの蒸留履歴。 |
| `source_distillation_evidence` | 蒸留中に取得した外部エビデンス。 |
| `context_compile_runs` | コンパイル実行履歴と診断情報。 |
| `context_pack_items` | 各コンパイル実行で選択されたアイテム。 |
| `sync_states` | エージェントログ同期のカーソルとタイムスタンプ。 |

---

## Wiki 管理

デフォルトのコンテンツルートは `./wiki` です。`wiki/` ディレクトリはメインリポジトリからは gitignore され、独立した Git リポジトリとして運用されます。`.git` がない場合は自動初期化され、ページ操作時に自動的にコミットが行われます。

```bash
# Wiki の場所を変更する場合
MEMORY_ROUTER_SOURCE_CONTENT_ROOT=/path/to/your/wiki
```

---

## 自動化

### エージェントログ同期

Codex と Antigravity の会話ログを継続的に取り込みます。

```bash
# 一度だけ同期
bun run sync:agent-logs

# macOS LaunchAgent としてインストール
./scripts/setup-automation.sh install
./scripts/setup-automation.sh load
./scripts/setup-automation.sh status
```

デフォルトのログ参照先:
- Codex: `~/.codex/sessions` および `~/.codex/archived_sessions`
- Antigravity: `~/.gemini/antigravity/brain`

### 蒸留の自動化

スケジュール実行の設定:

```bash
# Vibe memory 蒸留
./scripts/setup-distillation-automation.sh install
./scripts/setup-distillation-automation.sh load

# ソース蒸留
./scripts/setup-source-distillation-automation.sh install
./scripts/setup-source-distillation-automation.sh load
```

---

## Embedding

memory-router は 2 つの embedding プロバイダを自動フォールバック付きでサポートします。

| プロバイダ | 説明 | 設定 |
|---|---|---|
| **daemon**（デフォルト） | HTTP API embedding サービス | `MEMORY_ROUTER_EMBEDDING_DAEMON_URL` |
| **cli** | Python CLI フォールバック（`e5embed.cli`） | `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_*` |

```bash
# プロバイダ選択
MEMORY_ROUTER_EMBEDDING_PROVIDER=auto|daemon|cli|disabled
```

`auto`（デフォルト）では daemon を優先し、失敗時に CLI にフォールバックします。

---

## テスト

```bash
# フル検証ゲート（typecheck + lint + format + unit tests + web build）
bun run verify

# MCP 固有の検証
bun run verify:mcp

# 統合テスト（テスト用データベースが必要）
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test \
  bun run test:integration

# E2E UI テスト
bun run test:e2e
```

> **⚠️ 注意**: `test:integration` はターゲットデータベースのテーブルを truncate します。必ず専用のテストデータベース（名前に `test` を含む）を使用してください。

---

## 設定

すべての設定は環境変数で行います。完全な一覧とデフォルト値は [`.env.example`](.env.example) を参照してください。

### 基本

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `DATABASE_URL` | `postgres://...localhost:7889/memory_router` | PostgreSQL 接続文字列 |
| `MEMORY_ROUTER_SOURCE_CONTENT_ROOT` | `./wiki` | Wiki コンテンツディレクトリ |

### Embedding

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `MEMORY_ROUTER_EMBEDDING_PROVIDER` | `auto` | `auto`、`daemon`、`cli`、`disabled` |
| `MEMORY_ROUTER_EMBEDDING_DAEMON_URL` | `http://127.0.0.1:44512` | Embedding daemon の URL |
| `MEMORY_ROUTER_EMBEDDING_DIMENSION` | `384` | Embedding ベクトル次元数 |

### 蒸留（LLM）

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL` | `http://127.0.0.1:44448` | ローカル LLM API エンドポイント |
| `MEMORY_ROUTER_LOCAL_LLM_MODEL` | `gemma-4-e4b-it` | LLM モデル名 |
| `MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE` | `0.75` | 候補の最低スコア閾値 |

### エージェントログ同期

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `MEMORY_ROUTER_CODEX_SESSION_DIR` | `~/.codex/sessions` | Codex セッションディレクトリ |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity/brain` | Antigravity ログディレクトリ |
| `MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS` | `3600` | 同期間隔（秒） |
| `MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS` | `168` | 初回取り込みの遡及時間 |

---

## プロジェクト構成

```
memory-router/
├── src/
│   ├── cli/              # CLI コマンド（compile, sync, distill, doctor, import）
│   ├── db/               # Drizzle ORM スキーマ + クライアント
│   ├── mcp/              # MCP サーバー + ツール定義
│   │   └── tools/        # ツール実装
│   ├── modules/
│   │   ├── context-compiler/   # コアコンパイルエンジン（ranking, query, budgeting）
│   │   ├── knowledge/          # Knowledge リポジトリ + サービス
│   │   ├── vibe-memory/        # 会話ログ取り込み + 蒸留
│   │   ├── sources/            # Wiki 管理 + ソース蒸留
│   │   ├── distillation/       # 共通蒸留ランタイム + プロンプト
│   │   ├── embedding/          # Embedding サービス（daemon / CLI）
│   │   └── doctor/             # システム診断
│   └── shared/schemas/   # Zod バリデーションスキーマ
├── api/                  # Hono REST API
├── web/                  # React フロントエンド（Vite + TanStack）
├── test/                 # ユニット + 統合テスト
├── tests/                # E2E テスト（Playwright）
├── wiki/                 # Wiki コンテンツ（独立 Git リポジトリ）
├── drizzle/              # データベースマイグレーション
├── scripts/              # 自動化セットアップスクリプト
└── docs/                 # アーキテクチャ・計画ドキュメント
```

---

## ドキュメント

| ドキュメント | 説明 |
|---|---|
| [MCP Tool Contract](docs/mcp-tools.md) | MCP ツールの完全な入出力仕様 |
| [改善計画](docs/improvement-plan.md) | 現在のロードマップと受け入れ基準 |
| [Context Compile/MCP Plan](docs/context-compile-mcp-improvement-plan.md) | Context Compile と MCP の改善ロードマップ |
| [Knowledge Value Lifecycle](docs/knowledge-value-lifecycle.md) | 知識のライフサイクル運用ポリシー |

---

## コントリビューション

1. リポジトリをフォーク
2. フィーチャーブランチを作成（`git checkout -b feature/amazing-feature`）
3. コミット前に検証ゲートを実行:
   ```bash
   bun run verify
   ```
4. 変更をコミット
5. ブランチにプッシュ
6. Pull Request を作成

### 開発のヒント

- `bun run verify` が品質ゲート（typecheck → lint → format → unit tests → web build）
- `test:unit` は Vitest を介してすべての `test/**/*.test.ts` および `web/src/**/*.test.ts(x)` を実行します（統合/E2Eテストは除外）
- 統合テストには `memory_router_test` データベースが必要
- `wiki/` ディレクトリは独自の Git リポジトリを持つ

---

## ライセンス

MIT
