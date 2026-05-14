# memory-router

`memory-router` は、コーディングエージェント向けのローカルファースト Context Compiler です。  
`knowledge` / `sources` / `activity`（Vibe Memory + Artifacts）から、作業目的に合わせた最小コンテキストを組み立てます。

## 主要機能

- Context Compile（CLI / MCP / API）
  - `sources/source_fragments` を根拠ソースとして検索し、Context Pack には `sourceRefs` を付与します
- Knowledge 管理（作成・編集・削除）
- Source 管理（このリポジトリ配下 `./wiki` を運用）
  - フォルダ作成・リネーム・削除
  - ページ作成・編集・削除
  - Git 履歴表示・コミット差分表示
  - `markdown-wysiwyg-editor` による Markdown 編集
- Artifact Symbol 管理（作成・閲覧）
- Graph 可視化
- Doctor 診断

## Source 管理の前提

- 既定のコンテンツルートは `./wiki`
- 配下の `pages/` をソース本体として扱います
- ルートに `.git` が無ければ自動初期化し、ページ操作時に commit します
- `wiki/` はこのプロジェクトで `gitignore` され、独立リポジトリとして運用できます

設定で切り替える場合:

- `MEMORY_ROUTER_SOURCE_CONTENT_ROOT=/abs/path/to/wiki`

## 必要環境

- Bun 1.3+
- Docker（PostgreSQL + pgvector 起動用）

## セットアップ

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

Context Pack 生成:

```bash
bun run compile --goal "fix context compiler" --intent edit --json
```

Markdown 一括取り込み（sources + knowledge）:

```bash
bun run import:markdown ./docs
bun run import:sources ./wiki/pages
```

Doctor:

```bash
bun run doctor
```

## Embedding

既定は sibling repo `../local-llm/embedding` を参照します。

- daemon 優先 (`MEMORY_ROUTER_EMBEDDING_DAEMON_URL`)
- fallback: Python CLI (`MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_PYTHON -m e5embed.cli`)

主要設定:

- `MEMORY_ROUTER_EMBEDDING_PROVIDER=auto|daemon|cli|disabled`
- `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_ROOT`
- `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_PYTHON`
- `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_MODEL_DIR`

## API

主要エンドポイント:

- `GET /api/health`
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
- `GET/POST /api/activity`
- `GET/DELETE /api/activity/:id`
- `GET /api/artifacts`
- `GET /api/artifacts/symbols`
- `GET /api/graph`

`POST /api/activity` は vibe memory の本文に加えて `diff` または `artifacts[]` を受け取れます。
unified diff はファイル単位の artifact に分解され、TypeScript/JavaScript の主要シンボルは
`artifact_symbols` に自動登録されます。`memory_search` は vibe 本文だけでなく artifact 本文、
diff、symbol 名も検索対象にします。

## MCP

起動:

```bash
bun run start:mcp
```

公開ツール:

- `context_compile`
- `record_vibe_memory`: `content` に加えて `diff` / `artifacts[]` を受け取り、
  vibe memory、AI artifact、artifact symbol を同一トランザクションで保存します。
- `memory_search`: vibe memory と関連 artifact/symbol を検索します。
- `memory_fetch`: vibe memory と関連 artifact/symbol をまとめて取得します。
- `initial_instructions`
- `doctor`

## テスト

```bash
bun run verify
bun run test:integration
bun run test:e2e
```

## ドキュメント

- [docs/initial-implementation-plan.md](/Users/y.noguchi/Code/memoryRouter/docs/initial-implementation-plan.md)
- [docs/deferred-tasks-resumption-plan.md](/Users/y.noguchi/Code/memoryRouter/docs/deferred-tasks-resumption-plan.md)
- [docs/source-distillation-migration-plan.md](/Users/y.noguchi/Code/memoryRouter/docs/source-distillation-migration-plan.md)
- [docs/improvement-plan.md](/Users/y.noguchi/Code/memoryRouter/docs/improvement-plan.md)
