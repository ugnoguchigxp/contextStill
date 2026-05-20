<p align="center">
  <strong>memory-router</strong><br/>
  <em>Local-first Context Compiler for AI Coding Agents</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/memoryRouter/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/memoryRouter/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#mcp-integration">MCP Integration</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="#api-reference">API</a> ·
  <a href="docs/mcp-tools.md">MCP Tool Contract</a>
</p>

<p align="center">
  <a href="README.jp.md">🇯🇵 日本語版 README</a>
</p>

---

## What is memory-router?

**memory-router** is a local-first knowledge engine that distills your coding sessions, wikis, and documentation into reusable **rules** and **procedures**, then compiles just the right context for your AI coding agent — within any token budget.

```
┌─────────────┐   ┌──────────────┐   ┌──────────────────┐
│  Wiki / Docs │   │ Agent Logs   │   │  Manual Rules    │
│  (Markdown)  │   │ (Codex,      │   │  (register_      │
│              │   │  Antigravity)│   │   knowledge)     │
└──────┬───────┘   └──────┬───────┘   └────────┬─────────┘
       │                  │                    │
       ▼                  ▼                    │
   import:wiki     sync:agent-logs             │
       │                  │                    │
       ▼                  ▼                    │
┌──────────────────────────────┐               │
│  Distillation (Local LLM)    │               │
│  ┌────────┐ ┌─────────────┐  │               │
│  │ Score  │ │ Tool Loop   │  │               │
│  │ Gate   │ │ search_web  │  │               │
│  │ ≥0.75  │ │ fetch_url   │  │               │
│  └────────┘ └─────────────┘  │               │
└──────────────┬───────────────┘               │
               │                               │
               ▼                               ▼
        ┌──────────────────────────────────────────┐
        │         knowledge_items                   │
        │   type: rule | procedure                  │
        │   status: draft → active → deprecated     │
        │   scope: repo | global                    │
        │   + passage embedding (pgvector)          │
        └──────────────────┬───────────────────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │  context_compile    │
                │  Token budget split │
                │  rules:45%          │
                │  procedures:35%     │
                │  sources:20%        │
                └─────────┬───────────┘
                          │
                          ▼
                ┌─────────────────────┐
                │  Context Pack       │
                │  (Markdown output)  │
                │  → Agent prompt     │
                └─────────────────────┘
```

### Key Differentiators

| Feature | memory-router | Naive RAG | CLAUDE.md / Cursor Rules |
|---|---|---|---|
| Knowledge distillation | ✅ LLM + score gate | ❌ Raw search | ❌ Manual |
| Evidence / instruction separation | ✅ Full | ❌ Mixed | ❌ Instruction only |
| External evidence verification | ✅ Tool loop | ❌ | ❌ |
| Repo-scoped knowledge | ✅ DB-level | △ Namespace | ❌ Global only |
| Compile quality tracking | ✅ Degraded reasons + run history | ❌ | ❌ |
| Knowledge lifecycle | ✅ draft/active/deprecated | ❌ | ❌ |
| MCP standard | ✅ Official SDK | ❌ | ❌ |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Docker](https://www.docker.com/) (for PostgreSQL + pgvector)
- A local LLM server for distillation (optional, e.g. [local-llm](https://github.com/user/local-llm) with Gemma4)
- An embedding service (optional, daemon or CLI)

### Setup

```bash
git clone https://github.com/user/memory-router.git
cd memory-router
bun install
docker compose up -d
cp .env.example .env
bun run db:migrate
bun run init:project -- --json
```

`init:project` の出力には次アクション（`compile` / `doctor` / draft review）が含まれます。  
まずは次のコマンドで動作確認できます。

```bash
bun run doctor
bun run compile --goal "このリポジトリの開発フローを把握したい" --intent plan --json
```

### Start Developing

```bash
# Start the dev server (UI + API)
bun run dev
```

- **UI**: http://localhost:5173
- **API**: Same origin at `/api/*`

---

## How It Works

memory-router operates as a three-stage pipeline:

### Stage 1: Collect

Ingest raw evidence from multiple sources:

```bash
# Import Markdown documentation
bun run import:wiki ./wiki/pages

# Sync agent conversation logs (Codex / Antigravity)
bun run sync:agent-logs
```

### Stage 2: Distill

Convert raw evidence into structured **rules** and **procedures** using a local LLM:

```bash
# Run one distillation cycle (wiki-first auto selection)
bun run distill:pipeline:once

# Or target kind explicitly
bun run distill:pipeline -- --write --limit 1 --kind wiki
bun run distill:pipeline -- --write --limit 1 --kind vibe
```

The distillation pipeline:
1. Sends raw evidence to a local LLM (Gemma4 by default)
2. LLM can use `search_web` / `fetch_content` tools to verify external claims
3. Candidates with a score below the threshold (default: 0.75) are rejected
4. Accepted candidates are saved as `draft` knowledge with passage embeddings

### Stage 3: Compile

Generate a token-budgeted context pack tailored to the current task:

```bash
bun run compile --goal "fix the authentication middleware" --intent edit
```

The compiler:
1. Resolves retrieval mode from intent and goal keywords
2. Searches knowledge (hybrid: full-text + vector) scoped to the repository
3. Ranks by weighted score (importance, confidence, source evidence)
4. Allocates token budget across sections (rules → procedures → sources)
5. Returns a structured Markdown context pack with diagnostics

---

## MCP Integration

memory-router exposes an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server for seamless integration with AI coding agents.

### Starting the MCP server

```bash
bun run start:mcp
```

### Configuring your agent

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "memory-router": {
      "command": "bun",
      "args": ["run", "start:mcp"],
      "cwd": "/path/to/memory-router"
    }
  }
}
```

### Available MCP Tools

| Tool | Purpose | Usage |
|---|---|---|
| `initial_instructions` | Operating guidance for the agent | Call once at session start |
| `context_compile` | Generate context pack for current task | **Primary tool** — call before every task |
| `search_knowledge` | Raw knowledge candidate inspection | When `context_compile` results need investigation |
| `register_knowledge` | Register new rules or procedures | When the agent discovers reusable patterns |
| `list_knowledge` | List draft/active/deprecated backlog | When triaging knowledge lifecycle |
| `update_knowledge` | Update status/title/body/metadata | When promoting or deprecating knowledge |
| `memory_search` | Search past conversations and diffs | When looking for specific past context |
| `memory_fetch` | Fetch a specific memory by ID | When inspecting a specific conversation |
| `doctor` | System health diagnostics | When compile is degraded/failed |

### Recommended workflow

```
1. initial_instructions     → Get operating rules
2. context_compile          → Get task-specific context (primary)
3. search_knowledge         → Investigate if needed (supplementary)
4. ... do the work ...
5. register_knowledge       → Save reusable discoveries
6. doctor                   → Check system health if issues arise
```

For the full MCP tool contract, see [docs/mcp-tools.md](docs/mcp-tools.md).

---

## CLI Reference

| Command | Description |
|---|---|
| `bun run init:project` | Run first-time onboarding flow (import, preset, smoke compile) |
| `bun run compile` | Compile a context pack |
| `bun run import:wiki <path>` | Import Markdown into sources |
| `bun run import:markdown <file>` | Import a single Markdown file |
| `bun run sync:agent-logs` | Sync Codex / Antigravity logs |
| `bun run distill:pipeline:once` | Run one wiki-first distillation cycle |
| `bun run distill:status` | Show distillation target queue and progress |
| `bun run doctor` | Run system diagnostics |
| `bun run backfill:knowledge-project-context` | Backfill project context on existing knowledge |

### Cold Start Flow

Use `init:project` on a fresh repository to connect the first-run path end-to-end:

```bash
# import wiki + seed global preset + smoke compile
bun run init:project -- --wiki-root ./wiki/pages

# refresh distillation targets and run one cycle
bun run distill-target:refresh
bun run distill:pipeline:once
```

- Global preset entries are stored as `scope: global`.
- Repo-specific knowledge stays in `scope: repo` through `import:wiki` / `distill:pipeline`.
- If smoke compile returns no relevant items, the command prints concrete next actions.

### Examples

```bash
# Compile with specific intent and JSON output
bun run compile --goal "fix context compiler" --intent edit --json

# Distill one cycle (wiki-first)
bun run distill:pipeline:once

# Distill explicit target kind
bun run distill:pipeline -- --write --limit 1 --kind wiki
bun run distill:pipeline -- --write --limit 1 --kind vibe
```

---

## API Reference

The REST API serves the Web UI and can be used independently.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/context/compile` | Compile a context pack |
| `GET` | `/api/context/runs` | List recent compile runs |
| `GET` | `/api/doctor` | System health report |
| `GET` | `/api/knowledge` | List / search knowledge items |
| `POST` | `/api/knowledge` | Create a knowledge item |
| `PUT` | `/api/knowledge/:id` | Update a knowledge item |
| `DELETE` | `/api/knowledge/:id` | Delete a knowledge item |
| `GET` | `/api/sources/tree` | Wiki source tree |
| `GET/POST` | `/api/sources/folders` | List / create folders |
| `PUT/DELETE` | `/api/sources/folders/:id` | Update / delete a folder |
| `GET/POST` | `/api/sources/pages` | List / create pages |
| `GET/PUT/DELETE` | `/api/sources/pages/:id` | Get / update / delete a page |
| `GET` | `/api/sources/history/:id` | Page Git history |
| `GET` | `/api/sources/diff/:id` | Page diff between commits |
| `GET/POST` | `/api/vibe-memory` | List / create vibe memories |
| `GET/DELETE` | `/api/vibe-memory/:id` | Get / delete a memory |
| `GET` | `/api/agent-diffs` | List agent diff entries |
| `GET` | `/api/graph` | Knowledge graph data |

Start the API server:

```bash
bun run start:api
```

---

## Data Model

memory-router separates **evidence** (raw data) from **instructions** (distilled knowledge):

### Evidence layer

| Table | Description |
|---|---|
| `sources` | Wiki content root. Human-authored Markdown lives here. |
| `source_fragments` | Internal search index for wiki pages. Not a user-facing input. |
| `vibe_memories` | Natural language conversation logs from AI agents. No diff content. |
| `agent_diff_entries` | Code diffs from conversations. Stores `diff_hunk` and extracted symbols. |

### Knowledge layer

| Table | Description |
|---|---|
| `knowledge_items` | Distilled rules and procedures. `type: rule \| procedure`, `status: draft \| active \| deprecated`, `scope: repo \| global`. |
| `knowledge_source_links` | Links knowledge back to its source evidence. |

### Processing layer

| Table | Description |
|---|---|
| `distillation_evidence_cache` | Short-lived cache for external evidence lookup results. |
| `distillation_target_states` | Target selection and lifecycle state for the staged distillation flow. |
| `find_candidate_results` | Minimal candidate rows produced by `findCandidate`. |
| `cover_evidence_results` | Evidence coverage results keyed by `find_candidate_results.id`. |
| `context_compile_runs` | Compile execution history with diagnostics. |
| `context_pack_items` | Items selected for each compile run. |
| `sync_states` | Agent log sync cursors and timestamps. |

---

## Wiki Management

The default content root is `./wiki`. The `wiki/` directory is gitignored from the main repo and operates as an independent Git repository. If no `.git` is present, it is auto-initialized. Page operations automatically commit changes.

```bash
# Override the wiki location
MEMORY_ROUTER_SOURCE_CONTENT_ROOT=/path/to/your/wiki
```

---

## Automation

### Agent Log Sync

Continuously ingest conversation logs from Codex and Antigravity:

```bash
# One-time sync
bun run sync:agent-logs

# Install as macOS LaunchAgent
./scripts/setup-automation.sh install
./scripts/setup-automation.sh load
./scripts/setup-automation.sh status
```

Default log locations:
- Codex: `~/.codex/sessions` and `~/.codex/archived_sessions`
- Antigravity: `~/.gemini/antigravity/brain`

### Distillation Automation (Conveyor)

Run staged distillation (`selectDistillationTarget -> findCandidate -> coverEvidence -> finalizeDistille`) on a schedule:

```bash
# One-time run
bun run distill:pipeline:once

# Install and load as macOS LaunchAgent
./scripts/setup-distill-pipeline-automation.sh install
./scripts/setup-distill-pipeline-automation.sh load
./scripts/setup-distill-pipeline-automation.sh status
```

Progress / recovery commands:

```bash
# Queue state + latest counters
bun run distill-target:status
bun run distill-progress

# Recover stale or retryable targets
bun run distill-target:release-stale
bun run src/cli/distillation-target.ts release-paused
```

The pipeline LaunchAgent load step boots out legacy `vibe/source` distillation jobs to avoid duplicate execution.

---

## Embedding

memory-router supports two embedding providers with automatic fallback:

| Provider | Description | Configuration |
|---|---|---|
| **daemon** (default) | HTTP API embedding service | `MEMORY_ROUTER_EMBEDDING_DAEMON_URL` |
| **cli** | Python CLI fallback (`e5embed.cli`) | `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_*` |

```bash
# Provider selection
MEMORY_ROUTER_EMBEDDING_PROVIDER=auto|daemon|cli|disabled
```

When set to `auto` (default), the daemon is tried first; on failure, the CLI fallback is used.

---

## Testing

```bash
# Full verification gate (typecheck + lint + format + unit tests + web build)
bun run verify

# MCP-specific verification
bun run verify:mcp

# Integration tests (requires a test database)
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test \
  bun run test:integration

# End-to-end UI tests
bun run test:e2e
```

> **⚠️ Important**: `test:integration` truncates tables in the target database. Always use a dedicated test database (name should contain `test`).

---

## Configuration

All configuration is done through environment variables. See [`.env.example`](.env.example) for the complete list with defaults.

### Essential

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://...localhost:7889/memory_router` | PostgreSQL connection string |
| `MEMORY_ROUTER_SOURCE_CONTENT_ROOT` | `./wiki` | Wiki content directory |

### Embedding

| Variable | Default | Description |
|---|---|---|
| `MEMORY_ROUTER_EMBEDDING_PROVIDER` | `auto` | `auto`, `daemon`, `cli`, or `disabled` |
| `MEMORY_ROUTER_EMBEDDING_DAEMON_URL` | `http://127.0.0.1:44512` | Embedding daemon URL |
| `MEMORY_ROUTER_EMBEDDING_DIMENSION` | `384` | Embedding vector dimension |

### Distillation (LLM)

| Variable | Default | Description |
|---|---|---|
| `MEMORY_ROUTER_LOCAL_LLM_API_BASE_URL` | `http://127.0.0.1:44448` | Local LLM API endpoint |
| `MEMORY_ROUTER_LOCAL_LLM_MODEL` | `gemma-4-e4b-it` | LLM model name |
| `MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE` | `0.75` | Minimum score to accept a candidate |

### Agent Log Sync

| Variable | Default | Description |
|---|---|---|
| `MEMORY_ROUTER_CODEX_SESSION_DIR` | `~/.codex/sessions` | Codex sessions directory |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity/brain` | Antigravity logs directory |
| `MEMORY_ROUTER_AGENT_LOG_SYNC_INTERVAL_SECONDS` | `3600` | Sync interval |
| `MEMORY_ROUTER_AGENT_LOG_INITIAL_LOOKBACK_HOURS` | `168` | Initial lookback window |

---

## Project Structure

```
memory-router/
├── src/
│   ├── cli/              # CLI commands (compile, sync, distill, doctor, import)
│   ├── db/               # Drizzle ORM schema + client
│   ├── mcp/              # MCP server + tool definitions
│   │   └── tools/        # Tool implementations
│   ├── modules/
│   │   ├── context-compiler/   # Core compile engine (ranking, query, budgeting)
│   │   ├── knowledge/          # Knowledge repository + service
│   │   ├── vibe-memory/        # Conversation log ingestion + distillation
│   │   ├── sources/            # Wiki management + source distillation
│   │   ├── distillation/       # Shared distillation runtime + prompts
│   │   ├── embedding/          # Embedding service (daemon / CLI)
│   │   └── doctor/             # System diagnostics
│   └── shared/schemas/   # Zod validation schemas
├── api/                  # Hono REST API
├── web/                  # React frontend (Vite + TanStack)
├── test/                 # Unit + integration tests
├── tests/                # E2E tests (Playwright)
├── wiki/                 # Wiki content (independent Git repo)
├── drizzle/              # Database migrations
├── scripts/              # Automation setup scripts
└── docs/                 # Architecture and planning documents
```

---

## Documentation

| Document | Description |
|---|---|
| [MCP Tool Contract](docs/mcp-tools.md) | Full MCP tool input/output specifications |
| [Improvement Plan](docs/improvement-plan.md) | Current implementation roadmap and acceptance criteria |
| [Context Compile/MCP Plan](docs/context-compile-mcp-improvement-plan.md) | Context Compile and MCP hardening plan |
| [Knowledge Value Lifecycle](docs/knowledge-value-lifecycle.md) | Knowledge lifecycle operation policy |

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run the verification gate before committing:
   ```bash
   bun run verify
   ```
4. Commit your changes
5. Push to the branch
6. Open a Pull Request

### Development tips

- `bun run verify` is the primary quality gate (typecheck → lint → format → unit tests → web build)
- `test:unit` runs all `test/**/*.test.ts` and `web/src/**/*.test.ts(x)` via Vitest (integration/e2e tests are excluded)
- Integration tests require a `memory_router_test` database
- The `wiki/` directory has its own Git repository

---

## License

MIT
