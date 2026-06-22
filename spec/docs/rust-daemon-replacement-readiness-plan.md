# Rust Daemon Replacement And Rust-Native Migration Plan

## Purpose

`context-stilld` を daemon 常駐領域の実所有者に戻し、その上で queue / MCP / agent-log-sync / doctor / backup guard などの resident runtime を段階的に Rust-native 実装へ移行するための実装計画である。

この計画は 2 段階を明確に分ける。

1. Ownership migration:
   `context-stilld` が process ownership、pid/state/log、shutdown、readiness、smoke、rollback を持つ。TypeScript/Bun は短期的に Rust-managed sidecar として残せる。
2. Rust-native migration:
   daemon 常駐領域から TypeScript sidecar を順に外し、Rust 側に scheduler、MCP session/tool dispatch、agent-log-sync、doctor/backup guard、SQLite writer coordination を移す。

現在の問題は、`context-stilld status --json` が `queueSupervisor: "stopped"` と報告する一方で、実際には macOS LaunchAgent が `bun run src/cli/queue-supervisor-automation.ts run-continuous` を直接起動していることである。これは daemon ownership が分裂しており、再起動、状態確認、stale worker 診断、package runtime 方針のすべてを曖昧にする。

## Target End State

最終形は次の通り。

| Surface | Final owner | Final implementation target | Allowed interim state |
|---|---|---|---|
| Queue supervisor | `context-stilld` resident daemon | Rust scheduler + Rust queue executor where practical | Rust-owned Bun worker sidecar |
| Provider leases / route scheduling | `context-stilld` resident daemon | Rust SQLite scheduler and lease manager | TypeScript queue worker behind Rust ownership |
| MCP endpoint | `context-stilld` resident daemon | Rust streamable HTTP MCP endpoint and session manager | Rust-owned tool worker sidecar |
| MCP tool dispatch | `context-stilld` resident daemon | Rust-native handlers for stable tools; sidecar only for unresolved product logic | Rust-managed local RPC worker |
| Agent log sync | `context-stilld` resident daemon | Rust scanner/parser/sync where feasible | Rust-owned one-shot Bun sidecar |
| Hono admin API | UI-time process, managed by Rust | May remain TS UI-time child | Rust-managed child process |
| Doctor / backup guard | `context-stilld` | Rust checks over runtime state and SQLite | TS fallbacks for product-specific checks |
| Migration/import/export scripts | explicit one-shot tasks | case-by-case Rust parity only when useful | Rust-managed one-shot TS sidecar |

Important boundary:

- TypeScript can remain for UI-time and explicit one-shot product logic.
- TypeScript must not remain the durable owner of queue work, MCP sessions, scheduled sync, or daemon state.
- LaunchAgent should eventually start only the resident `context-stilld`, not separate Bun queue/MCP workers.
- `context-stilld status --json` must describe the real owner and real process state.

## Non-Goals

- Do not rewrite UI or Hono admin API as Rust in this track.
- Do not rewrite every TypeScript CLI. Only daemon resident and durable background surfaces are in scope.
- Do not change MCP tool names or schemas as part of the ownership migration.
- Do not change queue job completion semantics while moving ownership.
- Do not run live queue smoke against a non-test DB.
- Do not keep direct stdio MCP as a default or fallback runtime path.

## Current State

Implemented:

- Rust workspace and `context-stilld` binary.
- `paths`, `status`, `bootstrap preflight/init`, `doctor summary`, `backup preflight`.
- `mcp`, `queue`, `agent-log-sync`, and `admin-api` lifecycle wrappers.
- pid/state/log path management and lifecycle JSON output.
- Rust-managed focused smokes for MCP / queue / admin API / agent-log-sync.
- `agent-log-sync run --wait --json`.
- admin API readiness polling.
- backup preflight active writer guard and `--require-idle`.
- managed boundary flags are observable in `status --json`.
- `verify:rust-daemon`.

Still insufficient:

- Live macOS LaunchAgent ownership still points at Bun queue automation in current runtime.
- There is no resident `context-stilld run` / supervisor mode that owns queue and MCP together.
- Boundary default switches are not completed.
- Rollback runbook is not public and operator-focused enough.
- MCP endpoint is still not fully Rust-native tool execution.
- Queue scheduler / provider lease / worker execution remain TypeScript product logic.
- Agent log sync and richer doctor checks still depend on TypeScript paths.
- Thin runner / one-shot sidecar registry is incomplete.
- The previous readiness framing stopped at "Rust owns lifecycle while TS remains product logic"; this is not enough for the desired Rust daemon migration.

## Migration Principles

1. Ownership before rewrite:
   First make `context-stilld` the only resident owner. Then migrate internals from TS to Rust.

2. One boundary at a time:
   Switch MCP, queue, agent-log-sync, admin API management, and backup guard independently. Queue is late because it mutates durable work.

3. Rust state is the source of runtime truth:
   pid, state JSON, logs, readiness, active sessions, leases, and writer guards must be observable through `context-stilld`.

4. TS sidecars are temporary and classified:
   Each sidecar must be `ui-bound`, `one-shot`, or `resident-owned-temporary`. Resident-owned-temporary sidecars must have a Rust parity task.

5. No hidden product rewrite:
   Any Rust replacement must have parity tests or an explicit behavior contract before becoming default.

6. Rollback stays real:
   Each boundary must retain a documented TypeScript fallback until Rust-native parity is proven and accepted.

## Architecture Target

```text
macOS LaunchAgent / packaged app service
  -> context-stilld run
      -> resident supervisor
      -> queue runtime
          -> Rust scheduler / lease manager
          -> Rust executor or managed TS worker during migration
      -> MCP endpoint
          -> Rust session manager
          -> Rust-native handlers or managed tool worker during migration
      -> agent-log-sync runtime
      -> doctor / backup guard
      -> UI-time Hono child only when UI is open
```

`context-stilld run` is the missing resident mode. `start|stop|status` lifecycle commands are useful, but they are not enough if LaunchAgent still owns a Bun child directly or if each surface is started independently outside one resident daemon.

## Implementation Phases

### Phase 0: Freeze Current Runtime Truth

Goal:
Document current ownership mismatch and prevent further work from relying on misleading `status` output.

Tasks:

- Record the live LaunchAgent labels and commands:
  - `com.context-still.queue-supervisor`
  - any MCP-related LaunchAgent or client config.
- Record `context-stilld status --json` output.
- Record actual process list for `context-stilld`, `queue-supervisor`, MCP endpoint, and Bun workers.
- Add an operations note that `context-stilld status` is not authoritative for LaunchAgent-owned Bun workers until Phase 2 is complete.

Verification:

```bash
launchctl print gui/$(id -u)/com.context-still.queue-supervisor
ps aux | rg 'context-stilld|queue-supervisor|mcp'
cargo run -q -p context-stilld -- status --json
```

Expected result:

- The mismatch is visible and documented.
- No runtime ownership change has been made yet.

Failure handling:

- If process ownership cannot be determined, stop the migration and add a diagnostic task before changing launch configuration.

### Phase 1: Resident Supervisor Mode

Goal:
Add a long-running `context-stilld run` mode that owns child lifecycle for daemon resident surfaces.

Tasks:

- Add CLI command:

```bash
context-stilld run --json
```

- The run mode should:
  - create app data, run, log, backup directories;
  - load runtime config;
  - start enabled resident surfaces;
  - supervise child exits;
  - handle SIGINT/SIGTERM;
  - write a daemon state file;
  - stop children gracefully on shutdown;
  - never make UI-time Hono resident by default.
- Add a resident surface registry:
  - MCP endpoint;
  - queue supervisor;
  - agent-log-sync scheduled worker when enabled;
  - doctor/backup guard state is internal, not a child.
- Add tests using `MockSupervisor`.

Verification:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
bun run verify:rust-daemon
```

Expected result:

- Unit tests prove `run` starts configured resident surfaces.
- SIGTERM records shutdown state and stops managed children.
- `status --json` reflects resident daemon state.

Failure handling:

- If child supervision cannot stop a surface reliably, do not switch LaunchAgent. Keep Phase 1 local-only until stop semantics are fixed.

### Phase 2: LaunchAgent Ownership Switch

Goal:
Move macOS LaunchAgent ownership from direct Bun queue/MCP workers to `context-stilld run`.

Tasks:

- Add a new LaunchAgent template for `context-stilld run`.
- Update automation commands to install/load/unload the `context-stilld` LaunchAgent.
- Deprecate `queue-supervisor-automation.ts install/load/unload` as a resident startup path.
- Keep direct Bun queue command as manual fallback only.
- Add rollback:
  - unload `context-stilld` LaunchAgent;
  - restore old queue LaunchAgent only if explicitly requested.
- Ensure LaunchAgent env sets:
  - `CONTEXT_STILL_DB_BACKEND=sqlite`;
  - app data path;
  - SQLite core path;
  - project root;
  - PATH.

Verification:

```bash
bun run automation:context-stilld -- install
bun run automation:context-stilld -- load
launchctl print gui/$(id -u)/com.context-still.daemon
cargo run -q -p context-stilld -- status --json
ps aux | rg 'context-stilld|queue-supervisor'
```

Expected result:

- LaunchAgent owns `context-stilld`, not `queue-supervisor-automation.ts`.
- Queue process, if still TypeScript, is a child managed by `context-stilld`.
- `status --json` and process tree agree.

Failure handling:

- If `context-stilld run` exits repeatedly, unload the new LaunchAgent and do not leave both old and new queue owners active.

### Phase 3: MCP Ownership And Rust Endpoint

Goal:
Make MCP availability daemon-owned and remove direct stdio process ownership from normal runtime.

Tasks:

- Keep local streamable HTTP MCP endpoint under `context-stilld`.
- Store endpoint metadata under app data.
- Track sessions:
  - session id;
  - client metadata;
  - created/last activity;
  - in-flight count;
  - close reason.
- Add or keep:

```bash
context-stilld mcp endpoint --json
context-stilld mcp sessions --json
context-stilld mcp smoke --json
```

- Change registration docs/config to daemon URL, not command-based stdio.
- Add diagnostics for stale command-based configs.
- Keep TypeScript tool logic only behind a daemon-owned bridge until parity migration.

Verification:

```bash
cargo run -q -p context-stilld -- mcp endpoint --json
cargo run -q -p context-stilld -- mcp smoke --json
cargo run -q -p context-stilld -- mcp sessions --json
pgrep -af 'bun run src/index.ts' || true
```

Expected result:

- MCP client use does not spawn direct stdio Bun servers.
- Sessions are visible from daemon state.
- Tool inventory is reachable through daemon endpoint.

Failure handling:

- If a client cannot use streamable HTTP MCP, document it as unsupported for the daemon-owned default path. Do not restore stdio as mainline.

### Phase 4: Queue Ownership Under Rust

Goal:
Make queue runtime daemon-owned while preserving current TypeScript queue semantics.

Tasks:

- Run existing queue worker as Rust-managed child initially.
- Ensure `context-stilld` owns:
  - queue worker pid/state/log;
  - shutdown;
  - stale process reconciliation;
  - smoke;
  - active writer guard.
- Ensure no LaunchAgent starts queue worker directly.
- Add a live-safe status view:
  - queue state counts;
  - active provider leases;
  - active target ids;
  - worker pid;
  - last heartbeat.
- Keep current TypeScript queue worker as fallback until Rust-native queue parity is ready.

Verification:

```bash
bun run verify:queue:smoke
bun run rust:queue:smoke
cargo run -q -p context-stilld -- queue status --json
sqlite3 data/context-still-core.sqlite "select status, count(*) from llm_provider_leases group by status;"
```

Expected result:

- Rust-managed queue smoke passes on a smoke DB.
- Live status identifies the Rust-owned queue worker.
- No direct LaunchAgent queue worker remains.

Failure handling:

- If queue worker processes jobs but state/log ownership is not visible through Rust, do not mark ownership migration complete.

### Phase 5: Rust-Native Queue Scheduler And Lease Manager

Goal:
Move queue scheduling and provider lease ownership from TypeScript into Rust.

Scope:

- SQLite queue polling.
- Priority ordering.
- Queue pause controls.
- Provider pool capacity.
- Target-specific leases.
- Stale lease recovery.
- Heartbeat updates.
- Safe claim transaction.

Tasks:

- Port scheduler/lease contracts from current TypeScript implementation.
- Preserve route-target granularity:
  - same route / same target waits;
  - different route / different free target can run concurrently.
- Add Rust tests for:
  - atomic claim;
  - active target uniqueness;
  - stale lease recovery;
  - queue pause;
  - route-target concurrency;
  - no claim when preferred target is busy.
- Keep TypeScript worker execution behind a Rust claim API until executor parity is ready.

Verification:

```bash
cargo test --workspace queue
bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts
bun run rust:queue:smoke
```

Expected result:

- Rust scheduler produces the same claim/lease behavior as TypeScript.
- Existing TypeScript SQLite runtime tests remain green.

Failure handling:

- Any divergence in claim ordering or lease exclusivity blocks default switch for Rust scheduler.

### Phase 6: Rust-Native Queue Executors

Goal:
Move daemon-resident queue execution from TypeScript to Rust where behavior is stable enough.

Migration order:

1. Deterministic queue maintenance and state transitions.
2. Episode distiller source reading and EpisodeCard persistence if schema parity is clear.
3. findCandidate orchestration only after parser/tool contracts are fixed.
4. coverEvidence/finalize only after external search/tooling boundaries are isolated.

Tasks:

- Define per-queue parity contracts.
- Add golden fixtures for each queue input/output.
- Keep LLM provider calls behind a Rust provider abstraction.
- Keep TS fallback per queue until parity is proven.
- Add mixed-mode support:
  - Rust scheduler can dispatch selected queues to Rust executor;
  - unsupported queues go to Rust-owned TS sidecar.

Verification:

```bash
cargo test --workspace
bun test --timeout=30000 --max-concurrency=1 ./test/queue-worker.test.ts ./test/sqlite-runtime-support.bun.ts
bun run verify:sqlite
```

Expected result:

- Each migrated queue has parity fixtures and fallback.
- Queue completion semantics do not change.

Failure handling:

- If queue output differs without an accepted contract change, keep that queue on TS executor.

### Phase 7: Rust-Native MCP Tool Dispatch

Goal:
Move MCP serving and stable tool execution into Rust.

Migration order:

1. Tool registry metadata and schema exposure.
2. Read-only deterministic tools:
   - `doctor`;
   - `paths`;
   - simple status;
   - episode fetch/search if repository parity exists.
3. Write tools with SQLite transaction tests:
   - `compile_eval`;
   - feedback;
   - candidate registration only after applicability and queue propagation parity.
4. LLM-backed tools after provider abstraction and timeout behavior are stable.

Tasks:

- Split tool contracts from TypeScript implementations.
- Add Rust-native handlers for stable tools.
- Keep daemon-owned TS worker for non-migrated tools.
- Track per-tool owner:
  - `rust-native`;
  - `ts-sidecar`;
  - `disabled`.
- Expose owner in `mcp smoke --json` or debug endpoint.

Verification:

```bash
cargo test --workspace mcp
cargo run -q -p context-stilld -- mcp smoke --json
bun run test:mcp:contract
```

Expected result:

- Tool schemas remain compatible.
- Rust-native tools pass the same contract tests.
- TS sidecar use is explicit and shrinking.

Failure handling:

- Tool schema drift blocks migration.
- LLM-backed tools stay TS-sidecar until timeout, provider, and JSON parsing parity are proven.

### Phase 8: Rust-Native Agent Log Sync

Goal:
Move scheduled agent log sync into Rust or make remaining TS parsing explicit one-shot sidecar work.

Tasks:

- Port root discovery and sync state handling.
- Port stable parsers incrementally:
  - Codex;
  - Claude;
  - Antigravity.
- Keep parser fixtures shared or duplicated with golden output.
- Preserve SQLite writes and dedupe behavior.

Verification:

```bash
cargo test --workspace agent_log_sync
bun test --timeout=30000 --max-concurrency=1 ./test/agent-log-sync.test.ts ./test/agent-log-sync-codex-parser.test.ts ./test/agent-log-sync-claude-parser.test.ts ./test/agent-log-sync-antigravity-parser.test.ts
bun run rust:agent-log-sync:smoke
```

Expected result:

- Rust parser output matches TS fixtures for migrated formats.
- Scheduled sync is daemon-owned and continues after UI close.

Failure handling:

- Parser mismatch keeps that parser behind TS sidecar.

### Phase 9: Rust Doctor, Backup Guard, And Runtime State

Goal:
Make daemon safety checks Rust-native enough to operate without UI/Hono/TS runtime.

Tasks:

- Keep path/status/bootstrap checks Rust-native.
- Expand DB/SQLite checks in Rust.
- Keep LLM/provider live checks optional and non-destructive.
- Backup guard must block when any Rust-owned writer is active.
- Add active writer details:
  - boundary;
  - pid;
  - state;
  - log path;
  - last heartbeat.

Verification:

```bash
cargo test --workspace doctor backup
cargo run -q -p context-stilld -- doctor summary --json
cargo run -q -p context-stilld -- backup preflight --require-idle --json
```

Expected result:

- Doctor/backup can run with no Hono API.
- Active queue/MCP/sync writer state is visible.

Failure handling:

- If a check requires TypeScript product logic, mark it `ts-sidecar` and keep it out of resident readiness.

### Phase 10: Boundary Default Switches

Goal:
Switch defaults only after ownership and smoke evidence exist.

Switch order:

1. MCP endpoint ownership.
2. Agent log sync ownership.
3. Queue ownership.
4. Admin API management.
5. Rust-native queue scheduler.
6. Rust-native MCP tool handlers.
7. Queue executors per queue.
8. Agent log parsers per parser.

Required evidence per switch:

- Changed script/config.
- Rust smoke output.
- TypeScript fallback smoke output while fallback exists.
- Rollback command.
- Docs update.
- Task ownership statement.
- No unrelated product behavior migration.

Verification:

```bash
bun run verify
bun run verify:rust-daemon
```

Plus focused gates for the boundary being switched.

Failure handling:

- If rollback is not one command or one config flag, do not switch defaults.

## Stop Conditions

Stop and ask for review if:

- A change would leave both LaunchAgent-owned Bun queue and `context-stilld`-owned queue active.
- `context-stilld status --json` cannot identify the real owner.
- A task requires deleting TypeScript product logic without parity tests.
- A task changes MCP tool names or schemas.
- A task changes queue completion semantics.
- A smoke would run against a live non-test DB.
- A full Hono admin API would become part of resident runtime.
- UI close would kill a non-cancelable DB-writing or long-running task.
- Rust scheduler diverges from TypeScript claim/lease semantics.
- MCP client registration would reintroduce command-based stdio as the default path.

## Verification Matrix

| Area | Command | Expected result |
|---|---|---|
| Rust unit/integration | `cargo test --workspace` | Rust lifecycle and parity tests pass |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | no warnings |
| Repo gate | `bun run verify:rust-daemon` | daemon gate passes |
| Queue TS parity | `bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts` | existing SQLite queue behavior remains green |
| Queue smoke | `bun run rust:queue:smoke` | Rust-owned queue smoke uses test DB only |
| MCP smoke | `cargo run -q -p context-stilld -- mcp smoke --json` | daemon endpoint and tool inventory reachable |
| MCP contracts | `bun run test:mcp:contract` | schemas remain compatible |
| Agent sync | `bun run rust:agent-log-sync:smoke` | Rust-owned sync run records exit state |
| Backup guard | `cargo run -q -p context-stilld -- backup preflight --require-idle --json` | active writers block idle backup |
| Live ownership | `ps aux | rg 'context-stilld|queue-supervisor|mcp'` | resident owner matches `status --json` |

## Tracking Table

| ID | Task | Depends on | Gate | Status |
|---|---|---|---|---|
| RR-00 | Current ownership truth freeze | none | process/status evidence | pending |
| RR-01 | Resident `context-stilld run` supervisor | RR-00 | `cargo test`, `verify:rust-daemon` | pending |
| RR-02 | LaunchAgent switches to `context-stilld run` | RR-01 | launchctl + status/process tree | pending |
| RR-03 | Daemon-owned MCP endpoint default | RR-01 | `mcp smoke --json` | partially implemented; default switch pending |
| RR-04 | Queue owned by Rust supervisor | RR-01, RR-02 | `rust:queue:smoke` | partially implemented; live ownership pending |
| RR-05 | Rust scheduler and provider lease manager | RR-04 | Rust queue parity tests + TS SQLite tests | pending |
| RR-06 | Rust queue executors per queue | RR-05 | per-queue parity fixtures | pending |
| RR-07 | Rust-native MCP tool dispatch | RR-03 | MCP contract + smoke | pending |
| RR-08 | Rust-native agent log sync | RR-01 | parser parity + sync smoke | pending |
| RR-09 | Rust doctor/backup guard expansion | RR-01 | doctor/backup JSON gates | partially implemented |
| RR-10 | Boundary default switches | RR-02 through RR-09 | focused gates + rollback docs | pending |

## First Implementation Slice

Start with ownership, not Rust rewrite:

1. Add `context-stilld run` resident supervisor mode.
2. Make LaunchAgent start `context-stilld run`.
3. Ensure queue and MCP are children or internal services owned by `context-stilld`.
4. Make `status --json` and process tree agree.
5. Keep TypeScript queue/MCP logic as Rust-owned sidecars until Rust parity tasks are ready.

This slice directly fixes the current operational problem: `context-stilld` and LaunchAgent disagree about who owns queue/MCP. It also creates the stable platform needed to migrate the remaining daemon logic to Rust without changing product behavior and runtime ownership at the same time.
