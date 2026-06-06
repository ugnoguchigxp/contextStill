# Getting Started

## Requirements

- Bun 1.3+
- Docker for PostgreSQL + pgvector
- Optional local LLM endpoint for distillation
- Optional embedding daemon or CLI embedding service

## Install

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
```

## Interactive Startup

The startup command validates configuration, prepares the database, checks provider health, runs a smoke compile, and prints the next actions.

```bash
bun run startup
```

It runs in dry-run mode by default. Apply after reviewing the plan:

```bash
bun run startup -- --apply
```

## Manual Startup

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
bun run init:project -- --json
```

Run diagnostics:

```bash
bun run doctor
```

Run a first compile:

```bash
bun run compile --goal "understand this repository's development workflow" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

## Start Services

Admin UI + API:

```bash
bun run dev
```

MCP server:

```bash
bun run start:mcp
```

One-time agent log sync:

```bash
bun run sync:agent-logs
```

One queue cycle:

```bash
bun run queue:finding:once
bun run queue:covering:once
bun run queue:merge-review:once
bun run queue:finalize:once
```

## First Review Loop

1. Open the admin UI at http://localhost:5173.
2. Check **Doctor** for DB, embedding, provider, sync, and queue status.
3. Use **Sources** to import or edit source pages.
4. Use **Queue** to inspect distillation target state.
5. Use **Knowledge** to review draft knowledge and promote useful items.
6. Use MCP `context_compile` for task context and `compile_eval` after the task.
