# Operations

## Health Checks

Run:

```bash
bun run doctor
```

Doctor checks database reachability, pgvector, embedding, LLM providers, expected tables, compile run health, agent log sync, queue automation, and distillation freshness.

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

## Troubleshooting

| Symptom | First checks |
|---|---|
| `context_compile` returns `No Content` | Run `doctor`, check active knowledge count, source import state, and tags |
| Queue not moving | Check `bun run automation:queue-supervisor -- status`, `logs/queue-supervisor.log`, and queue stats |
| Agent logs stale | Run `bun run automation:agent-log-sync -- run-once` and inspect `logs/agent-log-sync.log` |
| Embedding failures | Check daemon URL, CLI fallback paths, and `CONTEXT_STILL_EMBEDDING_DIMENSION` |
| API returns unauthorized | Check `CONTEXT_STILL_ADMIN_API_KEY` and client header configuration |
| Integration tests hit live DB | Stop immediately and set a `DATABASE_URL` whose database name includes `test` |
