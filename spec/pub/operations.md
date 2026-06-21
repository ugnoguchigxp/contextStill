# Operations

## Health Checks

Desktop/local diagnostics:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run doctor
```

Doctor reports:

- desktop readiness summary
- SQLite DB reachability and required tables
- optional embedding and LLM availability
- MCP tool surface
- compile and decision health
- agent log sync
- queue automation and distillation freshness

PostgreSQL / pgvector diagnostics are advanced server backend checks. They should not appear as missing default desktop infrastructure when SQLite is selected.

## Desktop Doctor States

Doctor uses user-action language for desktop readiness:

| State | Meaning |
|---|---|
| `Ready` | The item is usable for the selected path |
| `Needs setup` | The default desktop path needs user action before it can work |
| `Optional improvement` | The app can run, but quality or automation can improve |
| `Advanced server backend only` | The item applies only when the server backend is selected |

Expected desktop behavior:

- SQLite DB missing or migration needed: `Needs setup`
- embedding unavailable: `Optional improvement`
- MCP not registered: `Optional improvement`
- PostgreSQL / pgvector not present in SQLite mode: `Advanced server backend only`, not a default remediation

## Backups

SQLite backup is the default desktop backup path:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run sqlite:backup
```

It writes a consistent `VACUUM INTO` snapshot after `PRAGMA integrity_check`.

Inputs:

- source: `CONTEXT_STILL_SQLITE_CORE_PATH`, `SQLITE_CORE_PATH`, `DB_SQLITE_PATH`, or the default `data/context-still-core.sqlite`
- output: `backup/<sqlite-name>-<timestamp>.sqlite` by default

Override output:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run sqlite:backup -- --output backup/context-still.sqlite
```

Restore SQLite backups by stopping writers, replacing the configured SQLite DB file with the backup file, and restarting the app. If copying over a live WAL-mode database manually, remove stale sidecar files (`.sqlite-wal` / `.sqlite-shm`) with the old database after writers are stopped.

The legacy `./scripts/backup-db.sh` script follows the configured backend. In SQLite mode it delegates to the same SQLite backup behavior; in PostgreSQL mode it keeps the Docker/pg_dump flow.

## Agent Log Sync

One-time sync:

```bash
bun run sync:agent-logs
```

macOS LaunchAgent:

```bash
bun run automation:agent-log-sync -- install
bun run automation:agent-log-sync -- load
bun run automation:agent-log-sync -- status
```

The LaunchAgent runs periodically. It is normal for status to show `loaded` but `not running` between intervals.

## Queue Supervisor

One-time queue processing:

```bash
bun run queue:finding:once
bun run queue:covering:once
bun run queue:merge-review:once
bun run queue:finalize:once
bun run queue:merge-activation-finalize:once
```

Continuous supervisor:

```bash
bun run automation:queue-supervisor -- install
bun run automation:queue-supervisor -- load
bun run automation:queue-supervisor -- status
```

Queue logs are written under `logs/`. Queue/distillation surfaces are still an area where backend support must be explicit; keep server-only assumptions out of the default desktop path.

## Candidate Registration Hooks

Install local Git hooks:

```bash
./scripts/setup-candidate-registration-hook.sh install
```

Common commands:

```bash
./scripts/setup-candidate-registration-hook.sh status
./scripts/setup-candidate-registration-hook.sh uninstall
./scripts/setup-candidate-registration-hook.sh install-global
./scripts/setup-candidate-registration-hook.sh status-global
```

The hooks remind agents to run `compile_eval` after tasks that used `context_compile` and to register durable candidates after commits.

## Context Decision Feedback

Context Decision records can learn from linked PR outcomes when the decision metadata includes a PR URL, PR number, or branch and GitHub CLI can confirm the PR state.

Preview first:

```bash
bun run decision:pr-discard-scan -- --dry-run
```

Apply only after reviewing the planned feedback:

```bash
bun run decision:pr-discard-scan -- --apply
```

The scan writes `discarded_pr` system feedback only for strongly linked PRs confirmed as closed. If `gh` is unavailable or the PR state is ambiguous, it skips writes and reports a degraded scan.

## Advanced Server Backend Operations

Use this path only when explicitly operating PostgreSQL / pgvector compatibility or future server-style deployments:

```bash
docker compose up -d
bun run db:migrate
bun run verify:postgres
```

PostgreSQL backup defaults for `./scripts/backup-db.sh`:

- container: `context-still-db`
- legacy fallback container: `memory-router-db`
- database: `context_still`
- output: `backup/db_backup_<timestamp>.zip`

Override with `BACKUP_DIR`, `CONTAINER_NAME`, `DB_USER`, `DB_NAME`, or `DB_PASSWORD`.

Server backend constraints:

- keep compatibility tests explicit
- avoid N+1 query patterns before remote DB use
- account for remote DB latency
- do not present server-only requirements as desktop onboarding failures
- document backup/restore separately from SQLite
- treat multi-user/auth as not yet productized

## Knowledge Import/Export Trial

Run a PostgreSQL roundtrip rehearsal against a separate target database only when testing the advanced server backend:

```bash
RUN_FULL_BACKUP=1 bun run knowledge:roundtrip:trial
```

The trial exports from `SOURCE_DATABASE_URL`, creates and migrates `TARGET_DATABASE_NAME`, runs import dry-run, applies `--mode insert-only`, verifies duplicate import rollback, writes a report under `exports/`, and drops the target DB by default.

Useful overrides:

- `SOURCE_DATABASE_URL`: source database. Defaults to `postgres://postgres:postgres@localhost:7889/context_still`.
- `TARGET_DATABASE_NAME`: temporary target database. Defaults to `context_still_import_roundtrip`.
- `TARGET_DATABASE_URL`: full target URL. Defaults to the local 7889 PostgreSQL with `TARGET_DATABASE_NAME`.
- `KEEP_TARGET_DB=1`: keep the target DB after the trial for manual inspection.
- `ALLOW_DROP_TARGET=1`: if the target DB already exists, drop and recreate it.
- `RUN_FULL_BACKUP=1`: run `./scripts/backup-db.sh` before export.

## Verification Gates

General development:

```bash
bun run verify
```

SQLite local backend:

```bash
bun run verify:sqlite
```

Desktop readiness preflight:

```bash
bun run verify:desktop-readiness
```

Docs link validation:

```bash
bun run docs:check-links
```

## Troubleshooting

| Symptom | First checks |
|---|---|
| `context_compile` returns `No Content` | Run `doctor`, check active knowledge count, source import state, and tags |
| Desktop doctor says `Needs setup` | Check SQLite backend selection, SQLite path, and missing required tables |
| Queue not moving | Check `bun run automation:queue-supervisor -- status`, `logs/queue-supervisor.log`, and queue stats |
| Agent logs stale | Run `bun run automation:agent-log-sync -- run-once` and inspect `logs/agent-log-sync.log` |
| Decision output is degraded | Inspect the Decision detail evidence/coverage tabs, then broaden `retrievalHints` or add missing Knowledge |
| PR discard feedback is missing | Run `bun run decision:pr-discard-scan -- --dry-run` and confirm `gh pr view` can resolve the linked PR |
| Embedding failures | Check daemon URL, CLI fallback paths, and `CONTEXT_STILL_EMBEDDING_DIMENSION` |
| API returns unauthorized | Check `CONTEXT_STILL_ADMIN_API_KEY` and client header configuration |
| Integration tests hit live DB | Stop immediately and set a `DATABASE_URL` whose database name includes `test` |

## Rust Daemon Boundary Checks

Use these when validating the in-progress Rust lifecycle host. They are additive checks; TypeScript commands remain the fallback until a boundary-specific smoke passes.

```bash
bun run verify:rust-daemon
cargo run -q -p context-stilld -- bootstrap preflight --json
cargo run -q -p context-stilld -- doctor summary --json
cargo run -q -p context-stilld -- backup preflight --json
```

For lifecycle experiments, set `CONTEXT_STILL_APP_DATA_DIR` to a temporary directory and stop the process through the matching Rust command before removing that directory.
