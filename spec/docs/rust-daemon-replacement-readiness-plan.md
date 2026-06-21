# Rust Daemon Replacement Readiness Implementation Plan

## Purpose

Rust `context-stilld` を「既存 TypeScript daemon / worker entrypoint の受け皿」から、boundary ごとに default runtime として切り替え可能な状態へ進めるための実装計画である。

この文書での「置き換え可能」は、Rust が product logic を全面移植することではない。Rust が runtime host として lifecycle、transport、状態記録、shutdown、smoke、rollback を満たし、TypeScript fallback を残したまま default を boundary 単位で切り替えられる状態を指す。

## Current State

実装済み:

- Rust workspace と `context-stilld` binary。
- `paths`, `status`, `bootstrap preflight/init`, `doctor summary`, `backup preflight`。
- `mcp`, `queue`, `agent-log-sync`, `admin-api` の `start|stop|status` lifecycle wrapper。
- pid/state/log path 管理。
- lifecycle JSON output。
- `verify:rust-daemon`。
- CI の Rust daemon gate。

未達:

- Rust-managed MCP smoke。
- Rust-managed queue smoke。
- one-shot child process の終了監視と exit reason 記録。
- Hono admin API の readiness / port conflict / stop independence の実プロセス検証。
- stale pid cleanup / orphan recovery / child exit reconciliation。
- boundary ごとの default switch flag と rollback 手順。

## Replacement-Ready Definition

各 boundary は、次をすべて満たしたときだけ default switch 候補にできる。

| Requirement | Pass condition |
|---|---|
| TypeScript fallback remains | Direct `bun run ...` fallback command still works and is documented |
| Rust start/stop/status works | Rust command starts the intended process, reports pid/status/log path, and stops it |
| Readiness is observable | Start command does not report ready until the child is reachable or explicitly running in foreground proxy mode |
| Exit state is recorded | Normal exit, non-zero exit, signal stop, and stale pid are represented in state JSON |
| Smoke passes | Boundary-specific Rust-managed smoke runs in CI/local without external LLM requirements |
| Rollback is documented | One command or env flag restores TypeScript default |
| No hidden product rewrite | TypeScript business logic remains source of truth until a separate parity plan exists |

## Implementation Order

Do not start with default switch. Implement in this order:

1. Process state reconciliation and child exit tracking.
2. MCP attachable transport / foreground proxy.
3. Rust-managed MCP smoke.
4. Queue supervisor safe smoke.
5. Agent log sync run-and-wait mode.
6. Hono admin API readiness and stop independence.
7. Backup writer coordination hardening.
8. Boundary default flags and rollback docs.
9. Per-boundary default switch.

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

### Done

- `context-stilld status --json` never reports a dead pid as running.
- `context-stilld <boundary> status --json` includes enough metadata to debug child lifecycle.

## Phase 2: MCP Foreground Proxy

### Goal

Unblock Rust-managed MCP smoke without inventing a fake attach path to an already-started stdio child.

### Design Decision

Add a foreground proxy command:

```bash
context-stilld mcp serve
```

This command is different from background `mcp start`.

- `mcp serve` runs in the foreground and speaks MCP stdio to the client.
- It spawns the existing TypeScript MCP process with piped stdin/stdout/stderr.
- It byte-for-byte proxies stdin/stdout between client and TS child.
- It writes child stderr to `logs/mcp.log`.
- It records pid/state while running.
- It exits with the child exit code.

This keeps TypeScript MCP tool logic as source of truth while allowing MCP clients to use Rust as the executable entrypoint.

### Implementation Tasks

- Add `McpAction::Serve`.
- Add `ProcessSupervisor::spawn_piped` or a dedicated `stdio_proxy` helper.
- Ensure stdout is not polluted by Rust logs in proxy mode.
- Record state before proxy loop starts.
- On EOF or signal, terminate child and update state.
- Keep `mcp start|stop|status` for background lifecycle experiments, but do not use it for MCP client stdio smoke.

### Verification

Add:

```bash
bun run mcp:smoke:sqlite:rust
```

Expected behavior:

- Smoke uses `command: cargo`, args `["run", "-q", "-p", "context-stilld", "--", "mcp", "serve"]`.
- Existing MCP tool inventory passes.
- No orphan TS MCP process remains after smoke.
- `logs/mcp.log` receives stderr only.

Also run:

```bash
bun run verify:rust-daemon
bun run mcp:smoke:sqlite
bun run mcp:smoke:sqlite:rust
```

### Done

- Rust-managed MCP smoke passes locally and in CI.
- TypeScript `bun run start:mcp` fallback still passes.

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

Add `rust:queue:smoke` to `package.json` only after the script is deterministic.

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
bun run verify:rust-daemon
```

### Done

- One-shot sync completion is observable from Rust JSON.
- Direct TypeScript `bun run sync:agent-logs` fallback remains.

## Phase 5: Hono Admin API Readiness

### Goal

Prove Rust can manage Hono admin API for UI/operator sessions without affecting daemon-side MCP/queue/agent-log-sync.

### Design Decision

`admin-api start` should not report ready only because spawn succeeded. It should wait for a health/readiness endpoint or port listener.

### Implementation Tasks

- Define admin API readiness URL and timeout.
- Add readiness polling after spawn.
- Handle port conflict as structured error.
- Add stop independence test:
  - start MCP/queue mock states,
  - start/stop admin API,
  - assert MCP/queue state remains unchanged.
- Add real-process smoke if API can bind to a random test port.

### Verification

```bash
bun run test:unit:api
bun run verify:rust-daemon
```

Future focused gate:

```bash
bun run rust:admin-api:smoke
```

### Done

- Admin API readiness failure is visible as structured error.
- Stopping admin API does not stop or mutate MCP/queue/agent-log-sync state.

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
- No restore behavior is added.

## Phase 7: Default Switch Flags

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

Final names should be aligned with existing config conventions before implementation.

### Implementation Tasks

- Add config reader for runtime host flags.
- Add docs for fallback command per boundary.
- Make package scripts use Rust only when the relevant flag is enabled.
- Keep direct TS scripts available.
- Add rollback section to public operations docs.

### Verification

For each boundary:

```bash
# Rust path
CONTEXT_STILL_DAEMON_MANAGED_<BOUNDARY>=1 bun run <boundary script>

# Rollback path
CONTEXT_STILL_DAEMON_MANAGED_<BOUNDARY>=0 bun run <boundary script>
```

Required result:

- Both paths pass their smoke.
- Current default remains TypeScript until the boundary-specific smoke is green in CI.

### Done

- A boundary can switch default to Rust and back without code changes.

## Phase 8: Per-Boundary Default Switch

### Goal

Switch one boundary at a time after smoke evidence exists.

### Switch Order

1. Agent log sync one-shot wrapper.
2. Admin API lifecycle.
3. MCP foreground proxy.
4. Queue supervisor.
5. Backup preflight guard.

Queue is intentionally later because it mutates durable work queues.

### Required Evidence Per Switch

Each default switch PR must include:

- Changed package script/config.
- Rust smoke output.
- TypeScript fallback smoke output.
- Rollback command.
- Docs update.
- No unrelated product logic migration.

### Verification

Minimum:

```bash
bun run verify
bun run verify:rust-daemon
```

Plus boundary focused gate:

- MCP: `bun run mcp:smoke:sqlite` and `bun run mcp:smoke:sqlite:rust`
- Queue: `bun run verify:queue:smoke` and `bun run rust:queue:smoke`
- Admin API: `bun run test:unit:api` and `bun run rust:admin-api:smoke`
- Agent log sync: Rust run-and-wait unit/integration smoke
- Backup: `bun run verify:sqlite`

## First Implementation Slice

Start here:

1. Add lifecycle state reconciliation and exit metadata.
2. Add `context-stilld mcp serve`.
3. Add `mcp:smoke:sqlite:rust`.
4. Wire `verify:rust-daemon` to include the Rust MCP smoke only after it is deterministic.

This slice resolves the main current blocker: Rust-managed MCP cannot be proven while the only Rust mode is background stdio child start with stdout/stderr redirected to logs.

## Stop Conditions

Stop and ask for review if:

- A task requires deleting a TypeScript fallback.
- A task requires changing MCP tool schemas or tool names.
- A task requires changing queue job completion semantics.
- A task requires destructive backup restore behavior.
- A task requires global Rust default switch.
- A smoke would need to run against a non-test DB.

## Tracking Table

| ID | Task | Depends on | Gate | Status |
|---|---|---|---|---|
| RR-01 | Process state reconciliation | current lifecycle wrapper | `cargo test`, `verify:rust-daemon` | not started |
| RR-02 | MCP foreground proxy | RR-01 | `mcp:smoke:sqlite:rust` | not started |
| RR-03 | Rust-managed MCP smoke | RR-02 | `verify:rust-daemon` includes smoke | blocked by RR-02 |
| RR-04 | Rust-managed queue smoke | RR-01 | `rust:queue:smoke` | not started |
| RR-05 | Agent log sync run-and-wait | RR-01 | unit tests + `verify:rust-daemon` | not started |
| RR-06 | Admin API readiness smoke | RR-01 | `rust:admin-api:smoke` | not started |
| RR-07 | Backup idle guard | RR-01 | `verify:sqlite`, `verify:rust-daemon` | not started |
| RR-08 | Default switch flags | RR-02 through RR-07 | boundary smoke pairs | not started |
| RR-09 | Per-boundary default switch | RR-08 | focused gate per boundary | blocked by RR-08 |
