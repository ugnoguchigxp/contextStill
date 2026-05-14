# memory-router

Local-first context compiler for coding agents.

`memory-router` compiles a minimal context pack from knowledge, evidence, and code index before an agent acts.

## Current Scope

- PostgreSQL + pgvector storage
- Domain schema with Drizzle + Zod
- Context compiler (`context_compile`) with retrieval modes
- Hono API (integrated with Vite dev server)
- React UI with TanStack Query / Router / Table and React Hook Form
- CLI tools:
  - compile
  - import-markdown
  - doctor
- MCP server:
  - tool: `context_compile`
  - resources: summary / runs / latest pack / doctor health

## Requirements

- Bun 1.3+
- Docker (for local PostgreSQL/pgvector)

## Quick Start

1. Start database container:

```bash
docker compose up -d
```

2. Copy env file:

```bash
cp .env.example .env
```

3. Run migration:

```bash
bun run db:migrate
```

4. Verify baseline:

```bash
bun run verify
```

5. Start integrated frontend + backend dev server (single command):

```bash
bun run dev
```

Open [http://localhost:5173](http://localhost:5173).  
API is available under `/api/*` on the same origin (for example `/api/health`).

## CLI Usage

Compile context pack as JSON:

```bash
bun run compile --goal "fix context compiler" --intent edit --json
```

Main options:

- `--retrieval-mode task_context|review_context|debug_context|architecture_context|skill_context|learning_context`
- `--repo-path /abs/path`
- `--file path/to/file.ts` (repeatable)
- `--files a.ts,b.ts`
- `--change-type backend` / `--change-types backend,api`
- `--technology bun` / `--technologies bun,typescript`
- `--token-budget 3000`
- `--include-trial true|false`
- `--query-embedding "[0.1,0.2,...]"` or `--query-embedding 0.1,0.2,...`

Import markdown knowledge/evidence:

```bash
bun run import:markdown ./docs
```

Run doctor report:

```bash
bun run doctor
```

## MCP Server

Start MCP stdio server:

```bash
bun run start:mcp
```

Start standalone HTTP API server:

```bash
bun run start:api
```

## Testing

- Unit tests:

```bash
bun run test:unit
```

- Integration tests (DB required):

```bash
bun run test:integration
```

- Full:

```bash
bun run test:all
```

- UI unit tests (Vitest):

```bash
bun run test:ui
```

- E2E tests (Playwright):

```bash
bun run test:e2e
```

## Docs

- Directional plan: `plan.md`
- Implementation baseline: `docs/initial-implementation-plan.md`
