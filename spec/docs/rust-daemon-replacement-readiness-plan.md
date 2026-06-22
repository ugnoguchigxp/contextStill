# Rust Daemon Replacement Readiness Implementation Plan

## Purpose

Rust `context-stilld` を「既存 TypeScript daemon / worker entrypoint の受け皿」から、boundary ごとに default runtime として切り替え可能な状態へ進めるための実装計画である。

この文書での「置き換え可能」は、Rust が product logic を全面移植することではない。Rust が runtime host として lifecycle、transport、状態記録、shutdown、smoke、rollback を満たし、TypeScript fallback を残したまま default を boundary 単位で切り替えられる状態を指す。

## Packaged Desktop Runtime Boundary

Tauri 配布後の目標は、常駐 runtime から Node/Bun と UI 用 API 層をできるだけ外すことである。

ただし、TypeScript を完全排除することはこの計画の目的ではない。TypeScript は UI-time API や one-shot script sidecar として残せる。境界は「どの言語で書かれているか」ではなく、「常駐するか」「長時間・副作用ありタスクを所有するか」で決める。

| Runtime surface | Residency | Owner | Allowed responsibilities | Not allowed |
|---|---|---|---|---|
| Resident Rust runtime | Always-on | `context-stilld` | process supervision, daemon-owned MCP endpoint/session management, queue host, scheduler, state/log/readiness, SQLite writer guard, backup preflight | Product logic rewrite, full Hono admin API, UI session state, direct stdio MCP spawning |
| UI-time Hono admin API | UI session only | Hono child process managed by Rust or a thin runner | UI data reads/writes, settings screens, operator actions, health/readiness endpoints | Resident runtime duties, durable long-running task ownership |
| Thin Node/Bun runner | UI-time or one-shot only | Rust-managed sidecar | spawn Hono child, run one-shot scripts, capture stdout/stderr, wait readiness, return exit code | Importing full Hono API in a resident process, owning durable tasks |
| One-shot TypeScript sidecars | Explicit command only | Rust-managed child process | migration, backfill, import/export, repair, smoke, dev/test support | Background worker semantics unless promoted to Rust-managed queue/task |
| Dev/test scripts | Development only | Developer/CI | tests, fixtures, local verification | Packaged app runtime requirements |

Important boundaries:

- A Node/Bun process can be acceptable as a sidecar, but the full Hono admin API must not be part of the resident runtime.
- If a thin Node/Bun runner is used, it should start Hono as a child process rather than importing `api/app.ts` into a resident process.
- Closing the UI may stop the Hono API and thin runner, but must not stop Rust-owned queue work, MCP serving, scheduled sync, or durable sidecar tasks.
- Repo-local env defaults are not sufficient for packaged mode. Desktop runtime mode must explicitly set writable state paths, SQLite paths, log paths, and local API origin.

## Task Ownership Policy

UI shutdown safety depends on task ownership.

| Task kind | Owner | UI shutdown policy |
|---|---|---|
| Read-only UI API request | Hono API | May stop immediately after request ends |
| Enqueue-only UI action | Hono API creates durable job; Rust/queue owns execution | UI may close after durable enqueue succeeds |
| Queue worker task | Resident Rust runtime / TS worker child until migrated | Must continue after UI closes |
| Agent log sync scheduled task | Resident Rust runtime | Must continue or record exit state after UI closes |
| Migration/backfill/import/export | Rust-managed one-shot sidecar | UI close must not kill unless task is explicitly cancelable |
| UI-bound preview/smoke | UI-time runner | May cancel on UI close if documented as cancelable |

Long-running, non-idempotent, or DB-writing tasks must not be owned only by Hono request handlers or by the UI-time runner. They must either be durable queue jobs or Rust-managed child processes with pid/state/log/exit metadata.

## Current State

実装済み:

- Rust workspace と `context-stilld` binary。
- `paths`, `status`, `bootstrap preflight/init`, `doctor summary`, `backup preflight`。
- `mcp`, `queue`, `agent-log-sync`, `admin-api` の `start|stop|status` lifecycle wrapper。
- pid/state/log path 管理と lifecycle exit metadata。
- lifecycle JSON output。
- Rust-managed MCP / queue / admin API / agent-log-sync focused smoke。
- `agent-log-sync run --wait --json`。
- admin API readiness polling。
- backup preflight active writer guard and `--require-idle`。
- boundary default flag observability in `status --json`。
- `verify:rust-daemon`。
- CI の Rust daemon gate。

未達:

- boundary ごとの package script default switch。
- default switch 後の rollback 手順の公開 runbook。
- Hono admin API の port conflict 専用 structured error test。
- UI shutdown 時の task ownership / sidecar stop policy の完全実装。
- thin runner / one-shot sidecar execution registry。
- packaged desktop runtime boundary の実装反映。

## Replacement-Ready Definition

各 boundary は、次をすべて満たしたときだけ default switch 候補にできる。

| Requirement | Pass condition |
|---|---|
| TypeScript fallback remains | Direct `bun run ...` fallback command still works and is documented |
| Rust start/stop/status works | Rust command starts the intended process, reports pid/status/log path, and stops it |
| Readiness is observable | Start command does not report ready until the daemon endpoint is reachable and tool inventory can be listed |
| Exit state is recorded | Normal exit, non-zero exit, signal stop, and stale pid are represented in state JSON |
| Smoke passes | Boundary-specific Rust-managed smoke runs in CI/local without external LLM requirements |
| Rollback is documented | One command or env flag restores TypeScript default |
| No hidden product rewrite | TypeScript business logic remains source of truth until a separate parity plan exists |

## Implementation Order

Do not start with default switch. Implement in this order:

1. Process state reconciliation and child exit tracking.
2. Daemon-owned MCP endpoint and session manager.
3. Rust-managed daemon MCP smoke.
4. Queue supervisor safe smoke.
5. Agent log sync run-and-wait mode.
6. UI-time Hono admin API readiness and stop independence.
7. Backup writer coordination hardening.
8. Thin runner / one-shot sidecar policy and packaged-mode env overrides.
9. Boundary default flags and rollback docs.
10. Per-boundary default switch.

## Phase 1: Process State Reconciliation

### Goal

Make Rust lifecycle state trustworthy after child exit, failed start, stale pid files, and stop commands.

### Design Decision

Keep `ProcessSupervisor` as the boundary abstraction, but add state reconciliation helpers rather than embedding policy in each domain.

Add a process state model that can represent:

- `starting`
- `running`
- `stopped`
- `exited`
- `failed`
- `stale`
- `degraded`

The existing `ProcessState.status: String` can remain for compatibility, but service logic should write known status values and include exit metadata.

### Implementation Tasks

- Extend `ProcessState` with optional fields:
  - `started_at`
  - `updated_at`
  - `exit_code`
  - `exit_signal`
  - `last_error`
  - `command`
  - `args`
- Add `reconcile_process_state(run_dir, spec, supervisor)`:
  - If state/pid exists and process is alive: return current state.
  - If pid exists but process is dead: mark `stale` or `exited`.
  - If state is malformed: return structured error, do not panic.
- Make `status --json` include reconciled states.
- Make `stop` clear stale pid/state consistently.

### Verification

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run verify:rust-daemon
```

Required tests:

- stale pid resolves to `stale` or `stopped` according to documented rule.
- malformed state file returns non-zero structured error or degraded state, not panic.
- stopped process does not remain `running` in JSON.
- one-shot wait records `exited` / `failed`, exit code, signal, and timeout reason.

### Done

- `context-stilld status --json` never reports a dead pid as running.
- `context-stilld <boundary> status --json` includes enough metadata to debug child lifecycle.
- `ProcessState` records command, args, started/updated timestamps, exit code/signal, and last error when known.

## Phase 2: Daemon-Owned MCP Endpoint

### Goal

Move MCP ownership into the resident daemon and remove the direct stdio child process path.

### Design Decision

This phase is superseded by [Daemon-Owned MCP Runtime Plan](daemon-owned-mcp-runtime-plan.md).

Do not add `context-stilld mcp serve` as a foreground stdio proxy. That still leaves MCP availability tied to per-client stdio process lifecycle. The default runtime must be a daemon-owned local MCP endpoint, with active sessions, tool workers, cleanup, and stale-state reconciliation owned by `context-stilld`.

Direct stdio context-still MCP has been deleted. Do not restore `src/index.ts`, a stdio transport binding, command-based client registration, or stdio smoke as compatibility fallbacks.

### Implementation Tasks

- Add a loopback daemon MCP endpoint, for example `http://127.0.0.1:<daemon-port>/mcp`.
- Add `context-stilld mcp endpoint --json`, `mcp status --json`, and `mcp sessions --json`.
- Move MCP client registration to URL-based config instead of command-based stdio config.
- Split TypeScript tool handlers from stdio transport so the daemon can call them through a daemon-managed worker or local RPC.
- Add session cleanup: idle timeout, transport close, daemon shutdown, worker crash handling, close reasons.
- Keep `context-stilld mcp start|stop` limited to the daemon-owned endpoint worker; they must not manage or restore a stdio MCP child.
- Keep stdio context-still MCP deleted: no `src/index.ts`, no stdio transport binding, no stdio smoke.

### Verification

Add:

```bash
context-stilld mcp endpoint --json
context-stilld mcp smoke --json
```

Expected behavior:

- MCP client registration does not spawn `bun`.
- Existing MCP tool inventory passes through the daemon endpoint.
- `pgrep -af "bun run src/index.ts"` remains empty during normal MCP use.
- `context-stilld mcp sessions --json` shows active sessions and close reasons.

Also run:

```bash
bun run verify:rust-daemon
context-stilld mcp smoke --json
```

### Done

- Daemon-owned MCP smoke passes locally and in CI.
- Direct stdio context-still MCP is no longer present.
- URL-based daemon endpoint smoke is the MCP verification path.

## Phase 3: Queue Supervisor Safe Smoke

### Goal

Prove Rust can start and stop the existing queue supervisor against a dedicated safe database without changing queue semantics.

### Design Decision

Do not make Rust mark jobs complete. Rust only supervises the TS queue process.

Use a dedicated SQLite test DB under `.tmp/` by default. Test DB path must include `test` or `smoke` to prevent accidental live DB use.

### Implementation Tasks

- Add `scripts/rust-managed-queue-smoke.mjs`.
- Create temp app data root and temp SQLite path.
- Run migrations/setup needed for the operational queue smoke.
- Start queue through:

```bash
cargo run -q -p context-stilld -- queue start --json
```

- Enqueue a safe workload or reuse a minimal existing queue smoke fixture.
- Poll state/output until one safe unit is processed or timeout.
- Stop through:

```bash
cargo run -q -p context-stilld -- queue stop --json
```

- Assert no managed queue pid remains alive.

### Verification

```bash
bun run verify:queue:smoke
bun run rust:queue:smoke
bun run verify:rust-daemon
```

`rust:queue:smoke` is deterministic and uses a temporary SQLite DB path whose filename includes `smoke`.

### Done

- Rust-managed queue smoke passes with a test DB.
- Existing `bun run verify:queue:smoke` still passes.
- Queue completion semantics are unchanged.

## Phase 4: Agent Log Sync Run-And-Wait

### Goal

Make one-shot agent-log-sync usable as a Rust-managed task, not only as a background start command.

### Design Decision

Add an explicit run-and-wait mode rather than treating one-shot sync as a daemon process.

Recommended command:

```bash
context-stilld agent-log-sync run --wait --json
```

### Implementation Tasks

- Extend CLI parsing for `--wait`.
- Add process wait support to `ProcessSupervisor`.
- Capture exit code and update state as `exited` or `failed`.
- Preserve existing `run` behavior if it is useful as fire-and-forget.
- Add timeout handling with a non-zero exit and state `failed`.

### Verification

Required tests:

- mock child exits 0 -> state `exited`, exit_code 0.
- mock child exits non-zero -> state `failed`, exit_code non-zero.
- timeout -> non-zero CLI exit, state `failed`.

Commands:

```bash
cargo test --workspace
bun run rust:agent-log-sync:smoke
bun run verify:rust-daemon
```

### Done

- One-shot sync completion is observable from Rust JSON.
- Direct TypeScript `bun run sync:agent-logs` fallback remains.

## Phase 5: UI-Time Hono Admin API Readiness

### Goal

Prove Rust can manage Hono admin API for UI/operator sessions without making the full API part of the resident runtime and without affecting daemon-side MCP/queue/agent-log-sync.

### Design Decision

`admin-api start` should not report ready only because spawn succeeded. It should wait for a health/readiness endpoint or port listener.

Hono admin API is a UI-time process, not a resident daemon boundary. It may be started directly by Rust or through a thin Node/Bun runner, but the runner must not import the full Hono API into a resident process. If a runner is used, it should spawn the Hono API as a child process, capture stdout/stderr, wait for readiness, and terminate the child on UI close or idle timeout.

### Implementation Tasks

- Define admin API readiness URL and timeout.
- Add readiness polling after spawn.
- Handle port conflict as structured error.
- Add UI-time mode metadata to lifecycle JSON so the process is distinguishable from resident daemon boundaries.
- Add stop independence test:
  - start MCP/queue mock states,
  - start/stop admin API,
  - assert MCP/queue state remains unchanged.
- Add UI-close stop policy:
  - stopping admin API must not kill Rust-owned queue/MCP/agent-log-sync state,
  - stopping admin API may terminate only its own Hono child process,
  - in-flight non-cancelable sidecar tasks must be preserved or rejected before stop.
- Add real-process smoke if API can bind to a random test port.

### Verification

```bash
bun run test:unit:api
bun run rust:admin-api:smoke
bun run verify:rust-daemon
```

### Done

- Admin API readiness failure is visible as structured error.
- Stopping admin API does not stop or mutate MCP/queue/agent-log-sync state.
- Hono admin API is documented and tested as UI-time, not resident.

## Phase 6: Backup Writer Coordination

### Goal

Make backup preflight reliable enough to block unsafe Rust-managed backup work when managed writers are active.

### Design Decision

Do not implement destructive restore in this phase. Keep TypeScript backup fallback.

### Implementation Tasks

- Treat any non-stopped managed writer as active.
- Include active writer pid/status/log path in backup preflight JSON.
- Add optional `--require-idle` flag that exits non-zero when managed writers are active.
- Add test for `queue-supervisor=degraded` and `agent-log-sync=running` both blocking idle requirement.

### Verification

```bash
cargo test --workspace
bun run verify:sqlite
bun run verify:rust-daemon
```

### Done

- Backup preflight can be used as a guard before TS backup.
- `context-stilld backup preflight --require-idle --json` exits non-zero when managed writers are active.
- No restore behavior is added.

## Phase 7: Thin Runner And One-Shot Sidecar Policy

### Goal

Allow TypeScript to remain useful for UI-time and one-shot work without making Node/Bun or the full Hono API resident runtime dependencies.

### Design Decision

A thin Node/Bun runner is allowed only as a managed sidecar. It can spawn Hono or one-shot scripts, but it must not become the owner of durable work.

Recommended constraints:

- Resident Rust runtime may start/stop the runner.
- Runner must write stdout/stderr to managed logs or forward them to Rust.
- Runner must return structured exit state.
- Runner must not import `api/app.ts` in a resident process.
- Runner must spawn Hono as a child process when UI API is needed.
- Runner must treat migration/backfill/import/export as explicit one-shot tasks.
- Runner must distinguish `ui-bound` tasks from `detached` tasks.

### Implementation Tasks

- Add sidecar task classification:
  - `ui-bound`: may be canceled on UI close.
  - `detached`: must continue after UI close or record controlled cancellation.
- Add sidecar execution records with:
  - task id,
  - command/args,
  - pid,
  - log path,
  - started/updated timestamps,
  - exit code/signal,
  - cancelability.
- Add packaged-mode env override plan:
  - app data dir,
  - SQLite core path,
  - logs/run/backup dirs,
  - local API origin,
  - bundled runner path.
- Document that dev/test scripts are not packaged runtime requirements.

### Verification

Required tests:

- UI-close stops Hono API child but does not mutate resident boundary states.
- UI-close does not kill `detached` sidecar tasks.
- `ui-bound` sidecar cancellation records controlled exit state.
- runner startup failure preserves stderr and structured error.

Commands:

```bash
cargo test --workspace
bun run verify:rust-daemon
```

### Done

- Thin runner is an optional sidecar execution surface, not a resident API host.
- One-shot TypeScript scripts can remain TypeScript without weakening resident Rust runtime goals.
- Task ownership is explicit enough to decide UI shutdown behavior.

## Phase 8: Default Switch Flags

### Goal

Make boundary default switches reversible and explicit.

### Design Decision

Use boundary-specific env/config flags first. Do not use a global Rust default switch.

Candidate flags:

```text
CONTEXT_STILL_DAEMON_MANAGED_MCP=0|1
CONTEXT_STILL_DAEMON_MANAGED_QUEUE=0|1
CONTEXT_STILL_DAEMON_MANAGED_AGENT_LOG_SYNC=0|1
CONTEXT_STILL_DAEMON_MANAGED_ADMIN_API=0|1
```

These names are implemented as observable flags in `context-stilld status --json`. They do not change package script defaults yet.

These flags apply only to runtime-host boundaries. They do not make every TypeScript CLI a Rust implementation target.

### Implementation Tasks

- Add config reader for runtime host flags.
- Add docs for fallback command per boundary.
- Make runtime-host package scripts use Rust only when the relevant flag is enabled.
- Keep direct TS scripts available.
- Add CLI classification docs:
  - runtime-host,
  - UI-time API,
  - one-shot sidecar,
  - product CLI,
  - dev/test script.
- Add rollback section to public operations docs.

### Verification

For each boundary:

```bash
# Rust path, not the package default yet
CONTEXT_STILL_DAEMON_MANAGED_<BOUNDARY>=1 bun run <boundary script>

# Rollback path
CONTEXT_STILL_DAEMON_MANAGED_<BOUNDARY>=0 bun run <boundary script>
```

Required result:

- Both paths pass their smoke.
- Current default remains TypeScript until the boundary-specific smoke is green in CI.

### Done Before Default Switch

- Flag state is visible from `context-stilld status --json`.
- Direct TS scripts remain available as rollback/fallback paths.
- Boundary default script switching is still intentionally pending.
- Product/data CLI scripts remain TypeScript unless a separate parity plan exists.

## Phase 9: Per-Boundary Default Switch

### Goal

Switch one boundary at a time after smoke evidence exists.

For UI-time boundaries, "default switch" means the default management path used when that surface is requested. It does not mean the surface becomes resident.

### Switch Order

1. Agent log sync one-shot wrapper.
2. UI-time Admin API lifecycle.
3. Daemon-owned MCP endpoint.
4. Queue supervisor.
5. Backup preflight guard.
6. Thin runner / sidecar execution policy.

Queue is intentionally later because it mutates durable work queues.

### Required Evidence Per Switch

Each default switch PR must include:

- Changed package script/config.
- Rust smoke output.
- TypeScript fallback smoke output.
- Rollback command.
- Docs update.
- No unrelated product logic migration.
- Task ownership statement for UI shutdown behavior when applicable.

### Verification

Minimum:

```bash
bun run verify
bun run verify:rust-daemon
```

Plus boundary focused gate:

- MCP: `context-stilld mcp smoke --json` and no direct stdio MCP process remains
- Queue: `bun run verify:queue:smoke` and `bun run rust:queue:smoke`
- Admin API: `bun run test:unit:api` and `bun run rust:admin-api:smoke`
- Agent log sync: `bun run rust:agent-log-sync:smoke`
- Backup: `bun run verify:sqlite`
- Sidecar runner: UI-close / detached-task / stderr-capture smoke

## First Implementation Slice

Start here:

1. Add lifecycle state reconciliation and exit metadata.
2. Add daemon-owned MCP endpoint and session registry.
3. Add `context-stilld mcp smoke --json`.
4. Wire `verify:rust-daemon` to include the daemon MCP smoke only after it is deterministic.
5. Delete direct stdio MCP surfaces after the daemon endpoint becomes the default registration path.

This slice resolves the main current blocker: Rust-managed MCP cannot be proven while the only Rust mode is background stdio child start with stdout/stderr redirected to logs. The desired endpoint is not a stdio proxy; stdio is a legacy migration target.

## Stop Conditions

Stop and ask for review if:

- A task requires deleting TypeScript product logic without a parity plan.
- A task requires changing MCP tool schemas or tool names.
- A task requires changing queue job completion semantics.
- A task requires destructive backup restore behavior.
- A task requires global Rust default switch.
- A smoke would need to run against a non-test DB.
- A task would make the full Hono admin API part of the resident runtime.
- A UI-close path would kill a non-cancelable DB-writing or long-running task.
- A thin runner would become the durable owner of queue/provider/migration work without pid/state/log/exit tracking.

## Neutral Review Checklist

Use this checklist before implementation and before each default switch PR.

| Question | Expected answer |
|---|---|
| Does this reduce resident Node/Bun/API surface? | Yes, or the exception is documented as UI-time/one-shot |
| Does a long-running task have a durable owner? | Yes: Rust runtime, queue, or managed child state |
| Can UI close safely during this operation? | Yes, or the operation is explicitly non-cancelable and blocks/defers shutdown |
| Is Hono admin API resident? | No |
| Does the thin runner import full API modules while resident? | No |
| Does MCP depend on direct stdio child processes? | No |
| Is TypeScript product logic being silently rewritten? | No |
| Is rollback still one command or one config flag? | Yes |
| Are packaged-mode paths explicit? | Yes: app data, SQLite, logs, run, backup, local API origin |

If two or more expected answers fail, do not include the change in the daemon replacement track. Split it into a separate product CLI or data migration parity plan.

## Tracking Table

| ID | Task | Depends on | Gate | Status |
|---|---|---|---|---|
| RR-01 | Process state reconciliation | current lifecycle wrapper | `cargo test`, `verify:rust-daemon` | implemented |
| RR-02 | Daemon-owned MCP endpoint and session registry | RR-01 | `context-stilld mcp endpoint --json` | implemented as managed HTTP endpoint worker |
| RR-03 | Daemon MCP smoke and stdio legacy warnings | RR-02 | `context-stilld mcp smoke --json` + managed smoke | implemented |
| RR-04 | Rust-managed queue smoke | RR-01 | `rust:queue:smoke` | implemented |
| RR-05 | Agent log sync run-and-wait | RR-01 | unit tests + `verify:rust-daemon` | implemented |
| RR-06 | Admin API readiness smoke | RR-01 | `rust:admin-api:smoke` | implemented |
| RR-07 | Backup idle guard | RR-01 | `verify:sqlite`, `verify:rust-daemon` | implemented |
| RR-08 | Thin runner and sidecar policy | RR-01, RR-06 | UI-close / detached-task / stderr-capture smoke | partially implemented; registry pending |
| RR-09 | Default switch flags and stdio deletion gates | RR-02 through RR-08 | boundary smoke pairs + no production stdio MCP references | flag observability implemented; script default switch pending |
| RR-10 | Per-boundary default switch | RR-09 | focused gate per boundary | blocked by RR-09 |
