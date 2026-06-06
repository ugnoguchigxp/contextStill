# CLI Reference

Run commands from the repository root.

## Setup and Health

| Command | Description |
|---|---|
| `bun run startup` | Interactive dry-run startup and health plan |
| `bun run startup -- --apply` | Apply startup changes after review |
| `bun run init:project -- --json` | Initialize project state and print next actions |
| `bun run doctor` | Full health report |
| `bun run db:migrate` | Apply database migrations |
| `bun run db:seed` | Upsert seed knowledge |
| `bun run db:seed:export` | Export knowledge seed data |

## Compile and Knowledge

| Command | Description |
|---|---|
| `bun run compile --goal "<goal>"` | Compile task-specific context |
| `bun run eval:context` | Run deterministic context evaluation tooling |
| `bun run import:wiki <path>` | Import Markdown source tree |
| `bun run import:markdown <file>` | Import one Markdown file |
| `bun run backfill:knowledge-project-context` | Backfill project context metadata |
| `bun run backfill:knowledge-value` | Backfill value metrics |
| `bun run backfill:knowledge-source-links` | Backfill source evidence links |
| `bun run backfill:knowledge-origin-links` | Backfill origin trace links |
| `bun run knowledge:apply-feedback-quality` | Apply feedback-derived quality adjustments |

## Distillation Queue

| Command | Description |
|---|---|
| `bun run queue:finding:once` | Run one finding-candidate cycle |
| `bun run queue:covering:once` | Run one evidence-coverage cycle |
| `bun run queue:merge-review:once` | Run one DeadZone merge-review cycle |
| `bun run queue:finalize:once` | Run one finalization cycle |
| `bun run queue:supervisor` | Run the queue supervisor continuously |
| `bun run queue:migrate:dry-run` | Preview queue migration mapping |
| `bun run queue:migrate:write` | Write queue migration mapping rows |
| `bun run distill:reprocess-rejected` | Reprocess rejected candidates where eligible |

## Agent Logs and Automation

| Command | Description |
|---|---|
| `bun run sync:agent-logs` | One-time Codex / Antigravity / Claude log sync |
| `bun run automation:agent-log-sync -- install` | Install macOS LaunchAgent for log sync |
| `bun run automation:agent-log-sync -- load` | Load the log sync LaunchAgent |
| `bun run automation:agent-log-sync -- status` | Inspect log sync LaunchAgent state |
| `bun run automation:queue-supervisor -- install` | Install queue supervisor LaunchAgent |
| `bun run automation:queue-supervisor -- load` | Load queue supervisor LaunchAgent |
| `bun run automation:queue-supervisor -- status` | Inspect queue supervisor state |

## Landscape

| Command | Description |
|---|---|
| `bun run landscape -- --window-days 30` | Generate a landscape snapshot |
| `bun run landscape -- --window-days 30 --json` | Emit full snapshot JSON |
| `bun run landscape -- --queue --queue-source replay_compare,landscape_snapshot` | Materialize review items |
| `bun run landscape -- --queue-list --queue-status pending` | List review items |
| `bun run landscape -- --queue-create-candidates --queue-status pending` | Create candidate drafts from review items |

## Development and Verification

| Command | Description |
|---|---|
| `bun run dev` | Start Vite dev server with API |
| `bun run start:api` | Start API server |
| `bun run start:mcp` | Start MCP server |
| `bun run typecheck` | TypeScript check |
| `bun run lint` | Biome lint |
| `bun run format:check` | Biome format check |
| `bun run test:unit` | Unit tests |
| `bun run test:integration` | Destructive integration tests against a test DB |
| `bun run verify` | Main quality gate |
| `bun run verify:mcp` | MCP-specific verification |

## Examples

```bash
bun run compile --goal "fix context compiler ranking" \
  --change-types bugfix,backend \
  --technologies bun,typescript \
  --domains context-compiler \
  --json
```

```bash
bun run landscape -- --queue-create-candidates --queue-status pending --queue-limit 20
bun run queue:covering:once
```
