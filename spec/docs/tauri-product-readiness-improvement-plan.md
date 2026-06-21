# Tauri Product Readiness Improvement Plan

## Purpose

contextStill の当面の主線を SQLite / Tauri desktop app に固定し、PostgreSQL / pgvector は将来の server backend 候補として境界分離する。あわせて README と public docs の表現を刷新し、配布容易性とプロダクト明瞭性を上げる。

この計画は、インストーラーや初回起動時に `node_modules` 相当の runtime bundle を取得する論点をいったん扱わない。先に、ユーザーが何をインストールし、何を起動し、どの backend を使っているのかが迷子にならない状態を作る。

## Guiding Decisions

1. Desktop / local-first が default product path。
2. SQLite が default local backend。
3. MCP server は agent integration surface だが、desktop product 全体の必須操作にはしない。
4. PostgreSQL / pgvector は削除ではなく advanced server backend として隔離する。
5. README と public docs は、PostgreSQL-era の導線ではなく SQLite desktop 導線から始める。
6. `.env` は development / advanced configuration の入口に下げ、desktop 起動の必須条件にしない。
7. Hono API は admin UI facade として扱い、MCP / CLI / worker / automation / bootstrap は daemon 側の責務として分離する。

## Scope

### In Scope

- README / README.jp / `spec/pub` の情報設計刷新。
- SQLite / PostgreSQL / pgvector の backend responsibility boundary 明文化。
- Tauri desktop 化に向けた bootstrap、path、settings、doctor、smoke の要件整理。
- 配布容易性を上げるための first-run/onboarding/doctor 表示の整理。
- プロダクト明瞭性を上げるための利用モード、用語、画面導線の整理。
- PostgreSQL / pgvector を advanced server backend として残すための隔離方針。

### Out Of Scope

- インストーラー内または初回起動時の `node_modules` / runtime bundle download 設計。
- Tauri app shell の実装。
- PostgreSQL / pgvector の完全削除。
- Hosted SaaS / multi-tenant server product の実装。
- NightWorkers など外部 repo 側への contextStill 専用 client / repository / schema / fallback 追加。
- LLM provider routing の全面再設計。

## Current State

### Product Message

README は local-first adaptive knowledge compiler としての価値を説明できているが、core capability に Local PostgreSQL / pgvector storage が強く出ている。Tauri / SQLite を default product path にする場合、初見の読者は「Docker + PostgreSQL が前提の開発者向けツール」と受け取りやすい。

### Backend Boundary

SQLite backend は primary `register_candidates`、`search_knowledge`、source search、`context_compile` run/snapshot、runtime settings、audit logs、`compile_eval` などを担う方向に進んでいる。一方、queue / distillation / admin の一部は PostgreSQL-era の前提をまだ残している。

### Distribution Readiness

`bun run startup`、`bun run doctor`、`bun run dev`、`bun run start:mcp` は開発者導線として有効だが、desktop app の初回起動体験としてはまだ粒度が低い。Tauri ではユーザーが terminal で Docker、`.env`、migration、MCP config を手動で触る前提を下げる必要がある。

### Runtime Boundary

現行コードでは、Hono は `/api/*` を提供する admin UI 向け HTTP facade として機能している。一方で MCP server、CLI command、queue supervisor、agent-log sync automation は Hono を経由せず、`src/modules/*` の service/repository を直接呼ぶ別入口として存在する。

Tauri 化ではこの分離を強める。UI はナレッジメンテナンス、review、settings、diagnostics の操作面に寄せる。daemon は UI 停止後も残り、MCP、CLI、worker、automation、doctor、backup、bootstrap、process supervision を担う。Hono を daemon control API に拡張する場合は、admin UI facade とは別境界として扱う。

daemon / CLI / MCP / worker / automation / bootstrap 境界を Rust 化する場合は、[Rust Daemon And CLI Boundary Migration Plan](rust-daemon-cli-boundary-migration-plan.md) に従い、TypeScript 実装を parity gate まで残したまま並走させる。

### Documentation Index

`spec/docs/README.md` は過去の内部計画書リンクを含むが、現行 worktree には存在しないファイルが混ざっている。内部計画書の索引は、実在する文書と active plan に合わせて保守する必要がある。

## Target Product Shape

### Primary Path: Desktop Local

The default product is a local desktop control plane for coding-agent memory.

- storage: SQLite
- UI: Tauri desktop shell around the admin/control-plane experience
- runtime: long-lived daemon for MCP / CLI / worker / automation, with Hono kept as the admin UI facade
- knowledge loop: sources / agent logs / candidates -> knowledge -> context compile -> evaluation -> new lessons
- model usage: configurable; local-only and cloud-assisted modes both supported
- MCP: optional agent integration, enabled by user action

### Advanced Path: Server Backend

PostgreSQL / pgvector remains an advanced backend for future server-style deployments.

- not required for desktop onboarding
- not shown as missing infrastructure in the default desktop doctor
- kept behind explicit `CONTEXT_STILL_DB_BACKEND=postgres` or equivalent advanced configuration
- covered by focused compatibility tests and migration docs

### Compatibility Path

Legacy names and old setup affordances may remain where they prevent breakage, but should not appear as the main product identity.

- `memory-router` aliases: compatibility only
- pgvector UI status: hidden in desktop default, visible only in advanced server diagnostics
- Docker setup: advanced/server/developer path, not desktop quick start

## Workstreams

### Workstream A: Product Documentation Refresh

Goal: A new user can understand the product without learning the historical PostgreSQL path first.

Deliverables:

- Rewrite README top section around desktop/local-first value.
- Split setup into `Desktop Quick Start`, `MCP Integration`, and `Advanced Server Backend`.
- Update README.jp with the same information architecture.
- Refresh `spec/pub/getting-started.md` so SQLite desktop is first.
- Refresh `spec/pub/architecture.md` so database row says SQLite default and PostgreSQL advanced backend.
- Refresh `spec/pub/configuration.md` so `.env` is development / advanced configuration, not default desktop setup.
- Refresh `spec/pub/operations.md` to separate desktop backup/doctor from server backend operations.

Acceptance criteria:

- The first 100 lines of README do not imply PostgreSQL / pgvector is required for the default product.
- Docker appears only in development or advanced server sections.
- A reader can identify the default backend without reading `.env.example`.
- PostgreSQL / pgvector is described as advanced server backend, not deprecated junk and not default infrastructure.

### Workstream B: Backend Boundary Separation

Goal: SQLite and PostgreSQL are separate backend responsibilities, not interleaved assumptions.

Deliverables:

- Define backend categories:
  - `sqlite-local`: default desktop backend
  - `postgres-server`: advanced server backend
  - `compat-legacy`: migration and old-name compatibility
- Audit files that mix SQLite and PostgreSQL logic in the same user-facing path.
- Move PostgreSQL-only health checks behind advanced diagnostics.
- Ensure `doctor` can render a desktop-focused summary without pgvector missing noise.
- Keep PostgreSQL tests, but make them explicitly server backend tests.
- Document which tables/features are SQLite-complete, partially migrated, or server-only.

Acceptance criteria:

- Desktop doctor can be green without pgvector.
- SQLite mode does not show PostgreSQL remediation steps unless user selected server backend.
- New features have an explicit backend target before implementation starts.
- PostgreSQL / pgvector code can remain, but its user-facing path is opt-in.

### Workstream C: Tauri Readiness Baseline

Goal: The repo has a clear checklist for turning the current local web/admin/MCP runtime into a desktop app.

Deliverables:

- Define runtime lifecycle boundaries:
  - daemon remains alive after the UI closes
  - Hono admin API can start/stop with the UI unless promoted to daemon control API
  - MCP / CLI / queue / automation remain daemon-side responsibilities
- Define desktop data paths:
  - SQLite DB path
  - log path
  - backup path
  - runtime settings path
  - MCP registration metadata path
- Define first-run bootstrap states:
  - no database
  - database exists but needs migration
  - settings incomplete
  - embedding unavailable but optional
  - MCP not registered
- Define desktop-safe defaults:
  - SQLite backend
  - no Docker requirement
  - local file source root under app data unless user chooses another path
  - `.env` optional
- Define desktop smoke command or mode:
  - DB open
  - migration applied
  - settings readable/writable
  - `context_compile` smoke can return content or intentional `No Content` with clear reason
  - backup path writable

Acceptance criteria:

- A future Tauri implementation can follow this checklist without rediscovering product decisions.
- Desktop startup has explicit recoverable states instead of raw development errors.
- MCP registration is a user action, not a hidden requirement.

### Workstream D: Onboarding And Product Clarity

Goal: The product explains what mode it is in and what the user can do next.

Deliverables:

- Define three visible operating modes:
  - `minimal`: SQLite + local sources + MCP/manual candidates
  - `cloud-review`: cloud LLM assisted distillation and review
  - `local-llm`: local LLM / local embedding assisted distillation
- Add mode copy to docs and later onboarding UI.
- Reduce admin/doctor language from implementation status to user action:
  - `Ready`
  - `Needs setup`
  - `Optional improvement`
  - `Advanced server backend only`
- Define empty states for sources, knowledge, compile runs, decision runs, and distillation queue.
- Remove or hide obsolete product affordances from the default UI path.

Acceptance criteria:

- A new user can answer: what is this app, where is my data, what do I do first?
- Doctor warnings do not require knowing PostgreSQL history.
- Optional cloud/local model configuration does not block minimal usage.

### Workstream E: Verification And Release Gates

Goal: Desktop readiness is testable before actual packaging work.

Deliverables:

- Keep `verify` as the general development gate.
- Keep `verify:sqlite` as the local-first backend gate.
- Add or define a future `verify:desktop-readiness` gate that can run before Tauri packaging.
- Add docs-only checks for README/spec link validity.
- Add smoke coverage for:
  - SQLite bootstrap
  - desktop doctor summary
  - backup/restore docs consistency
  - MCP optional registration copy

Acceptance criteria:

- README/spec links do not point at missing files.
- SQLite local path has a focused verification command.
- Server backend verification remains available but not required for default desktop readiness.

### Workstream F: Server Backend Preservation

Goal: Future server productization remains possible without burdening desktop users.

Deliverables:

- Move PostgreSQL / pgvector docs under advanced backend sections.
- Preserve migration/export/import paths.
- Preserve PostgreSQL smoke tests as advanced backend compatibility.
- Document server backend constraints:
  - N+1 query avoidance
  - remote DB latency assumptions
  - multi-user/auth model not yet productized
  - backup/restore differences from SQLite

Acceptance criteria:

- PostgreSQL / pgvector is not deleted by accident.
- Desktop users do not need to understand pgvector.
- Server backend docs are honest that this is future/advanced, not the default product.

## Milestones

### Milestone 0: Plan And Index Cleanup

Deliverables:

- Add this plan.
- Update `spec/docs/README.md` so it links only to existing internal docs.

Exit criteria:

- Internal docs index is not misleading.

### Milestone 1: Product Message Rewrite

Deliverables:

- Rewrite README and README.jp top-level narrative.
- Add product mode table.
- Move PostgreSQL / pgvector to advanced backend section.

Exit criteria:

- Default product reads as SQLite / desktop / local-first.

### Milestone 2: Public Docs Realignment

Deliverables:

- Update `spec/pub/getting-started.md`.
- Update `spec/pub/architecture.md`.
- Update `spec/pub/configuration.md`.
- Update `spec/pub/operations.md`.

Exit criteria:

- Public docs match README message and do not require Docker for the default path.

### Milestone 3: Desktop Doctor And Onboarding Spec

Deliverables:

- Write a focused design note or patch existing docs for desktop doctor states.
- Define first-run bootstrap state machine.
- Define desktop-safe defaults.

Exit criteria:

- Implementation can start without unresolved product-state questions.

### Milestone 4: Backend Boundary Refactor Slice

Deliverables:

- Audit mixed backend paths.
- Move PostgreSQL-only user-facing health/status behind advanced diagnostics.
- Define backend support matrix.

Exit criteria:

- SQLite path no longer reports server-only requirements as missing default infrastructure.

### Milestone 5: Desktop Readiness Verification

Deliverables:

- Define or implement `verify:desktop-readiness`.
- Add docs link validation.
- Add smoke checks for SQLite bootstrap and desktop doctor summary.

Exit criteria:

- Tauri app shell work can start with a repeatable preflight.

## Risks

### Risk: PostgreSQL code rots after being hidden

Mitigation:

- Keep explicit advanced backend tests.
- Keep docs that say what PostgreSQL supports.
- Do not pretend server backend is default.

### Risk: SQLite desktop path grows hidden server assumptions

Mitigation:

- Desktop doctor must not require pgvector.
- New features must declare backend support.
- Server-only warnings must be labeled advanced.

### Risk: Documentation becomes aspirational

Mitigation:

- Each milestone needs exit criteria.
- Docs should distinguish current behavior, target behavior, and future backend.
- Link validation should catch stale internal references.

### Risk: Tauri work starts before product states are settled

Mitigation:

- Finish Milestone 1 through 3 before app shell implementation.
- Treat installer/runtime download as a later packaging topic.

## Non-Goals For Now

- Do not design installer-time dependency download in this plan.
- Do not delete PostgreSQL / pgvector implementation.
- Do not add hosted SaaS assumptions.
- Do not require external LLMs for minimal desktop use.
- Do not require MCP registration before the app can be useful.

## Open Questions

1. Should the first desktop release include distillation workers, or start with manual/imported knowledge plus compile/search?
2. Should local LLM setup be first-run guided, or an advanced settings flow?
3. Should desktop backup be automatic on upgrade, manual only, or both?
4. Which admin UI pages should be hidden in the first desktop release if their backend is not SQLite-complete?
5. Should PostgreSQL server backend docs live in `spec/pub` immediately, or remain internal until productized?

## Suggested First Implementation Slice

1. Update README and README.jp narrative.
2. Update `spec/pub/getting-started.md` and `spec/pub/configuration.md`.
3. Add backend support matrix to public docs.
4. Add desktop doctor state design note.
5. Only then start Tauri shell scaffolding.
