<p align="center">
  <strong>context-still</strong><br/>
  <em>AI コーディングエージェントのための local-first adaptive knowledge compiler</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#目次">目次</a> ·
  <a href="#インストール">インストール</a> ·
  <a href="#クイックスタート">クイックスタート</a> ·
  <a href="#ドキュメント">ドキュメント</a> ·
  <a href="#コントリビュート">コントリビュート</a> ·
  <a href="README.md">English</a>
</p>

---

## context-still とは

context-still は、AI コーディングエージェント向けの local-first な adaptive knowledge compiler です。Wiki / docs、Web ページ、agent log、明示的に登録された candidate note から再利用可能な `rule` / `procedure` knowledge を作り、タスクごとに必要な context pack を MCP、CLI、API、管理 UI から取得できるようにします。

基本ループは次の通りです。

```text
evidence を集める -> knowledge に蒸留する -> task context を compile する -> 有用性を評価する -> 新しい学びを candidate 登録する
```

主な機能:

- source link と candidate review を持つ evidence-backed knowledge distillation
- `initial_instructions`、`context_compile`、`compile_eval`、`context_decision`、knowledge / memory search、candidate 登録の MCP tools
- PostgreSQL/pgvector と React 管理 UI
- Codex、Antigravity、Claude log の同期
- queue worker による staged distillation と health diagnostics
- graph、replay、review item、approval-gated candidate を扱う Knowledge Landscape
- 自律判断の execute / escalate、Knowledge evidence、coverage trace、Good/Bad や system feedback を保存する Decision 履歴

context-still は hosted SaaS ではありません。DB、API、MCP server、automation worker、管理 UI を自分の環境で動かす local-first infrastructure です。

## 目次

- [context-still とは](#context-still-とは)
- [インストール](#インストール)
- [クイックスタート](#クイックスタート)
- [よく使うワークフロー](#よく使うワークフロー)
- [ドキュメント](#ドキュメント)
- [開発](#開発)
- [コントリビュート](#コントリビュート)
- [License](#license)

## インストール

前提:

- [Bun](https://bun.sh/) 1.3+
- PostgreSQL + pgvector 用の [Docker](https://www.docker.com/)
- 任意の local LLM / embedding service

clone して依存関係を入れます。

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
```

推奨セットアップは対話型の startup command です。Docker、DB migration、LLM / embedding 設定、smoke compile、doctor diagnostics をまとめて確認します。

```bash
bun run startup
```

`startup` はデフォルトで dry-run です。表示された plan を確認してから適用します。

```bash
bun run startup -- --apply
```

手動セットアップも可能です。

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
bun run init:project -- --json
```

設定は環境変数で行います。まず [`.env.example`](.env.example) を使い、詳細は [Configuration](spec/pub/configuration.md) を参照してください。

## クイックスタート

最初の health check:

```bash
bun run doctor
```

タスク用 context を compile:

```bash
bun run compile --goal "このリポジトリの開発フローを把握したい" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

管理 UI と API を起動:

```bash
bun run dev
```

- UI: http://localhost:39171
- API: 同一 origin の `/api/*`

MCP server だけを起動:

```bash
bun run start:mcp
```

MCP client には次のように登録します。

```json
{
  "mcpServers": {
    "context-still": {
      "command": "bun",
      "args": ["run", "start:mcp"],
      "cwd": "/path/to/contextStill"
    }
  }
}
```

接続後は、project session 開始時に `initial_instructions` を一度だけ呼びます。作業前に `context_compile`、ユーザーへ質問する前や PR 作成前に自律継続できる余地がある場合は `context_decision`、作業後に `compile_eval` を使います。

## よく使うワークフロー

ローカル source docs を import:

```bash
bun run import:wiki ./wiki/pages
```

ローカル agent logs を同期:

```bash
bun run sync:agent-logs
```

distillation pipeline を 1 stage ずつ実行:

```bash
bun run queue:finding:once
bun run queue:covering:once
bun run queue:merge-review:once
bun run queue:finalize:once
bun run queue:merge-activation-finalize:once
```

Context Decision に紐づく PR が closed/discarded になっているかを scan し、明示的に適用した場合だけ `discarded_pr` feedback を記録:

```bash
bun run decision:pr-discard-scan -- --dry-run
bun run decision:pr-discard-scan -- --apply
```

macOS の local automation を install:

```bash
bun run automation:agent-log-sync -- install
bun run automation:agent-log-sync -- load
bun run automation:queue-supervisor -- install
bun run automation:queue-supervisor -- load
```

compile evaluation と candidate 登録を促す任意の Git hooks:

```bash
./scripts/setup-candidate-registration-hook.sh install
```

## ドキュメント

公開向けドキュメントは `spec/pub/` にあります。

| Document | Purpose |
|---|---|
| [Documentation Index](spec/pub/README.md) | 公開ドキュメントの目次 |
| [Getting Started](spec/pub/getting-started.md) | インストール、起動、最初の compile |
| [Architecture Overview](spec/pub/architecture.md) | 主要概念と runtime components |
| [MCP Tools](spec/pub/mcp-tools.md) | MCP tool contract と推奨 workflow |
| [CLI Reference](spec/pub/cli.md) | コマンド一覧と例 |
| [REST API Reference](spec/pub/api.md) | HTTP API endpoint inventory |
| [Configuration](spec/pub/configuration.md) | 環境変数と local services |
| [Operations](spec/pub/operations.md) | automation、queue worker、backup、diagnostics |

内部実装計画と設計メモは `spec/docs/` にあります。

## 開発

Pull request 前の日常 fast gate:

```bash
bun run verify
```

tag / release 前の full gate:

```bash
bun run verify:full
```

よく使う確認:

```bash
bun run typecheck
bun run test:unit
bun run build:web
bun run verify:mcp
bun run verify:queue:smoke
```

`bun run verify` は typecheck、lint、format check、unit test、web build に限定した fast gate です。Integration、MCP、queue smoke は別 gate です。Integration test と queue smoke は破壊的です。必ず名前に `test` を含む専用 DB を使ってください。

## コントリビュート

Issue や pull request の前に [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、[SUPPORT.md](SUPPORT.md) を確認してください。

## License

[MIT](LICENSE)
