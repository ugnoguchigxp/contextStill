<p align="center">
  <strong>context-still</strong><br/>
  <em>AI コーディングエージェントのための local-first knowledge control plane</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#目次">目次</a> ·
  <a href="#デスクトップクイックスタート">デスクトップクイックスタート</a> ·
  <a href="#mcp-integration">MCP Integration</a> ·
  <a href="#ドキュメント">ドキュメント</a> ·
  <a href="#開発">開発</a> ·
  <a href="README.md">English</a>
</p>

---

## context-still とは

context-still は、AI コーディングエージェントの記憶を扱う local-first な control plane です。Wiki / docs、Web research、agent log、明示的に登録された candidate note から再利用可能な `rule` / `procedure` knowledge を作り、タスクごとに必要な context pack を MCP、CLI、API、管理 UI から取得できるようにします。

既定の product path は desktop / local です。

- storage: ローカル app data 配下の SQLite
- UI: local admin / control-plane 体験。Tauri packaging を desktop target として扱う
- MCP: ユーザーが有効化する任意の agent integration
- model usage: minimal local usage を先に成立させ、local LLM / cloud-assisted mode は任意の拡張にする

基本ループは次の通りです。

```text
evidence を集める -> knowledge に蒸留する -> task context を compile する -> 有用性を評価する -> 新しい学びを candidate 登録する
```

主な機能:

- source link と candidate review を持つ evidence-backed knowledge distillation
- `initial_instructions`、`context_compile`、`compile_eval`、`context_decision`、knowledge / memory / episode search、candidate 登録の MCP tools
- primary knowledge / search / context compile path 用の SQLite local storage
- Codex、Antigravity、Claude log の同期
- queue worker による staged distillation と health diagnostics
- graph、replay、review item、approval-gated candidate を扱う Knowledge Landscape
- 自律判断の execute / escalate、Knowledge evidence、coverage trace、feedback を保存する Decision 履歴

context-still は hosted SaaS ではありません。DB、source、settings、API/admin runtime、automation worker、MCP registration は自分の環境で管理します。

## 目次

- [context-still とは](#context-still-とは)
- [デスクトップクイックスタート](#デスクトップクイックスタート)
- [Product Modes](#product-modes)
- [MCP Integration](#mcp-integration)
- [Advanced Server Backend](#advanced-server-backend)
- [よく使うワークフロー](#よく使うワークフロー)
- [ドキュメント](#ドキュメント)
- [開発](#開発)
- [コントリビュート](#コントリビュート)
- [License](#license)

## デスクトップクイックスタート

現時点の前提:

- [Bun](https://bun.sh/) 1.3+

clone して依存関係を入れます。

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
```

最初の health check:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run doctor
```

タスク用 context を compile:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run compile --goal "このリポジトリの開発フローを把握したい" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

管理 UI と API を起動:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run dev
```

- UI: http://localhost:39171
- API: 同一 origin の `/api/*`

将来の Tauri shell は、同じ SQLite-first default、desktop data path、doctor state を使います。packaging が入るまでは、local web/admin runtime が desktop product path の開発 baseline です。

対話型の `startup` command は現時点では advanced server setup path です。desktop / local development では上記の明示的な SQLite commands を使ってください。

## Product Modes

| Mode | 目的 | 必須セットアップ |
|---|---|---|
| `minimal` | SQLite + local sources + manual/MCP candidates + context compile | Bun と local SQLite path |
| `cloud-review` | cloud LLM assisted distillation、review、decision support | provider credentials と route settings |
| `local-llm` | local LLM / local embedding assisted distillation | local OpenAI-compatible endpoint や embedding service |

Minimal mode は、外部 LLM、外部 search API、MCP client registration がなくても使える状態を維持します。

## MCP Integration

MCP server だけを起動:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run start:mcp
```

MCP client には次のように登録します。

```json
{
  "mcpServers": {
    "context-still": {
      "command": "bun",
      "args": ["run", "start:mcp"],
      "cwd": "/path/to/contextStill",
      "env": {
        "CONTEXT_STILL_DB_BACKEND": "sqlite"
      }
    }
  }
}
```

接続後は、project session 開始時に `initial_instructions` を一度だけ呼びます。作業前に `context_compile`、ユーザーへ質問する前や PR 作成前に自律継続できる余地がある場合は `context_decision`、作業後に `compile_eval` を使います。

MCP は agent integration surface です。local app を開くことや既存 knowledge を確認することの隠れた必須条件ではありません。

## Advanced Server Backend

PostgreSQL / pgvector backend は、advanced server-style deployment と compatibility work のために残します。既定の desktop / local path には不要です。

明示的に server backend をテスト・運用する場合だけ使います。

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
bun run verify:postgres
```

server backend の制約は [Architecture Overview](spec/pub/architecture.md) と [Operations](spec/pub/operations.md) に記載しています。server productization、auth、multi-user operation、remote DB latency assumptions が固まるまでは opt-in path として扱います。

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
| [Getting Started](spec/pub/getting-started.md) | Desktop quick start、MCP integration、最初の compile |
| [Architecture Overview](spec/pub/architecture.md) | product modes、backend boundaries、runtime components |
| [MCP Tools](spec/pub/mcp-tools.md) | MCP tool contract と推奨 workflow |
| [CLI Reference](spec/pub/cli.md) | コマンド一覧と例 |
| [REST API Reference](spec/pub/api.md) | HTTP API endpoint inventory |
| [Configuration](spec/pub/configuration.md) | desktop defaults と advanced configuration |
| [Operations](spec/pub/operations.md) | doctor、backup、automation、server backend operations |

内部実装計画と設計メモは `spec/docs/` にあります。

## 開発

Pull request 前の日常 fast gate:

```bash
bun run verify
```

packaging や Tauri shell work の前に使う desktop/local readiness gate:

```bash
bun run verify:desktop-readiness
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
bun run verify:sqlite
bun run verify:mcp
bun run verify:queue:smoke
```

`bun run verify` は typecheck、lint、format check、unit test、web build に限定した fast gate です。Integration、MCP、server backend、queue smoke は別 gate です。Integration test と queue smoke は破壊的です。必ず名前に `test` を含む専用 DB を使ってください。

## コントリビュート

Issue や pull request の前に [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、[SUPPORT.md](SUPPORT.md) を確認してください。

## License

[MIT](LICENSE)
