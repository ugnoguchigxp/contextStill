# Getting Started

## Default Path

The default path is desktop/local:

- SQLite local backend
- local admin/control-plane runtime
- resident `context-stilld run` ownership for daemon-side lifecycle work, with classified TypeScript sidecars during the Rust migration
- streamable HTTP MCP registration as an optional user action
- local-only minimal usage before LLM-assisted modes

The Tauri shell is the desktop packaging target. Until that shell exists, use the local Bun/admin runtime plus `context-stilld` lifecycle checks as the development baseline for the same product path.

## Requirements

- Bun 1.3+
- Optional local LLM endpoint for assisted review/distillation
- Optional embedding daemon or CLI embedding service

Docker is only needed for the advanced server backend.

## Install

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
```

## Desktop Quick Start

Run diagnostics:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run doctor
```

Run a first compile:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run compile --goal "understand this repository's development workflow" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

Start the admin UI + API:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run dev
```

- UI: http://localhost:39171
- API: same origin under `/api/*`

The interactive `startup` command currently follows the advanced server setup path. Use the explicit SQLite commands above for desktop/local development.

## Product Modes

| Mode | What works | Setup |
|---|---|---|
| `minimal` | SQLite storage, local sources, manual/MCP candidates, search, compile, eval | Bun + SQLite backend |
| `cloud-review` | Cloud LLM assisted distillation/review/decision support | Provider credentials and route settings |
| `local-llm` | Local LLM and embedding assisted distillation/search | Local endpoint and/or embedding service |

Minimal mode should not require external LLMs, external search APIs, or MCP registration.

## MCP Integration

Start the daemon-owned local MCP endpoint worker:

```bash
bun run start:mcp
```

Register it in an MCP client only when you want agent integration:

```json
{
  "mcpServers": {
    "context-still": {
      "url": "http://127.0.0.1:39172/mcp",
      "enabled": true
    }
  }
}
```

Run `bun run setup:mcp-config` to update Codex and Antigravity config files. The direct stdio server is legacy only and should not be registered in new clients.

The endpoint is owned by `context-stilld` as a Rust HTTP/session surface. Non-migrated tool handlers may still run through short-lived one-shot dispatch while R3/R4 continue.

After connection, call `initial_instructions` once per project session, `context_compile` before task work, `context_decision` before a blocking question/PR decision when autonomous progress may still be possible, and `compile_eval` after the task.

## First Review Loop

1. Open the admin UI at http://localhost:39171.
2. Check **Doctor** for desktop readiness, DB state, optional embedding/LLM state, sync, and queue status.
3. Use **Sources** to import or edit source pages.
4. Use **Knowledge** to review draft knowledge and promote useful items.
5. Use **Decision** to inspect Knowledge-backed autonomous decisions, evidence, coverage traces, and feedback.
6. Use MCP tools when you want the agent workflow connected to the local knowledge base.

## Resident Daemon Preview

Install the resident daemon LaunchAgent on macOS when you want long-lived local ownership for MCP endpoint supervision, queue worker supervision, scheduled agent-log-sync, and runtime status:

```bash
bun run automation:context-stilld -- install
bun run automation:context-stilld -- load
bun run automation:context-stilld -- status
cargo run -q -p context-stilld -- runtime sidecars --json
```

The Rust daemon owns the resident process boundary, but several durable surfaces still run as TypeScript/Bun sidecars. Treat `runtime sidecars --json` and `bun run verify:rust-daemon` as the current truth for migration status.

## Advanced Server Backend

PostgreSQL / pgvector is legacy compatibility code. It is not maintained as a completion gate for the desktop/local path; use it only for explicit compatibility investigation.

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
```

This path is advanced and opt-in. It is not required for desktop onboarding.
