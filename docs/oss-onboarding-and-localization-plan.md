# OSS Onboarding and Localization Implementation Plan

この計画は、`memory-router` を OSS として公開する前に、初回導入と英語圏利用の詰まりを実装可能な単位で解消するための実装計画である。抽象的な将来構想ではなく、現在のコードベースに対してそのままタスク化できる範囲に限定する。

## 目的

- 初回利用者が `README.md` の Quick Start から MCP 登録まで迷わず到達できる状態にする。
- 既存の PostgreSQL + pgvector 前提を維持したまま、導入手順を `bun run setup` に集約する。
- MCP tool contract を壊さず、`initial_instructions` とオンボーディング出力を英語/日本語で切り替えられるようにする。
- OSS 公開前に必要な README / README.jp / MCP docs の導線を実装内容と一致させる。

## 現在の前提

- `package.json` には `init:project` があり、初回 import、global preset、smoke compile、MCP 設定スニペット出力を既に担当している。
- MCP の公開ツールは `docs/mcp-tools.md` 上で 10 個に固定されている。`initial_instructions` は引数なし、`context_compile` は `goal/changeTypes/technologies/domains` のみを受け取る。
- DB 層は `drizzle-orm/node-postgres`、`drizzle-orm/pg-core`、PostgreSQL dialect、`pgvector`、Postgres FTS、GIN/HNSW index に依存している。
- Web UI は React + Vite + TanStack Router で、表示文言は各コンポーネントに直接書かれている。
- 自動化は macOS LaunchAgent と shell script に寄っているが、Quick Start の必須手順ではない。

## 進捗管理

| Milestone | 状態 | 実装 PR の粒度 | 公開前必須 |
|---|---|---|---|
| 0. 実装前の安全柵 | Planned | docs only | yes |
| 1. `bun run setup` の追加 | Planned | 1 PR | yes |
| 2. MCP/CLI 文言の最小ローカライズ | Planned | 1 PR | yes |
| 3. MCP 設定支援 CLI | Planned | 1 PR | yes |
| 4. README / docs の導線更新 | Planned | 1 PR | yes |
| 5. Web UI i18n の最小入口 | Planned | 1 PR | optional |
| 調査スパイク A/B/C | Planned | separate docs PRs | no |

## Phase 1 の非目標

Phase 1 では次を実装しない。

- SQLite / `sqlite-vec` の DB backend 追加。
- `DATABASE_PROVIDER` による DB 抽象化。
- MCP tool input への `lang` 追加。
- `react-i18next` による Web UI 全面 i18n。
- Windows Task Scheduler / Windows Service の完全対応。
- Antigravity などエージェントのサブスクリプション枠を直接再利用する LLM provider。
- Docker Compose に LLM / embedding daemon まで含める all-in-one runtime。

これらは既存アーキテクチャへの影響が大きく、OSS 公開前の導入改善とは別の調査・設計フェーズに分離する。

## 実装方針

1. 既存の `init:project` を活かし、`setup` は周辺環境確認、`.env` 生成、DB migration、`init:project` 呼び出しを束ねる上位 CLI として追加する。
2. ローカライズはまず MCP/CLI のユーザー向け文言に限定する。Web UI は Milestone 5 で shell + Doctor から任意導入する。
3. MCP の入力スキーマは Phase 1 で変えない。言語切り替えは `MEMORY_ROUTER_LANG=en|ja` と CLI option のみで扱う。
4. 外部エージェントの設定ファイルを書き換える機能は `--dry-run` を既定にし、`--apply` 時だけバックアップ付きで実行する。
5. 既存 README の英語版を primary とし、日本語版は同じ手順を追従させる。翻訳 CI は Phase 1 では自動 PR 生成まで行わない。

## Milestone 0: 実装前の安全柵

### 変更内容

- `docs/oss-onboarding-and-localization-plan.md` をこの実装計画として固定する。
- 実装開始前に現在の公開契約をテスト対象として確認する。

### 確認対象

- `docs/mcp-tools.md`
- `src/mcp/tools/system.tool.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/cli/init-project.ts`
- `package.json`
- `.env.example`
- `README.md`
- `README.jp.md`

### 受け入れ条件

- Phase 1 の実装対象に SQLite、サブスクリプション SDK 連携、MCP `lang` argument が含まれていない。
- 実装対象ファイルと検証コマンドが各 milestone に明記されている。

## Milestone 1: `bun run setup` の追加

### 目的

Quick Start の手順を、既存 PostgreSQL 構成のまま一つの CLI に集約する。

### 実装タスク

1. `src/cli/setup.ts` を追加する。
2. `package.json` に `"setup": "bun run src/cli/setup.ts"` を追加する。
3. `src/cli/onboarding/env-file.ts` を追加し、`.env.example` から `.env` を生成する。
4. `src/cli/onboarding/command-runner.ts` を追加し、実行予定コマンドを `--dry-run` と実行モードで共有する。
5. `src/cli/onboarding/checks.ts` を追加し、Bun、Docker Compose、DB connection string、既存 `.env` の状態を確認する。
6. `setup` から次の処理を順に実行する。
   - `.env` がなければ `.env.example` から生成する。
   - `.env` がある場合は不足 key のみ追記し、既存値は上書きしない。
   - `--lang` が指定され、`.env` に `MEMORY_ROUTER_LANG` がなければ選択 locale を追記する。
   - `docker compose ps` で DB コンテナ状態を確認する。
   - `--start-db` 指定時だけ `docker compose up -d` を実行する。
   - `--no-migrate` がなければ `bun run db:migrate` を実行する。
   - migration が失敗した場合は `init:project` を実行せず、DB 復旧手順を nextActions に出す。
   - `--skip-init` がなければ `bun run init:project -- --json --wiki-root <path> --lang <locale>` を実行する。
   - 最後に MCP 設定スニペット、`bun run doctor`、`mcp:register` の次アクションを表示する。

### 実行モデル

- `setup` は Phase 1 では非対話 CLI として実装する。プロンプト入力を待つウィザードにはしない。
- `bun run setup` は冪等にする。同じ workspace で複数回実行しても `.env` の既存値、既存 knowledge、既存 MCP 設定を壊さない。
- `--dry-run` は既定ではないが、README では最初の確認コマンドとして案内する。
- `--json` 指定時は stdout に JSON のみを出し、人間向け説明は stderr にも出さない。
- `setup` は `doctor` を自動実行しない。環境依存 warning が多いため、実行完了後の next action として `bun run doctor` を案内する。

### CLI interface

```bash
bun run setup
bun run setup -- --dry-run --json
bun run setup -- --start-db
bun run setup -- --wiki-root ./wiki/pages --lang en
```

### options

- `--dry-run`: ファイル書き込みとコマンド実行を行わず、実行計画のみ表示する。
- `--json`: 機械可読 JSON を出力する。
- `--start-db`: `docker compose up -d` を実行する。既定では DB 起動は提案に留める。
- `--no-migrate`: migration をスキップする。
- `--skip-init`: `init:project` をスキップする。
- `--wiki-root <path>`: `init:project` に渡す wiki root。
- `--lang en|ja`: CLI 出力と `init:project` のオンボーディング文言を切り替える。未指定時は `MEMORY_ROUTER_LANG`、それもなければ `ja` を使う。

### JSON output

`--json` は次の形を返す。

```json
{
  "ok": true,
  "mode": "dry-run",
  "lang": "en",
  "env": {
    "path": ".env",
    "created": false,
    "appendedKeys": []
  },
  "checks": [
    { "name": "docker-compose", "ok": true, "message": "docker compose is available" }
  ],
  "commands": [
    { "command": "bun run db:migrate", "skipped": false, "status": "planned" }
  ],
  "mcpConfigSnippet": "{...}",
  "nextActions": []
}
```

### テスト

- `test/onboarding-env-file.test.ts`: `.env.example` merge、既存値保持、不足 key 追記を検証する。
- `test/setup-cli.test.ts`: option parse、dry-run command plan、JSON output shape、migration 失敗時に `init:project` を実行しないことを検証する。
- `test/init-project.test.ts`: `setup` から渡す `--lang` と `--wiki-root` が `init:project` 側で受け取れることを検証する。

### 検証

```bash
bunx vitest run test/onboarding-env-file.test.ts test/setup-cli.test.ts test/init-project.test.ts
bun run typecheck
bun run verify
```

手動 smoke:

```bash
bun run setup -- --dry-run --json
MEMORY_ROUTER_LANG=en bun run setup -- --dry-run
MEMORY_ROUTER_LANG=ja bun run setup -- --dry-run
```

## Milestone 2: MCP/CLI 文言の最小ローカライズ

### 目的

英語ユーザーが MCP 初期指示と初回 CLI 出力を読めるようにする。ただし MCP tool contract は変更しない。

### 実装タスク

1. `src/shared/locales/locale.ts` を追加する。
   - `type SupportedLocale = "en" | "ja"`
   - `resolveLocale(input?: string): SupportedLocale`
   - fallback は `ja` とする。既存運用を壊さないため、デフォルト言語は変更しない。
2. `src/shared/locales/initial-instructions.ts` を追加する。
   - `buildInitialInstructionsText(locale)` を提供する。
   - 現行日本語文言を `ja` として移動する。
   - 英語版を `en` として追加する。
3. `src/mcp/tools/system.tool.ts` を更新する。
   - `MEMORY_ROUTER_LANG` から locale を解決する。
   - input schema は `{ properties: {} }` のまま変更しない。
4. `src/cli/init-project.ts` を更新する。
   - `--lang en|ja` を追加する。
   - `MEMORY_ROUTER_LANG` fallback を使う。
   - smoke goal、preset title/body、nextActions、error help を locale 別に切り替える。
   - JSON output に `lang` を含める。
5. `src/cli/setup.ts` から `init:project -- --lang <locale>` を渡す。

### 受け入れ条件

- `initial_instructions` の MCP input schema は引数なしのまま。
- `context_compile` の input schema は変更しない。
- `MEMORY_ROUTER_LANG=en` のとき `initial_instructions` が英語で返る。
- `MEMORY_ROUTER_LANG=ja` または未指定では現行日本語運用が維持される。
- `init:project -- --lang en --json` が英語の next action と英語 preset を返す。
- `init:project -- --lang ja --json` の既存日本語 preset が現在と同じ意味を保つ。

### テスト

- `test/locales.test.ts`: locale 解決と fallback。
- `test/mcp.tools.test.ts`: `MEMORY_ROUTER_LANG=en|ja` の `initial_instructions` 出力。
- `test/mcp.contract.test.ts`: MCP tool input schema が変わっていないこと。
- `test/init-project.test.ts`: `--lang` による JSON 出力差分。

### 検証

```bash
bunx vitest run test/locales.test.ts test/mcp.tools.test.ts test/mcp.contract.test.ts test/init-project.test.ts
bun run verify:mcp
bun run verify
```

## Milestone 3: MCP 設定支援 CLI

### 目的

README の汎用 MCP snippet だけでは登録先ごとの迷いが残るため、主要クライアント向けの設定支援を CLI 化する。

### 実装タスク

1. `src/cli/mcp-register.ts` を追加する。
2. `package.json` に `"mcp:register": "bun run src/cli/mcp-register.ts"` を追加する。
3. `src/cli/onboarding/mcp-config.ts` を追加し、`init:project` の `buildMcpConfigSnippet` と共有する。
4. 対応 client は Phase 1 では `generic`, `codex`, `cline`, `claude-desktop`, `cursor` とする。
5. 既定は dry-run とし、設定ファイルへの書き込みは `--apply` 指定時のみ行う。
6. `--apply` は次を満たす場合だけ許可する。
   - 対象ファイル path が解決できる。
   - JSON として parse できる、または存在しない。
   - 書き込み前に `.bak-<timestamp>` を作る。
   - 既存 `memory-router` entry がある場合は差分を表示してから更新する。
7. `cursor` は Phase 1 では自動書き込み対象にしない。snippet と手順表示のみ行う。

### CLI interface

```bash
bun run mcp:register -- --client generic --json
bun run mcp:register -- --client cline --dry-run
bun run mcp:register -- --client claude-desktop --apply
```

### 受け入れ条件

- `--dry-run` はファイルを変更しない。
- `--apply` はバックアップを作ってから JSON を更新する。
- `cwd` は現在の repo root の絶対パスになる。
- `command` は `bun`、`args` は `["run", "start:mcp"]` になる。
- unsupported client は non-zero exit と具体的な supported list を返す。

### テスト

- `test/mcp-register.test.ts`: snippet 生成、client path 解決、dry-run、backup 作成、既存 entry merge。
- `test/init-project.test.ts`: `init:project` と `mcp:register` が同じ snippet builder を使うこと。

### 検証

```bash
bunx vitest run test/mcp-register.test.ts test/init-project.test.ts
bun run mcp:register -- --client generic --json
bun run verify
```

## Milestone 4: README / docs の導線更新

### 目的

実装した導入導線とドキュメントの手順を一致させる。

### 実装タスク

1. `README.md` の Quick Start を `bun run setup -- --lang en` 中心に更新する。
2. `README.jp.md` は `bun run setup -- --lang ja` 中心に更新し、英語 README とコマンド順を揃える。
3. `docs/mcp-tools.md` に言語切り替えのルールを追記する。
   - `initial_instructions` の入力は引き続きなし。
   - 言語は `MEMORY_ROUTER_LANG` でサーバー側に指定する。
4. `.env.example` に `MEMORY_ROUTER_LANG=ja` のコメント例を追加する。
5. `README.md` と `README.jp.md` に `mcp:register` の dry-run / apply の注意点を記載する。
6. `docs/oss-onboarding-and-localization-plan.md` の進捗欄を更新し、完了 milestone を判別できるようにする。

### 受け入れ条件

- README の Quick Start で、手動手順と `bun run setup` の関係が矛盾しない。
- 英語 README の Quick Start が、初回実行時に英語出力になる導線を持つ。
- 日本語 README と英語 README のコマンド列が一致している。
- MCP docs が実際の input schema と矛盾しない。
- `.env.example` の追加値が既存動作を変えない。

### 検証

```bash
git diff --check -- README.md README.jp.md docs/mcp-tools.md docs/oss-onboarding-and-localization-plan.md .env.example
bun run verify
```

## Milestone 5: Web UI i18n の最小入口

### 目的

Web UI 全面 i18n ではなく、後続で安全に広げられる入口を作る。

### 実装タスク

1. `web/src/lib/i18n.ts` を追加し、`en|ja` の locale 解決と辞書 lookup を提供する。
2. 初期対象は `AppShell` の nav/brand subtitle と `Doctor` page の reason label/action 表示に限定する。
3. `src/shared/doctor/doctor-reasons.ts` はすぐに全面多言語化しない。Milestone 5 では UI 側辞書で表示文言を上書きできる構造を作る。
4. `web/src/modules/admin/components/app-shell.tsx` の nav label を辞書化する。
5. `test/components/admin/app-shell.test.tsx` と `test/components/admin/doctor-page.test.tsx` に locale 切り替えケースを追加する。

### 受け入れ条件

- UI locale は browser language ではなく、まず `localStorage.memoryRouterLang` と `navigator.language` の順で解決する。
- locale 未対応 key は英語ではなく既存表示に fallback する。
- `AppShell` と `Doctor` 以外のページ文言は Milestone 5 では触らない。

### 検証

```bash
bunx vitest run test/components/admin/app-shell.test.tsx test/components/admin/doctor-page.test.tsx
bun run build:web
bun run verify
```

## 調査スパイク A: SQLite / sqlite-vec

### 目的

Docker 不要モードが本当に成立するかを実装前に判定する。

### 調査項目

- `pg-core` schema を `sqlite-core` と共有できる範囲。
- `jsonb`、`uuid`、`timestamp`、check constraints、unique index の差分。
- `pgvector` HNSW index と `sqlite-vec` の検索品質/速度差分。
- `to_tsvector` / `plainto_tsquery` を SQLite FTS5 に置換する範囲。
- Drizzle migration を provider 別に持つ場合の運用。
- 既存 integration test を provider matrix 化できるか。

### 成果物

- `docs/sqlite-provider-feasibility.md`
- 推奨判断: `implement`, `defer`, `reject` のいずれか。
- 実装する場合の migration / repository 分割計画。

## 調査スパイク B: Ollama adapter

### 目的

Ollama を local LLM / embedding provider として採用できるかを判定する。

### 調査項目

- `/api/chat` と OpenAI compatible endpoint のどちらを使うか。
- tool calling の互換性。
- `nomic-embed-text` などの embedding dimension と既存 384 次元 schema の整合。
- 既存 `local-llm` provider と並べるのか、`local-llm` の endpoint variant として扱うのか。

### 成果物

- `docs/ollama-provider-feasibility.md`
- provider 名、設定変数、必要 schema migration の有無。

## 調査スパイク C: Subscription SDK provider

### 目的

エージェントのサブスクリプション枠を `memory-router` から利用する案が、技術的・契約的・安全性の面で成立するかを判定する。

### 調査項目

- Antigravity 等に外部プロセスから利用可能な公式 SDK/API があるか。
- 利用規約上、別アプリからサブスクリプション枠を再利用できるか。
- 認証情報をローカルプロセスが扱う場合の保存・漏洩リスク。
- 既存 provider interface に追加する場合の provider 名と usage logging。

### 成果物

- `docs/subscription-provider-feasibility.md`
- 実装可否と代替案。代替案の第一候補は通常の OpenAI/Anthropic/OpenAI-compatible provider 追加とする。

## 推奨実装順

1. Milestone 1: `setup` CLI
2. Milestone 2: MCP/CLI 文言の最小ローカライズ
3. Milestone 3: MCP 設定支援 CLI
4. Milestone 4: README / docs 更新
5. Milestone 5: Web UI i18n の最小入口
6. 調査スパイク A/B/C

Milestone 1 から 4 までを OSS 公開前の必須範囲とする。Milestone 5 は公開前に余力があれば実施し、なければ公開後の最初の UI 改善に回す。

## 全体の完了条件

- `bun run setup -- --dry-run --json` が成功する。
- `bun run setup -- --dry-run` が英語/日本語で読める出力を返す。
- `MEMORY_ROUTER_LANG=en` で `initial_instructions` が英語になる。
- `MEMORY_ROUTER_LANG=ja` または未指定で既存日本語運用が維持される。
- `bun run mcp:register -- --client generic --json` が README と同じ MCP snippet を返す。
- README / README.jp / docs/mcp-tools.md が実装済み CLI と矛盾しない。
- `bun run verify` が成功する。
- DB を使う追加テストは dedicated test DB を使い、`memory_router_test` 以外に destructive operation を行わない。
