<p align="center">
  <strong>context-still</strong><br/>
  <em>Local-first adaptive knowledge compiler for coding agents</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="README.jp.md">日本語</a>
</p>

---

## What is context-still?

context-still is a local-first adaptive knowledge compiler for coding agents. It turns working evidence from wiki/docs, web pages, agent logs, and explicit candidate notes into reusable `rule` / `procedure` knowledge, then compiles task-specific context packs through MCP, CLI, API, and an admin UI.

It is designed for teams and individuals who want an auditable loop:

```text
collect evidence -> distill knowledge -> compile task context -> evaluate usefulness -> register new lessons
```

Core capabilities:

- Evidence-backed knowledge distillation with source links and candidate review.
- MCP tools for `initial_instructions`, `context_compile`, `compile_eval`, knowledge search, memory search, and candidate registration.
- Local PostgreSQL/pgvector storage with a React admin UI.
- Agent log sync for Codex, Antigravity, and Claude logs.
- Queue-based distillation workers and health diagnostics.
- Knowledge Landscape diagnostics for graph, replay, review items, and approval-gated candidates.

context-still is local-first infrastructure, not a hosted SaaS. You run the database, API, MCP server, automation workers, and admin UI in your environment.

## Quick Start

Prerequisites:

- [Bun](https://bun.sh/) 1.3+
- [Docker](https://www.docker.com/) for PostgreSQL + pgvector
- Optional local LLM and embedding services

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
bun run startup
```

The startup command runs in dry-run mode by default. Apply the generated plan after reviewing it:

```bash
bun run startup -- --apply
```

Manual setup is also available:

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
bun run init:project -- --json
```

Run a first health check and compile:

```bash
bun run doctor
bun run compile --goal "understand this repository's development workflow" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

Start the local admin UI and API:

```bash
bun run dev
```

- UI: http://localhost:5173
- API: same origin under `/api/*`

Start only the MCP server:

```bash
bun run start:mcp
```

## Documentation

Public user and operator documentation lives under `spec/pub/`.

| Document | Purpose |
|---|---|
| [Documentation Index](spec/pub/README.md) | Public documentation map |
| [Getting Started](spec/pub/getting-started.md) | Installation, startup, and first compile |
| [Architecture Overview](spec/pub/architecture.md) | Main concepts and runtime components |
| [MCP Tools](spec/pub/mcp-tools.md) | Detailed MCP tool contract and workflow |
| [CLI Reference](spec/pub/cli.md) | Supported commands and examples |
| [REST API Reference](spec/pub/api.md) | HTTP API endpoint inventory |
| [Configuration](spec/pub/configuration.md) | Environment variables and local services |
| [Operations](spec/pub/operations.md) | Automation, queue workers, backups, and diagnostics |

Internal implementation plans and design notes live under `spec/docs/`.

## Project Structure

```text
src/          TypeScript runtime, CLI, MCP server, domain modules
api/          Hono REST API
web/          React admin UI
drizzle/      Database migrations
scripts/      Automation and maintenance scripts
github-pages/ Landing page source and generated Pages artifact
spec/pub/     Public documentation
spec/docs/    Internal implementation and design documents
test/         Unit and integration tests
e2e/          Playwright end-to-end tests
```

## Development

Run the main verification gate before opening a pull request:

```bash
bun run verify
```

Useful focused commands:

```bash
bun run typecheck
bun run test:unit
bun run build:web
bun run verify:mcp
```

Integration tests are destructive and must use a dedicated test database whose name includes `test`.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and review [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SUPPORT.md](SUPPORT.md) before filing issues or pull requests.

## License

[MIT](LICENSE)
