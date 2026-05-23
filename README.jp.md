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
│  │ Value  │ │ Tool Loop   │  │               │
│  │ Gate   │ │ search_web  │  │               │
│  │ >50    │ │ fetch docs  │  │               │
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

### プロジェクトの現在地

memory-router は、個人またはチームのコーディングエージェント運用を支える local-first プロジェクトです。ローカル MCP サーバー、REST API、管理 UI として利用できますが、ホスト型のマルチテナント SaaS ではありません。利用者自身の PostgreSQL/pgvector を起動し、蒸留された `draft` knowledge は `active` に昇格する前にレビューする前提です。

このプロジェクトは、見えない自動化よりも監査可能性を優先します。compile run、選出 knowledge、source link、distillation candidate、evidence check、health diagnostic を保存し、なぜその context pack が出力されたのかを後から確認できるようにしています。

---

## クイックスタート

### 前提条件

- [Bun](https://bun.sh/) 1.3+
- [Docker](https://www.docker.com/)（PostgreSQL + pgvector 用）
- ローカル LLM サーバー（蒸留用、任意。デフォルトでは `http://127.0.0.1:44448` の OpenAI 互換エンドポイントを使用）
- Embedding サービス（任意、daemon または CLI）

### セットアップ

```bash
# 1. クローンとインストール
git clone https://github.com/ugnoguchigxp/memoryRouter.git
cd memoryRouter
bun install

# 2. PostgreSQL + pgvector を起動
docker compose up -d

# 3. 環境変数を設定
cp .env.example .env
# 必要に応じて .env を編集（デフォルトでローカル開発が可能）

# 4. データベースマイグレーション
bun run db:migrate

# 5. プロジェクトの初期化
bun run init:project -- --json
```

`init:project` の出力には、次アクション（`compile` / `doctor` / draft review）が含まれます。
まずは次のコマンドで動作確認できます。

```bash
bun run doctor
bun run compile --goal "このリポジトリの開発フローを把握したい" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

### 開発サーバーの起動

```bash
bun run dev
```

- **UI**: http://localhost:5173
- **API**: 同一オリジンの `/api/*`

管理 UI には knowledge、source page、graph、compile history、doctor、audit log、distillation candidate のビューがあります。Candidates ビューでは、候補が stored knowledge になったか、finalize 待ちか、rejected か、retryable か、raw candidate のままかを確認できます。

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
# 1 件だけ staged distillation を実行（wiki 優先の auto selection）
bun run distill:pipeline:once

# 対象種別を明示して実行
bun run distill:pipeline -- --write --limit 1 --kind wiki
bun run distill:pipeline -- --write --limit 1 --kind vibe
```

staged distillation パイプラインの動作:
1. Wiki file または agent memory から対象を選択
2. 最小候補を `find_candidate_results` に抽出
3. source support、duplicate/near-duplicate、外部主張を `cover_evidence_results` で検証
4. `search_web` で source URL を探し、外部主張は `fetch_content` 成功結果で根拠付ける。検索結果と fetch 結果は `distillation_evidence_cache` に保存
5. `knowledge_ready` かつ価値が十分な候補（`importance > 50`）を passage embedding 付きの `draft` knowledge として保存

candidate outcome は final knowledge と分離されています。`rejected` は `duplicate`、`near_duplicate`、`unsupported_by_source`、`not_actionable`、`external_fetch_evidence_missing` などの終端理由を表し、provider/tool/parse failure のような再試行可能な失敗は `retryable` として別扱いです。

### ステージ 3: コンパイル

現在のタスクに最適な、トークンバジェット内のコンテキストパックを生成します。

```bash
bun run compile --goal "認証ミドルウェアを修正する" \
  --change-types bugfix,backend \
  --domains auth
```

コンパイラの動作:
1. `changeTypes` と goal キーワードからリトリーバルモードを解決
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
| `register_candidate` | 軽量な rule/procedure 候補の登録 | 再利用可能なパターンを発見した時 |
| `search_memory` | 過去の会話・差分を検索 | 候補メモリを ID ベースで特定したい時 |
| `fetch_memory` | 特定メモリの詳細取得 | 特定の会話を詳細に精査したい時 |
| `doctor` | システム診断 | compile が degraded/failed の時 |

旧名エイリアス: `memory_search` -> `search_memory`, `memory_fetch` -> `fetch_memory`。

### 推奨ワークフロー

```
1. initial_instructions     → 操作ルールを取得
2. context_compile          → タスク固有のコンテキストを取得（主導線）
3. search_knowledge         → 必要に応じて深掘り（補助）
4. search_memory/fetch_memory → 必要時だけ過去会話を参照
5. ... 作業を実行 ...
6. register_candidate       → 再利用可能な発見を候補として保存
7. doctor                   → 問題発生時にシステム状態を確認
```

MCP ツールの完全な入出力仕様は [docs/mcp-tools.md](docs/mcp-tools.md) を参照してください。

---

## CLI リファレンス

| コマンド | 説明 |
|---|---|
| `bun run init:project` | 初回オンボーディング（インポート、プリセット、テストコンパイルを一括実行） |
| `bun run compile` | コンテキストパックをコンパイル |
| `bun run import:wiki <path>` | Markdown を sources にインポート |
| `bun run import:markdown <file>` | 単一 Markdown ファイルをインポート |
| `bun run sync:agent-logs` | Codex / Antigravity のログを同期 |
| `bun run distill:pipeline:once` | staged distillation を 1 件実行 |
| `bun run distill:pipeline -- --write --limit 1 --kind wiki` | staged distillation pipeline を明示実行 |
| `bun run distill-target:refresh` | wiki/vibe/candidate の distillation target を更新 |
| `bun run distill:status` | distillation target queue と進捗カウンタを表示 |
| `bun run distill-target:release-stale` | stale な running distillation target を解放 |
| `bun run doctor` | システム診断を実行 |
| `bun run backfill:knowledge-project-context` | 既存 knowledge にプロジェクトコンテキストをバックフィル |
| `./scripts/backup-db.sh` | PostgreSQL DB を dump して zip 化 |

### コールドスタート・フロー

新規リポジトリで `init:project` を使用すると、初期設定から動作確認までを一貫して行えます。

```bash
# wiki インポート + グローバルプリセット投入 + テストコンパイル
bun run init:project -- --wiki-root ./wiki/pages

# distillation target を更新し、1 件だけ staged distillation を実行
bun run distill-target:refresh
bun run distill:pipeline:once
```

- グローバルプリセットのエントリは `scope: global` として保存されます。
- リポジトリ固有の知識は `import:wiki` / `distill:pipeline` を通じて `scope: repo` に保持されます。
- テストコンパイルで関連アイテムが見つからない場合、具体的な次アクションが表示されます。

### 使用例

```bash
# タスク facet 指定と JSON 出力
bun run compile --goal "コンテキストコンパイラを修正" \
  --change-types bugfix,backend \
  --technologies bun,typescript \
  --domains context-compiler \
  --json

# staged distillation を 1 件実行
bun run distill:pipeline:once

# 対象種別を明示して実行
bun run distill:pipeline -- --write --limit 1 --kind wiki
bun run distill:pipeline -- --write --limit 1 --kind vibe
```

---

## API リファレンス

REST API は Web UI に使用され、独立して利用することもできます。

| メソッド | エンドポイント | 説明 |
|---|---|---|
| `GET` | `/api/health` | API ヘルスチェック |
| `GET` | `/api/overview` | 管理 UI overview メトリクス |
| `POST` | `/api/context/compile` | コンテキストパックをコンパイル |
| `GET` | `/api/context/runs` | 最近のコンパイル実行を一覧 |
| `GET` | `/api/context/runs/:id` | コンパイル実行の詳細 |
| `POST` | `/api/context/runs/:id/knowledge-feedback` | 選出 knowledge への手動 usage feedback を保存 |
| `GET` | `/api/doctor` | システム診断レポート |
| `GET` | `/api/knowledge` | knowledge 一覧 / 検索 |
| `POST` | `/api/knowledge` | knowledge 作成 |
| `POST` | `/api/knowledge/bulk-status` | knowledge の一括 active/deprecated 更新 |
| `PUT` | `/api/knowledge/:id` | knowledge 更新 |
| `POST` | `/api/knowledge/:id/feedback` | 直接 up/down feedback を記録 |
| `DELETE` | `/api/knowledge/:id` | knowledge 削除 |
| `GET` | `/api/knowledge/tags` | applicability tag definition 一覧 |
| `GET` | `/api/sources/health` | source content のヘルスチェック |
| `GET` | `/api/sources/tree` | Wiki ソースツリー |
| `GET` | `/api/sources/search` | source page 検索 |
| `POST` | `/api/sources/reindex` | source fragment を再構築 |
| `GET/POST` | `/api/sources/folders` | フォルダ一覧 / 作成 |
| `PUT/DELETE` | `/api/sources/folders/*` | フォルダ更新 / 削除 |
| `GET/POST` | `/api/sources/pages` | ページ一覧 / 作成 |
| `GET/PUT/DELETE` | `/api/sources/pages/*` | ページ取得 / 更新 / 削除 |
| `GET` | `/api/sources/history/*` | ページの Git 履歴 |
| `GET` | `/api/sources/diff/*` | コミット間の差分 |
| `GET/POST` | `/api/vibe-memory` | vibe memory 一覧 / 作成 |
| `GET/DELETE` | `/api/vibe-memory/:id` | vibe memory 取得 / 削除 |
| `GET` | `/api/agent-diffs` | agent diff エントリ一覧 |
| `GET` | `/api/graph` | Knowledge Graph データ |
| `GET` | `/api/graph/community-labels` | 保存済み community label 一覧 |
| `PUT` | `/api/graph/community-labels/:communityId` | community label の更新 |
| `GET` | `/api/graph/nodes/:id` | Knowledge Graph node 詳細 |
| `GET` | `/api/audit-logs` | Audit log timeline |
| `GET` | `/api/candidates` | distillation candidate 一覧と outcome 統計 |

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
| `distillation_evidence_cache` | 外部 evidence lookup 結果の短期キャッシュ。 |
| `distillation_target_states` | staged distillation の対象選択と lifecycle state。 |
| `find_candidate_results` | `findCandidate` が出力する最小候補行。 |
| `cover_evidence_results` | `find_candidate_results.id` を正本にした evidence coverage 結果。 |
| `knowledge_items` metadata indexes | finalize 済み knowledge から candidate / cover evidence ID へ高速に接続するための index。 |
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
bun run automation:agent-log-sync -- install
bun run automation:agent-log-sync -- load
bun run automation:agent-log-sync -- status

# Windows Task Scheduler
bun run automation:agent-log-sync -- install
bun run automation:agent-log-sync -- load
bun run automation:agent-log-sync -- status
```

デフォルトのログ参照先:
- Codex: `~/.codex/sessions` および `~/.codex/archived_sessions`
- Antigravity: `~/.gemini/antigravity/brain`
- Windows では既定パスに加えて `%APPDATA%` / `%LOCALAPPDATA%` 配下の候補も自動探索します。

### 蒸留の自動化（Conveyor）

staged distillation（`selectDistillationTarget -> findCandidate -> coverEvidence -> finalizeDistille`）をスケジュール実行します。

```bash
# 一度だけ実行
bun run distill:pipeline:once

# macOS LaunchAgent としてインストール
bun run automation:distill-pipeline -- install
bun run automation:distill-pipeline -- load
bun run automation:distill-pipeline -- status

# Windows Task Scheduler
bun run automation:distill-pipeline -- install
bun run automation:distill-pipeline -- load
bun run automation:distill-pipeline -- status
```

進捗確認と復旧:

```bash
bun run distill-target:status
bun run distill-progress
bun run distill-target:release-stale
bun run src/cli/distillation-target.ts release-paused
```

pipeline LaunchAgent の load step は、重複実行を避けるため旧 `vibe/source` distillation job を bootout します。

### データベースバックアップ

```bash
./scripts/backup-db.sh
```

デフォルトでは `memory-router-db` Docker コンテナを使い、`backup/db_backup_<timestamp>.zip` を作成します。ローカル構成が `docker-compose.yml` と異なる場合は `BACKUP_DIR`、`CONTAINER_NAME`、`DB_USER`、`DB_NAME`、`DB_PASSWORD` を上書きできます。

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

## プライバシーと安全性

- 主データストアはローカル PostgreSQL/pgvector です。
- Wiki ページはローカルの `MEMORY_ROUTER_SOURCE_CONTENT_ROOT` 配下に保存されます。
- Agent log sync は設定されたローカルの Codex / Antigravity ログディレクトリを読み込みます。
- 蒸留は、設定した場合に限り外部検索 provider（`brave`, `exa`）や外部 LLM provider（`azure-openai`, `bedrock`）を呼び出します。
- できるだけ local-first に寄せる場合は `MEMORY_ROUTER_DISTILLATION_PROVIDER=local-llm` を使い、検索 API key を設定しないでください。
- `test:integration` は破壊的です。必ず名前に `test` を含む専用 DB を指定してください。

---

## 現在の制約

- ローカル管理 UI には認証やマルチユーザー認可は含まれていません。
- 蒸留結果は `draft` または candidate として登録されます。高品質に運用するには、`active` 昇格前の人間レビューが必要です。
- 外部 evidence coverage は provider の可用性、API key、rate limit に依存します。
- Web UI は admin/control-plane であり、デスクトップアプリやホスト型サービスとしてパッケージされているわけではありません。

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
| `MEMORY_ROUTER_DISTILLATION_PROVIDER` | `local-llm` | `local-llm`、`azure-openai`、`bedrock`、`auto` |
| `MEMORY_ROUTER_DISTILLATION_FIND_CANDIDATE_PROVIDER` | `MEMORY_ROUTER_DISTILLATION_PROVIDER` を継承 | `findCandidate` 専用 provider override。OpenAI/Azure で候補抽出する場合は `azure-openai`、必要に応じて `local-llm` / `bedrock` / `auto` |
| `MEMORY_ROUTER_DISTILLATION_SEARCH_PROVIDERS` | `brave,exa` | `search_web` の provider 順序 |
| `MEMORY_ROUTER_EXA_API_KEY` / `EXA_API_KEY` | 空 | Exa search API key |
| `BRAVE_SEARCH_API_KEY` | 空 | Brave Search API key |

### エージェントログ同期

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `MEMORY_ROUTER_CODEX_SESSION_DIR` | `~/.codex/sessions` | Codex セッションディレクトリ |
| `MEMORY_ROUTER_CODEX_SESSION_DIRS` | 空 | 追加の Codex セッションディレクトリ（`,` / `;` 区切り） |
| `MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIRS` | 空 | 追加の Codex archived session ディレクトリ（`,` / `;` 区切り） |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity/brain` | Antigravity ログディレクトリ |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIRS` | 空 | 追加の Antigravity ログディレクトリ（`,` / `;` 区切り） |
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
├── e2e/                  # E2E テスト（Playwright）
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
| [Project Evaluation](docs/project-evaluation.md) | エビデンスに基づくプロジェクト価値と現在の成熟度 |
| [Knowledge Landscape Concept](docs/knowledge-landscape-concept-design.md) | graph/community/knowledge-field view のコンセプト |
| [Graph Community View Plan](docs/graph-community-view-mvp-plan.md) | Graph community UI/API の実装計画 |
| [Knowledge Usage Signal Redesign](docs/compile-knowledge-usage-signal-redesign-plan.md) | compile run の usage signal と feedback redesign |
| [Knowledge Feedback Staged Learning](docs/knowledge-feedback-staged-learning-plan.md) | 手動 feedback と staged learning 設計 |
| [Doctor Operational Hardening](docs/doctor-distillation-operational-hardening-plan.md) | doctor/distillation health と運用診断 |
| [Failure Experience Candidates](docs/failure-experience-knowledge-candidate-plan.md) | `register_candidate` と失敗経験蒸留の計画 |
| [Web UI Component Refactor](docs/web-ui-component-dry-refactor-plan.md) | 管理 UI コンポーネント整理計画 |

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

[MIT](LICENSE)
