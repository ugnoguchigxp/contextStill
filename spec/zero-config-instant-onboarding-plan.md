# Zero-Config & Instant Onboarding Implementation Plan

この計画は、`context-still` を `git clone` 後に最短で実用状態へ持っていくための実装計画である。

方針を明確にする。初回導線の主役は Web wizard ではなく、**対話型 startup script** にする。startup script が必要な入力を集め、実行計画と masked diff を表示する。既定は必ず dry-run で、既存環境には何も書き込まない。実変更は `--apply` が明示された場合だけ行い、`.env` 保存、DB 初期化、migration、初期 seed、compile smoke、MCP snippet 表示、`doctor` 実行までを一連で完走する。apply 完了時点では `bun run doctor` が `ok` を返す状態を目指す。

重要な前提として、`context-still` の価値は `context_compile` と distillation にあり、どちらも LLM 推論なしでは実用動作しない。zero-config は「LLM 不要」ではない。API キーなしで使う場合は reachable な local-llm を必須にし、local-llm がない場合は OpenAI-compatible / Azure OpenAI / Bedrock などの外部 API を設定する。

DB は将来的に SQLite を許容する。ただし、Slice 1 の完了条件は `doctor: ok` なので、現行実装と整合する PostgreSQL / pgvector を使う。SQLite は runtime、schema、repository adapter、doctor capability matrix が実装された後に startup script の選択肢へ追加する。

## 1. Implementation Readiness

結論: **Slice 1 はこの文書だけで実装に着手できる状態にする。**

前版からの方針変更:

| 旧方針 | 新方針 |
|---|---|
| Web onboarding / API contract を先に作る | 対話型 startup script を先に作る |
| Web から `.env` を dry-run/apply する | CLI が入力を集め、既定 dry-run で実行計画だけ表示する。`--apply` 時だけ backup 付きで更新する |
| onboarding 完了は status API で判定する | `--apply` 付き startup script が `doctor` を実行し、`ok` になるまで案内・再試行する |
| SQLite は後続に大きく分離 | Slice 1 では選択肢に出さない。Slice 2 で runtime まで実装してから選択可能にする |

## 2. Goals And Non-Goals

### Goals

- `bun run startup` を追加し、対話形式で初期設定の dry-run 計画を確認できる。
- `bun run startup -- --apply` を追加し、明示 apply 時だけ実環境を変更する。
- 既存の `bun run setup -- --json` は後方互換の非対話 API として残す。
- startup script は次を必ず実行する。
  - 必要入力の収集。
  - `.env` への保存計画作成。
  - PostgreSQL 接続先の確定。
  - Docker Compose による PostgreSQL 起動または既存 DB への接続。
  - migration。
  - 初期 seed / project init。
  - LLM provider health check。
  - compile smoke。
  - MCP snippet 表示。
  - `doctor` 実行。
- dry-run の完了条件は「変更予定、実行予定コマンド、doctor OK までの見込み」を表示して exit `0` すること。
- apply の完了条件は `doctor.status === "ok"` とする。
- `doctor` が `degraded` / `failed` の場合は、原因と修正アクションを表示し、再試行する。

### Non-Goals

- `bun run dev` から MCP stdio server を自動起動しない。
- LLM 推論なしで `context_compile` / distillation を成功させない。
- Postgres 接続失敗時に SQLite へ暗黙 fallback しない。
- Slice 1 では Web onboarding UI を作らない。
- Slice 1 では MCP client config の自動書き込みはしない。snippet 表示までにする。

## 3. Existing Implementation Anchors

| Area | Current Anchor | Plan |
|---|---|---|
| setup CLI | `src/cli/setup.ts` creates `.env`, runs checks, migration, init, and returns JSON. | Extract reusable setup service; keep JSON CLI compatible. |
| doctor | `src/cli/doctor.ts` calls `runDoctor()`. | startup script calls `runDoctor()` directly and loops until `ok` or user exits. |
| MCP snippet | `src/cli/onboarding/mcp-config.ts` builds `command: "bun", args: ["run", "start:mcp"]`. | Keep as source of truth and print at the end. |
| LLM providers | `AgenticCompileProvider` and `DistillationProvider` exist in `src/config.types.ts`. | Reuse existing provider names; do not add a generic `CONTEXT_STILL_LLM_PROVIDER`. |
| Provider tests | `api/modules/settings/settings.service.ts` has provider test helpers. | Reuse or wrap them for startup health checks. |
| DB | `src/db/client.ts` currently uses `drizzle-orm/node-postgres` and `pg`. | Slice 1 uses PostgreSQL only; SQLite is Slice 2. |

## 4. Slice 1: Interactive Startup Script

This is the first implementation target.

### 4.1 User Command

Add:

```json
{
  "scripts": {
    "startup": "bun run src/cli/startup.ts",
    "setup:interactive": "bun run src/cli/startup.ts"
  }
}
```

Keep:

```json
{
  "scripts": {
    "setup": "bun run src/cli/setup.ts"
  }
}
```

`bun run setup -- --json` must remain backward compatible.

Default behavior:

- `bun run startup` is dry-run.
- `bun run startup -- --dry-run` is equivalent to default.
- `bun run startup -- --apply` is the only mode allowed to write files, start Docker, run migrations, import data, run compile smoke, or loop on doctor.

Safety acceptance:

- Running `bun run startup` with no flags never writes `.env`.
- Running `bun run startup` with no flags never runs `docker compose up -d`.
- Running `bun run startup` with no flags never runs `db:migrate`, `init:project`, compile smoke, or DB writes.
- Dry-run prints the exact commands that would run under `--apply`.

### 4.2 Prompt Flow

The startup script asks only for values needed to reach `doctor: ok`.

1. Locale:
   - default from `CONTEXT_STILL_LANG` or OS locale.
   - options: `ja`, `en`.
2. Database:
   - Slice 1 option: `postgres`.
   - default `DATABASE_URL`: `postgres://postgres:postgres@localhost:7889/context_still`.
   - ask whether to run `docker compose up -d`.
   - wait for PostgreSQL connection before continuing.
   - do not offer SQLite until Slice 2 is implemented.
3. LLM provider for compile:
   - options: `local-llm`, `openai`, `azure-openai`, `bedrock`.
   - API-keyless path requires `local-llm`.
   - ask provider-specific endpoint / key / model.
4. Distillation provider:
   - default to same as compile provider.
   - allow override.
5. Embedding provider:
   - options: `auto`, `daemon`, `cli`, `openai`, `disabled`.
   - default: `auto`.
6. Initial project setup:
   - ask wiki root, default `wiki/pages`.
   - ask whether to import sample seed.
7. MCP client:
   - options: `generic`, `cursor`, `cline`, `claude-desktop`, `skip`.
   - Slice 1 prints snippet only; no config file mutation.
8. Confirmation:
   - show masked diff of `.env`.
   - in dry-run, stop after showing the diff and command plan.
   - in apply mode, require explicit yes before writing or running commands.

### 4.3 Persistence Rules

Write boot-critical configuration to `.env` only in `--apply` mode because it is needed before DB connection exists. In dry-run mode, compute and display the same normalized `.env` diff without writing.

Allowed `.env` keys in Slice 1:

- `DATABASE_URL`
- `CONTEXT_STILL_LANG`
- `CONTEXT_STILL_AGENTIC_COMPILE_PROVIDER`
- `CONTEXT_STILL_DISTILLATION_PROVIDER`
- `CONTEXT_STILL_DISTILLATION_FIND_CANDIDATE_PROVIDER`
- `CONTEXT_STILL_OPENAI_API_KEY`
- `CONTEXT_STILL_OPENAI_API_BASE_URL`
- `CONTEXT_STILL_OPENAI_MODEL`
- `CONTEXT_STILL_AZURE_OPENAI_API_KEY`
- `CONTEXT_STILL_AZURE_OPENAI_API_BASE_URL`
- `CONTEXT_STILL_AZURE_OPENAI_MODEL`
- `CONTEXT_STILL_AZURE_OPENAI_API_VERSION`
- `CONTEXT_STILL_BEDROCK_MODEL`
- `CONTEXT_STILL_BEDROCK_REGION`
- `CONTEXT_STILL_BEDROCK_PROFILE`
- `CONTEXT_STILL_LOCAL_LLM_API_BASE_URL`
- `CONTEXT_STILL_LOCAL_LLM_API_KEY`
- `CONTEXT_STILL_LOCAL_LLM_MODEL`
- `CONTEXT_STILL_EMBEDDING_PROVIDER`
- `CONTEXT_STILL_EMBEDDING_DAEMON_URL`
- `CONTEXT_STILL_EMBEDDING_ACCESS_TOKEN`

Rules:

- Dry-run never writes `.env`, backup files, DB rows, MCP config files, or logs beyond normal console output.
- Before writing `.env` in apply mode, create `.env.bak-<timestamp>` if `.env` exists.
- Mask secret values in console output.
- Reject unknown keys in the interactive result.
- Do not persist secrets to DB.
- After DB migration succeeds, startup may persist a non-secret onboarding summary to DB later, but Slice 1 does not require a new table.

### 4.4 Required Config Wiring

Slice 1 must wire these env values into `src/config.ts` if they are not already wired:

- `CONTEXT_STILL_AGENTIC_COMPILE_PROVIDER` -> `groupedConfig.agenticCompile.provider`
- `CONTEXT_STILL_BEDROCK_MODEL` -> `groupedConfig.bedrock.model`
- `CONTEXT_STILL_LOCAL_LLM_MODEL` -> `groupedConfig.localLlm.model`

Acceptance:

- `CONTEXT_STILL_AGENTIC_COMPILE_PROVIDER=local-llm` changes `groupedConfig.agenticCompile.provider` to `local-llm`.
- `CONTEXT_STILL_BEDROCK_MODEL=<model>` makes Bedrock provider configurable.
- `CONTEXT_STILL_LOCAL_LLM_MODEL=<model>` makes local-llm model configurable.
- Invalid provider values fall back to a safe default and surface a startup warning.

### 4.5 Startup Execution Steps

In dry-run mode, the script prints the following execution plan and exits `0` without running it.

In apply mode, after writing `.env`, the script runs:

1. Reload config from `.env` or spawn child commands with the updated env.
2. DB preparation:
   - optionally run `docker compose up -d`.
   - wait for PostgreSQL connection using the selected `DATABASE_URL`.
   - if DB is unreachable, show the connection error and offer retry or exit.
3. `bun run db:migrate`.
4. `bun run init:project -- --json --wiki-root <wikiRoot> --lang <lang>`.
5. LLM provider health check.
6. Compile smoke with a small default goal.
7. `runDoctor()` directly or `bun run doctor`.
8. If doctor is not `ok`, show blocking reasons and offer:
   - retry after user fixes issue,
   - rerun relevant setup step,
   - exit with non-zero status.

### 4.6 Doctor Completion Contract

Apply-mode startup is successful only when:

- DB connection is healthy.
- Required tables / migrations are healthy.
- LLM provider for compile is healthy.
- Distillation provider is configured or explicitly marked skipped only if the user selected compile-only mode.
- Embedding is usable or explicitly disabled with a doctor reason that does not block selected mode.
- MCP tool surface includes primary tools.
- `runDoctor()` returns `status: "ok"`.

Dry-run startup is successful when it can produce a complete plan without modifying the environment.

If apply mode cannot produce `doctor: ok`, startup must not claim success.

### 4.7 Files

New:

- `src/cli/startup.ts`
- `src/modules/onboarding/startup.service.ts`
- `src/modules/onboarding/startup-prompts.ts`
- `src/modules/onboarding/env-writer.ts`
- `src/modules/onboarding/llm-health.service.ts`
- `src/modules/onboarding/onboarding.types.ts`
- `test/startup.service.test.ts`
- `test/startup-env-writer.test.ts`
- `test/startup-llm-health.test.ts`
- `test/startup-doctor-loop.test.ts`
- `test/startup-config-env.test.ts`
- `test/startup-dry-run-safety.test.ts`

Modify:

- `package.json`
- `src/config.ts`
- `src/cli/setup.ts`
- `.env.example`
- `README.md`
- `README.jp.md`

Do not modify in Slice 1:

- `src/db/client.ts`
- `src/db/schema*.ts`
- `drizzle.config.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/modules/sources/source.repository.ts`

## 5. Slice 2: SQLite Runtime Capability

SQLite cannot be considered ready by startup until this slice is implemented.

Required boundaries:

- `src/db/provider.ts`: resolve `DATABASE_PROVIDER`.
- `src/db/schema-sqlite.ts`: explicit SQLite schema.
- provider-specific migration command or migration runner.
- repository adapters:
  - `knowledgeTextSearch`
  - `knowledgeVectorSearch`
  - `sourceTextSearch`
  - `sourceVectorSearch`
  - `graphSimilarity`
- doctor capability matrix:
  - `vectorSearch: supported | unsupported`
  - `graphSimilarity: supported | unsupported`
  - `fullTextSearch: postgres | sqlite-basic | unsupported`

Acceptance:

- `DATABASE_PROVIDER=postgres` keeps existing integration and MCP contract tests passing.
- `DATABASE_PROVIDER=sqlite` passes startup smoke and text-only knowledge smoke.
- Unsupported vector / graph calls return structured unsupported reasons, not raw SQL errors.
- `doctor` can return `ok` for SQLite lightweight mode when unsupported features are not part of the selected mode.
- After this slice, startup script may offer `postgres` / `sqlite` as explicit DB choices.

## 6. Slice 3: Safe MCP Registration

After startup can reach `doctor: ok`, add optional config file mutation.

Supported clients:

- `generic`: snippet only.
- `cursor`: snippet and manual instructions only.
- `cline`: dry-run / apply.
- `claude-desktop`: dry-run / apply.

Acceptance:

- dry-run never writes.
- apply creates backup before JSON merge.
- malformed JSON blocks apply.
- existing `context-still` entry returns diff before overwrite.
- snippet remains `command: "bun"`, `args: ["run", "start:mcp"]`, `cwd: <repo root>`.

## 7. Slice 4: Web Onboarding

Web onboarding becomes a secondary UI over the same startup services.

Scope:

- expose status and env dry-run APIs.
- reuse `startup.service.ts` rather than duplicating setup logic.
- keep state-changing file writes localhost/setup-token guarded.

## 8. Verification Plan

### Slice 1 Tests

Run:

```bash
bunx vitest run \
  test/startup.service.test.ts \
  test/startup-env-writer.test.ts \
  test/startup-llm-health.test.ts \
  test/startup-doctor-loop.test.ts \
  test/startup-config-env.test.ts \
  test/startup-dry-run-safety.test.ts
```

Expected:

- prompt answers are normalized into a typed startup plan.
- `.env` writer creates backup and masks secrets.
- dry-run does not write `.env`, create backups, start Docker, run migrations, or call compile smoke.
- unknown env keys are rejected.
- config env wiring changes effective compile provider, Bedrock model, and local-llm model.
- missing LLM provider blocks startup before compile smoke.
- doctor `degraded` / `failed` causes retry prompt or non-zero exit.
- doctor `ok` is required for success.

### Slice 1 Repo Checks

Run:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run build:web
```

Expected:

- All commands pass.
- Provider health tests mock live LLM calls unless explicitly marked integration.

### Manual Startup Smoke

1. Move existing `.env` aside.
2. Run `bun run startup`.
3. Confirm PostgreSQL `DATABASE_URL` and choose whether to run Docker Compose.
4. Select LLM provider and enter required values.
5. Confirm masked `.env` diff.
6. Confirm no `.env` or backup file is written.
7. Run `bun run startup -- --apply`.
8. Confirm `.env.bak-<timestamp>` is created when overwriting.
9. Confirm migration and `init:project` run.
10. Confirm compile smoke runs only after LLM health passes.
11. Confirm `doctor` runs.
12. Confirm apply mode exits `0` only when `doctor.status === "ok"`.

## 9. Implementation Order

Implement Slice 1 in this order:

1. Add config env wiring in `src/config.ts`.
2. Add `src/modules/onboarding/onboarding.types.ts`.
3. Add `.env` parser/writer with backup, masking, and allowlist.
4. Extract reusable setup service from `src/cli/setup.ts` without changing JSON output shape.
5. Add LLM health helper using existing provider names and provider test helpers.
6. Add startup service that executes DB prep, migration, init, LLM health, compile smoke, and doctor.
7. Add interactive prompt wrapper in `src/cli/startup.ts`.
8. Add `startup` and `setup:interactive` scripts to `package.json`.
9. Add tests.
10. Update README / README.jp.

Stop after Slice 1 unless the same task explicitly includes SQLite runtime.

## 10. Done Criteria For Slice 1

Slice 1 is done only when all are true:

- `bun run startup` exists and runs interactively.
- `bun run startup` is dry-run by default and does not modify files, DB, Docker, or MCP config.
- `bun run startup -- --apply` is required for any mutation.
- `bun run setup -- --json` remains backward compatible.
- `.env` is written only in apply mode after masked confirmation.
- `.env` backup is created before overwrite in apply mode.
- local-llm or external API health is required before compile smoke.
- startup refuses to claim success without LLM health.
- dry-run exits `0` after showing the full execution plan.
- apply mode runs migration and `init:project`.
- apply mode runs `doctor`.
- apply mode exits `0` only when `doctor.status === "ok"`.
- apply mode exits non-zero with clear next actions when doctor cannot become `ok`.
- `bun run start:mcp` remains the MCP command in all snippets.
- Slice 1 tests and repo checks pass.
