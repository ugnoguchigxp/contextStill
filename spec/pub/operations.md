# Operations

## Health Checks

Run:

```bash
bun run doctor
```

Doctor checks database reachability, pgvector, embedding, LLM providers, expected tables, compile run health, context decision readiness, agent log sync, queue automation, and distillation freshness.

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

Queue logs are written under `logs/`.

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

## Backups

```bash
./scripts/backup-db.sh
```

Defaults:

- container: `context-still-db`
- legacy fallback container: `memory-router-db`
- database: `context_still`
- output: `backup/db_backup_<timestamp>.zip`

Override with `BACKUP_DIR`, `CONTAINER_NAME`, `DB_USER`, `DB_NAME`, or `DB_PASSWORD`.

## Knowledge Import/Export Trial

Run a PostgreSQL roundtrip rehearsal against a separate target database:

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

## Troubleshooting

| Symptom | First checks |
|---|---|
| `context_compile` returns `No Content` | Run `doctor`, check active knowledge count, source import state, and tags |
| Queue not moving | Check `bun run automation:queue-supervisor -- status`, `logs/queue-supervisor.log`, and queue stats |
| Agent logs stale | Run `bun run automation:agent-log-sync -- run-once` and inspect `logs/agent-log-sync.log` |
| Decision output is degraded | Inspect the Decision detail evidence/coverage tabs, then broaden `retrievalHints` or add missing Knowledge |
| PR discard feedback is missing | Run `bun run decision:pr-discard-scan -- --dry-run` and confirm `gh pr view` can resolve the linked PR |
| Embedding failures | Check daemon URL, CLI fallback paths, and `CONTEXT_STILL_EMBEDDING_DIMENSION` |
| API returns unauthorized | Check `CONTEXT_STILL_ADMIN_API_KEY` and client header configuration |
| Integration tests hit live DB | Stop immediately and set a `DATABASE_URL` whose database name includes `test` |
