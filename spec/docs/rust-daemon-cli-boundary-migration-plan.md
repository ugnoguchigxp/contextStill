# Rust Daemon And CLI Boundary Migration Plan

## Purpose

contextStill の runtime boundary を保ったまま、daemon / CLI / MCP / worker / automation / bootstrap の領域を段階的に Rust 化する。Hono は admin UI 向け HTTP facade として維持し、TypeScript 実装は Rust 実装が parity gate を通るまで削除しない。

この計画の目的は、即時乗り換えではない。配布性、bootstrap、常駐安定性、OS 統合を改善しながら、既存 TypeScript 実装の開発速度と仕様追従性を維持する。

## Guiding Decisions

1. Hono API は admin UI facade として残す。
2. Rust 化の主対象は daemon / CLI / MCP process management / worker supervision / automation / bootstrap。
3. TypeScript service logic は当面 source of truth として残す。
4. Rust 実装は最初から業務ロジックを再実装せず、process host / supervisor / launcher / lifecycle manager から始める。
5. 完成まで TypeScript と Rust を両立させる。parity が確認できない境界で TypeScript を削除しない。
6. MCP は optional agent integration のまま扱い、admin UI 起動や Hono API 起動を必須にしない。
7. PostgreSQL / pgvector は advanced server backend として残し、Rust 化を理由に削除しない。
8. Rust source はドメイン単位に分け、各ドメイン内で `routing` / `service` / `repository` の責務を分離する。
9. ドメイン横断のライブラリ的機能は `shared` に置き、各ドメインから参照する。ドメイン間の内部実装直参照は避ける。

## Scope

### In Scope

- Rust daemon の責務定義。
- Rust CLI の段階導入。
- TypeScript CLI / MCP / worker / automation との並走設計。
- Hono admin UI facade との境界固定。
- Tauri desktop と将来 server product の両方に使える process/runtime 境界。
- parity / rollback / cutover gate の定義。
- verify / smoke / health check の追加方針。

### Out Of Scope

- `context_compile` ranking / retrieval の即時 Rust 再実装。
- `context_decision` orchestration の即時 Rust 再実装。
- LLM provider integration の即時 Rust 再実装。
- Hono API の Rust 化。
- admin UI の Rust 化。
- PostgreSQL / pgvector 実装の削除。
- インストーラー内または初回起動時の runtime bundle download 設計。
- 外部 repo に contextStill 専用 client / repository / schema / fallback を追加すること。

## Current Boundary

### Hono / Admin UI

Current Hono routes under `api/` provide `/api/*` for the admin UI. They expose knowledge, sources, graph, queue controls, settings, context runs, decision history, doctor, overview, and dashboards.

This is a UI-facing HTTP facade. It should be allowed to start and stop with the UI unless a future endpoint is explicitly promoted to daemon control API.

### TypeScript CLI / MCP / Workers

Current TypeScript entrypoints already bypass Hono and call `src/modules/*` directly.

- MCP: `src/index.ts`, `src/mcp/server.ts`
- CLI: `src/cli/*`
- Queue supervisor: `src/cli/queue-supervisor.ts`
- Automation: `src/cli/*-automation.ts`
- Doctor / backup / startup: `src/cli/doctor.ts`, `src/cli/sqlite-backup.ts`, `src/cli/startup.ts`

This makes daemon / CLI a natural Rust boundary. Rust can supervise or wrap these entrypoints before replacing any service logic.

## Target Runtime Shape

```text
Rust daemon
  - process supervisor
  - app data path resolver
  - SQLite path/bootstrap/migration preflight
  - settings/bootstrap facade
  - backup/restore launcher
  - doctor summary launcher
  - MCP process lifecycle
  - queue/agent-log-sync lifecycle
  - optional local control socket/API

TypeScript runtime, retained during migration
  - MCP tool logic
  - context_compile
  - context_decision
  - distillation and LLM orchestration
  - queue job business logic
  - Hono admin UI API
  - repositories and service logic not yet migrated

Hono admin API
  - UI-facing HTTP facade
  - starts on demand with web/Tauri UI unless explicitly promoted
```

## Rust Source Layout

Rust code should be organized by domain first, then by responsibility inside each domain. Avoid a top-level split that groups every repository together and every service together; that makes domain ownership harder to see as the daemon grows.

Recommended shape:

```text
crates/
  context-stilld/
    src/
      main.rs
      domains/
        daemon/
          routing.rs
          service.rs
          repository.rs
          mod.rs
        cli/
          routing.rs
          service.rs
          mod.rs
        mcp_lifecycle/
          routing.rs
          service.rs
          repository.rs
          mod.rs
        queue_lifecycle/
          routing.rs
          service.rs
          repository.rs
          mod.rs
        agent_log_sync/
          routing.rs
          service.rs
          repository.rs
          mod.rs
        bootstrap/
          routing.rs
          service.rs
          repository.rs
          mod.rs
        doctor/
          routing.rs
          service.rs
          repository.rs
          mod.rs
        backup/
          routing.rs
          service.rs
          repository.rs
          mod.rs
      shared/
        config.rs
        errors.rs
        fs_paths.rs
        logging.rs
        process.rs
        sqlite.rs
        time.rs
```

Layer responsibilities:

| Layer | Responsibility | Should avoid |
|---|---|---|
| `routing` | CLI command, local control API, or Tauri command input/output mapping | Domain decisions, direct database/file mutations |
| `service` | Domain workflow, validation, orchestration, child-process lifecycle decisions | Raw storage details leaking into callers |
| `repository` | Persistence, state files, pid files, SQLite reads/writes, external command state lookup | Cross-domain orchestration or UI-facing shaping |
| `shared` | Cross-domain utilities: config, errors, paths, logging, process helpers, SQLite helpers | Domain-specific policy or business rules |

Dependency direction:

```text
routing -> service -> repository
                  -> shared
repository -> shared
```

Rules:

- A domain may expose a small `mod.rs` facade, but other domains should not import its private `repository` or `service` directly.
- `routing` can call only its own domain `service`, plus shared input parsing helpers.
- `service` may use its own `repository` and `shared`; cross-domain calls should go through explicit public service interfaces.
- `repository` must not call `routing`.
- `shared` must not import from `domains`.
- If a helper is used by only one domain, keep it inside that domain instead of promoting it to `shared`.
- TypeScript parity adapters should live in the domain that owns the delegated command, not in `shared`.

## Coexistence Model

### Mode 1: TypeScript Native

Existing commands continue to work:

```bash
bun run start:mcp
bun run doctor
bun run queue:supervisor
bun run sync:agent-logs
```

This remains the development baseline until Rust parity is proven.

### Mode 2: Rust Host Delegates To TypeScript

Rust commands launch existing TypeScript entrypoints and manage lifecycle.

Examples:

```bash
context-stilld start
context-stilld stop
context-stilld status
context-still doctor
context-still mcp start
context-still queue start
```

The Rust layer owns process state, pid files, logs, paths, and bootstrap preflight. The TypeScript layer still owns business logic.

### Mode 3: Rust Native For Selected Low-Level Tasks

Only stable low-level tasks move to Rust after parity:

- app data path resolution
- SQLite file existence / lock / backup preflight
- config discovery
- LaunchAgent / Windows Task registration
- process supervision
- log rotation
- minimal doctor summary

TypeScript remains available as fallback until the Rust path has run successfully across desktop and server-like modes.

### Mode 4: Cutover Per Boundary

Cutover is per boundary, not global. A boundary can switch to Rust only when:

- the TypeScript command still exists as fallback,
- parity tests pass,
- rollback is documented,
- docs name Rust as the default for that boundary,
- one release cycle has run without critical regression.

## Migration Boundaries

| Boundary | Initial Rust role | TypeScript retained? | Cutover condition |
|---|---|---|---|
| CLI shell | Dispatch and help text wrapper | Yes | Rust CLI covers existing command aliases and exit codes |
| Daemon supervisor | Start/stop/status/log process lifecycle | Yes | Can manage MCP, queue, agent-log-sync, Hono admin API without data loss |
| Bootstrap | Path/settings/SQLite preflight | Yes | Fresh app data path can initialize without manual terminal steps |
| Doctor facade | Desktop/server summary and delegated full report | Yes | Summary matches full TypeScript doctor status mapping |
| Backup/restore launcher | Validate paths, stop writers, delegate/execute backup | Yes | SQLite backup restore smoke passes repeatedly |
| MCP lifecycle | Register/start/stop stdio server process | Yes | Existing MCP smoke passes under Rust-managed process |
| Queue supervisor lifecycle | Manage worker process and restart policy | Yes | Queue smoke passes and shutdown is graceful |
| Agent log sync lifecycle | Schedule/run one-shot sync | Yes | Sync state updates match TypeScript automation |
| Service logic | None at first | Yes | Separate future plan required |

## Milestones

### Milestone 0: Baseline And Contracts

Deliverables:

- Inventory current CLI commands and exit codes.
- Inventory current long-running processes and shutdown behavior.
- Document Hono admin facade boundary.
- Define process state file locations for desktop and development.
- Define logs, pid, socket, DB, and backup paths.

Exit criteria:

- No Rust code is required yet.
- Current TypeScript commands are documented as baseline.
- Each Rust boundary has a named fallback command.

### Milestone 1: Rust Workspace Skeleton

Deliverables:

- Add Rust workspace under a clear path such as `crates/` or `desktop/src-tauri/`.
- Add `context-stilld` daemon binary skeleton.
- Add `context-still` Rust CLI skeleton, if it will replace the current JS CLI dispatcher later.
- Add the domain-first source layout with `routing` / `service` / `repository` files only where a domain needs them.
- Add `shared` only for cross-domain utilities, not as a dumping ground for domain policy.
- Implement `--version`, `status`, and `paths` commands only.
- Do not change existing package scripts yet.

Exit criteria:

- Rust build is optional.
- TypeScript workflow remains unchanged.
- Rust command can print resolved app paths without touching DB state.
- Domain module boundaries and dependency direction are visible before behavior is added.

### Milestone 2: Rust Host Delegation

Deliverables:

- Rust daemon can launch existing TypeScript MCP process.
- Rust daemon can launch existing TypeScript queue supervisor.
- Rust daemon can launch existing TypeScript agent-log-sync command.
- Rust daemon can start/stop Hono admin API only when requested by UI/operator.
- Rust daemon tracks child process pid, status, exit reason, and logs.

Exit criteria:

- Existing TypeScript commands still work directly.
- Rust-managed MCP passes existing MCP smoke.
- Rust-managed worker shutdown is graceful.
- Hono can be stopped without stopping daemon-side MCP/queue supervision.

### Milestone 3: Desktop Bootstrap And Doctor Facade

Deliverables:

- Rust path resolver for app data, logs, backup, SQLite DB, runtime settings.
- Rust bootstrap preflight:
  - no database
  - migration needed
  - settings incomplete
  - MCP not registered
  - optional embedding unavailable
- Rust doctor summary that delegates full detail to TypeScript doctor when needed.
- UI/Tauri can read concise daemon status.

Exit criteria:

- Fresh desktop data path can reach a recoverable setup state.
- Doctor summary does not require Hono to be running.
- Full TypeScript doctor remains available for detailed diagnostics.

### Milestone 4: Low-Level Native Rust Tasks

Deliverables:

- Native Rust SQLite backup preflight and writer-stop coordination.
- Native Rust log/pid cleanup.
- Native Rust LaunchAgent / Windows Task registration, or a clear wrapper around existing scripts.
- Optional local control socket/API for daemon status and lifecycle commands.

Exit criteria:

- Backup and lifecycle tasks no longer require a full TypeScript startup path.
- TypeScript fallback remains available.
- Failure messages are user-facing and recoverable.

### Milestone 5: Verification Gates

Deliverables:

- `verify:rust-daemon` or equivalent focused gate.
- Rust-managed MCP smoke.
- Rust-managed queue smoke.
- Rust-managed bootstrap smoke with temporary app data path.
- Docs link validation for runtime boundary docs.

Exit criteria:

- Rust boundary can be tested independently of full Tauri packaging.
- CI can run the Rust boundary tests without changing default developer workflow.

### Milestone 6: Default Switch Per Boundary

Deliverables:

- Switch one boundary at a time to Rust default.
- Keep TypeScript fallback command for at least one release cycle.
- Update README / architecture docs for each switch.
- Record rollback instructions.

Exit criteria:

- No global big-bang switch.
- Every default switch has rollback and parity evidence.

## Parity Requirements

### CLI Parity

- Same command intent.
- Same JSON shape where `--json` exists.
- Same exit code semantics.
- Same error class where callers depend on it.
- Same environment variable interpretation, unless explicitly migrated.

### Source Layout Parity

- Each Rust domain has an owner and a clear responsibility.
- `routing`, `service`, and `repository` responsibilities are not mixed.
- Cross-domain utilities live in `shared`.
- Domain-specific policy is not placed in `shared`.
- No domain imports another domain's private repository directly.

### MCP Parity

- Existing tool inventory remains stable.
- Existing MCP contract tests pass.
- `initial_instructions`, `context_compile`, `compile_eval`, `context_decision`, memory/search/episode tools remain available.
- Stdio behavior does not depend on Hono/admin UI.

### Worker Parity

- Existing queue claims, completion, retry, pause/resume, and events stay compatible.
- A job is not marked complete until downstream mutation succeeds.
- Graceful shutdown waits for active worker loops to yield.
- Rust supervision must not hide TypeScript worker failures.

### Doctor Parity

- Rust summary maps correctly to full doctor status.
- Server-only checks do not block desktop readiness.
- Detailed TypeScript report remains available.

## Rollback Strategy

Every Rust-managed boundary must have:

- direct TypeScript command fallback,
- documented environment flag or config switch,
- log location for Rust host and delegated child process,
- graceful shutdown command,
- data mutation avoidance in early milestones,
- smoke command to prove fallback still works.

Suggested flags:

```text
CONTEXT_STILL_RUNTIME_HOST=typescript|rust
CONTEXT_STILL_DAEMON_MANAGED_MCP=0|1
CONTEXT_STILL_DAEMON_MANAGED_QUEUE=0|1
CONTEXT_STILL_DAEMON_MANAGED_API=0|1
```

These names are planning placeholders. Final names should match existing config conventions.

## Verification Plan

Minimum checks before any default switch:

```bash
bun run verify
bun run verify:sqlite
bun run mcp:smoke:sqlite
```

Additional focused checks to add:

```bash
bun run verify:desktop-readiness
bun run verify:rust-daemon
```

`verify:rust-daemon` should cover:

- Rust binary builds.
- `context-stilld paths` works with a temp app data root.
- Rust-managed MCP smoke passes.
- Rust-managed queue one-shot can run with a test DB.
- Rust daemon can start and stop Hono admin API without stopping daemon state.
- Fallback TypeScript commands still work.

## Documentation Updates Required

- README:
  - name Rust daemon as future runtime host only after Milestone 2.
  - keep TypeScript commands in quick start until default switch.
- `spec/pub/architecture.md`:
  - keep Hono as admin UI facade.
  - document Rust daemon as runtime host when implemented.
- `spec/pub/operations.md`:
  - add start/stop/status/logs lifecycle once commands exist.
- `spec/docs/tauri-product-readiness-improvement-plan.md`:
  - keep this plan as the implementation detail for Rust boundary migration.

## Non-Goals

- Do not Rust-rewrite product logic just because the host is Rust.
- Do not delete TypeScript CLI/MCP/worker paths before parity.
- Do not make Hono the owner of background runtime behavior.
- Do not make MCP registration mandatory for app usage.
- Do not collapse desktop and future server product requirements into one forced runtime.

## Open Questions

1. Should Rust daemon expose a local HTTP control API, a Unix socket/named pipe, or CLI-only control initially?
2. Should Hono admin API be child process managed by the daemon, or launched directly by Tauri during UI sessions?
3. Should queue supervisor be one child process for all queues or one child per queue?
4. Should Rust path resolution become the source of truth before or after Tauri shell scaffolding?
5. How long should TypeScript fallback remain after a boundary switches to Rust default?

## Suggested First Slice

1. Inventory current CLI/MCP/worker command contracts.
2. Add Rust workspace skeleton with no runtime behavior change.
3. Implement `context-stilld paths` and `context-stilld status --json`.
4. Add docs-only wiring for Rust boundary plan.
5. Only then implement Rust host delegation for MCP as the first managed process.
