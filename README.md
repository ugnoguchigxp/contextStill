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
│  │ Value  │ │ Tool Loop   │  │               │
│  │ Gate   │ │ search_web  │  │               │
│  │ >50    │ │ fetch docs  │  │               │
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

### Project Status

memory-router is an active local-first project for personal and team coding-agent workflows. It is usable as a local MCP server, REST API, and admin UI, but it is not a hosted multi-tenant SaaS product. Expect to run your own PostgreSQL/pgvector database and review distilled `draft` knowledge before promoting it to `active`.

The project favors auditability over invisible automation: compile runs, selected knowledge, source links, distillation candidates, evidence checks, and health diagnostics are stored so you can inspect why a context pack was produced.

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Docker](https://www.docker.com/) (for PostgreSQL + pgvector)
- A local LLM server for distillation (optional; this checkout defaults to a local OpenAI-compatible endpoint at `http://127.0.0.1:44448`)
- An embedding service (optional, daemon or CLI)

### Setup

```bash
git clone https://github.com/ugnoguchigxp/memoryRouter.git
cd memoryRouter
bun install
docker compose up -d
cp .env.example .env
bun run db:migrate
bun run init:project -- --json
```

`init:project` prints concrete next actions for `compile`, `doctor`, and draft review.
Use these commands for a first health check:

```bash
bun run doctor
bun run compile --goal "understand this repository's development workflow" \
  --change-types docs,plan \
  --domains onboarding,workflow \
  --json
```

### Start Developing

```bash
# Start the dev server (UI + API)
bun run dev
```

- **UI**: http://localhost:5173
- **API**: Same origin at `/api/*`

The admin UI includes views for knowledge, source pages, graph exploration, compile history, system health, audit logs, and distillation candidates. The Candidates view is the main place to inspect whether a candidate became stored knowledge, still needs finalization, was rejected, is retryable, or only exists as a raw candidate.

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

The staged distillation pipeline:
1. Selects a target from wiki files or agent memories.
2. Extracts minimal `find_candidate_results` rows.
3. Checks source support, duplicate/near-duplicate matches, and external claims in `cover_evidence_results`.
4. Uses `search_web` to find source URLs and `fetch_content` to ground external claims. Search and fetched content are cached in `distillation_evidence_cache`.
5. Finalizes `knowledge_ready` candidates into `draft` knowledge when they remain valuable enough (`importance > 50`) and can be embedded.

Candidate outcomes are intentionally separated from final knowledge. `rejected` means the cover-evidence stage found a terminal reason such as `duplicate`, `near_duplicate`, `unsupported_by_source`, `not_actionable`, or `external_fetch_evidence_missing`; retryable provider/tool/parse failures are tracked separately.

### Stage 3: Compile

Generate a token-budgeted context pack tailored to the current task:

```bash
bun run compile --goal "fix the authentication middleware" \
  --change-types bugfix,backend \
  --domains auth
```

The compiler:
1. Resolves retrieval mode from `changeTypes` and goal keywords
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
| `register_candidate` | Register a lightweight rule/procedure candidate | When the agent discovers reusable patterns |
| `search_memory` | Search past conversations and diffs | When identifying candidate memories by ID |
| `fetch_memory` | Fetch a specific memory by ID | When inspecting one memory in detail |
| `doctor` | System health diagnostics | When compile is degraded/failed |

Deprecated aliases: `memory_search` -> `search_memory`, `memory_fetch` -> `fetch_memory`.

### Recommended workflow

```
1. initial_instructions     → Get operating rules
2. context_compile          → Get task-specific context (primary)
3. search_knowledge         → Investigate if needed (supplementary)
4. search_memory/fetch_memory → Inspect past conversations only when needed
5. ... do the work ...
6. register_candidate       → Save reusable discoveries as candidates
7. doctor                   → Check system health if issues arise
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
| `bun run distill:pipeline -- --write --limit 1 --kind wiki` | Run the staged distillation pipeline explicitly |
| `bun run distill-target:refresh` | Refresh wiki/vibe/candidate distillation targets |
| `bun run distill:status` | Show distillation target queue and progress counters |
| `bun run distill-target:release-stale` | Release stale running distillation targets |
| `bun run doctor` | Run system diagnostics |
| `bun run landscape -- --window-days 30` | Generate a community-based landscape snapshot |
| `bun run landscape -- --window-days 30 --json` | Emit full landscape snapshot JSON |
| `bun run backfill:knowledge-project-context` | Backfill project context on existing knowledge |
| `./scripts/backup-db.sh` | Dump and zip the PostgreSQL database |

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
# Compile with task facets and JSON output
bun run compile --goal "fix context compiler" \
  --change-types bugfix,backend \
  --technologies bun,typescript \
  --domains context-compiler \
  --json

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
| `GET` | `/api/health` | API health check |
| `GET` | `/api/overview` | Admin overview metrics |
| `POST` | `/api/context/compile` | Compile a context pack |
| `GET` | `/api/context/runs` | List recent compile runs |
| `GET` | `/api/context/runs/:id` | Compile run detail |
| `POST` | `/api/context/runs/:id/knowledge-feedback` | Save manual usage feedback for selected knowledge |
| `GET` | `/api/doctor` | System health report |
| `GET` | `/api/knowledge` | List / search knowledge items |
| `POST` | `/api/knowledge` | Create a knowledge item |
| `POST` | `/api/knowledge/bulk-status` | Bulk promote/deprecate knowledge items |
| `PUT` | `/api/knowledge/:id` | Update a knowledge item |
| `POST` | `/api/knowledge/:id/feedback` | Record direct up/down feedback |
| `DELETE` | `/api/knowledge/:id` | Delete a knowledge item |
| `GET` | `/api/knowledge/tags` | List applicability tag definitions |
| `GET` | `/api/sources/health` | Source content health |
| `GET` | `/api/sources/tree` | Wiki source tree |
| `GET` | `/api/sources/search` | Search source pages |
| `POST` | `/api/sources/reindex` | Rebuild source fragments |
| `GET/POST` | `/api/sources/folders` | List / create folders |
| `PUT/DELETE` | `/api/sources/folders/*` | Update / delete a folder |
| `GET/POST` | `/api/sources/pages` | List / create pages |
| `GET/PUT/DELETE` | `/api/sources/pages/*` | Get / update / delete a page |
| `GET` | `/api/sources/history/*` | Page Git history |
| `GET` | `/api/sources/diff/*` | Page diff between commits |
| `GET/POST` | `/api/vibe-memory` | List / create vibe memories |
| `GET/DELETE` | `/api/vibe-memory/:id` | Get / delete a memory |
| `GET` | `/api/agent-diffs` | List agent diff entries |
| `GET` | `/api/graph` | Knowledge graph data |
| `GET` | `/api/graph/landscape` | Community landscape snapshot (attractor/dead-zone diagnostics) |
| `GET` | `/api/graph/community-labels` | List persisted community labels |
| `PUT` | `/api/graph/community-labels/:communityKey` | Update a community label |
| `GET` | `/api/graph/nodes/:id` | Knowledge graph node detail |
| `GET` | `/api/audit-logs` | Audit log timeline |
| `GET` | `/api/candidates` | List distillation candidates with outcome stats |

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
| `knowledge_items` metadata indexes | Fast joins from finalized knowledge back to candidate/cover-evidence IDs. |
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
bun run automation:agent-log-sync -- install
bun run automation:agent-log-sync -- load
bun run automation:agent-log-sync -- status

# Windows Task Scheduler
bun run automation:agent-log-sync -- install
bun run automation:agent-log-sync -- load
bun run automation:agent-log-sync -- status
```

Default log locations:
- Codex: `~/.codex/sessions` and `~/.codex/archived_sessions`
- Antigravity: `~/.gemini/antigravity/brain`
- On Windows, fallback roots under `%APPDATA%` / `%LOCALAPPDATA%` are scanned in addition to defaults.

### Distillation Automation (Conveyor)

Run staged distillation (`selectDistillationTarget -> findCandidate -> coverEvidence -> finalizeDistille`) on a schedule:

```bash
# One-time run
bun run distill:pipeline:once

# Install and load as macOS LaunchAgent
bun run automation:distill-pipeline -- install
bun run automation:distill-pipeline -- load
bun run automation:distill-pipeline -- status

# Windows Task Scheduler
bun run automation:distill-pipeline -- install
bun run automation:distill-pipeline -- load
bun run automation:distill-pipeline -- status
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

### Database Backup

```bash
./scripts/backup-db.sh
```

The script uses the `memory-router-db` Docker container by default and writes `backup/db_backup_<timestamp>.zip`. Override `BACKUP_DIR`, `CONTAINER_NAME`, `DB_USER`, `DB_NAME`, or `DB_PASSWORD` when your local deployment differs from `docker-compose.yml`.

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

## Privacy and Safety

- The primary datastore is your local PostgreSQL/pgvector database.
- Wiki pages are stored under the local `MEMORY_ROUTER_SOURCE_CONTENT_ROOT` directory.
- Agent log sync reads local Codex and Antigravity log directories when configured.
- Distillation can call external search providers (`brave`, `exa`) and external LLM providers (`azure-openai`, `bedrock`) if you configure those providers.
- Use `MEMORY_ROUTER_DISTILLATION_PROVIDER=local-llm` and omit search API keys for the most local setup.
- `test:integration` is destructive and must target a dedicated database whose name includes `test`.

---

## Current Limitations

- Authentication and multi-user authorization are not part of the local admin UI.
- Distilled items enter the system as `draft` or candidate records; high-quality operation still depends on human review before promotion.
- External evidence coverage depends on provider availability, API keys, and rate limits.
- The web UI is an admin/control-plane surface, not a packaged desktop app or hosted service.

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
| `MEMORY_ROUTER_DISTILLATION_PROVIDER` | `local-llm` | `local-llm`, `azure-openai`, `bedrock`, or `auto` |
| `MEMORY_ROUTER_DISTILLATION_FIND_CANDIDATE_PROVIDER` | inherits `MEMORY_ROUTER_DISTILLATION_PROVIDER` | Optional `findCandidate` provider override; use `azure-openai` for OpenAI/Azure extraction, or `local-llm` / `bedrock` / `auto` |
| `MEMORY_ROUTER_DISTILLATION_SEARCH_PROVIDERS` | `brave,exa` | Ordered search providers for `search_web` |
| `MEMORY_ROUTER_EXA_API_KEY` / `EXA_API_KEY` | empty | Exa search API key |
| `BRAVE_SEARCH_API_KEY` | empty | Brave Search API key |

### Agent Log Sync

| Variable | Default | Description |
|---|---|---|
| `MEMORY_ROUTER_CODEX_SESSION_DIR` | `~/.codex/sessions` | Codex sessions directory |
| `MEMORY_ROUTER_CODEX_SESSION_DIRS` | empty | Additional Codex session roots (comma/semicolon-separated) |
| `MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIRS` | empty | Additional Codex archived-session roots (comma/semicolon-separated) |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity/brain` | Antigravity logs directory |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIRS` | empty | Additional Antigravity log roots (comma/semicolon-separated) |
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
├── e2e/                  # E2E tests (Playwright)
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
| [Project Evaluation](docs/project-evaluation.md) | Evidence-backed project value and current maturity notes |
| [Knowledge Landscape Concept](docs/knowledge-landscape-concept-design.md) | Concept model for graph/community/knowledge-field views |
| [Graph Community View Plan](docs/graph-community-view-mvp-plan.md) | Graph community UI/API implementation plan |
| [Knowledge Landscape Attractor Plan](docs/knowledge-landscape-attractor-implementation-plan.md) | Phase 1 implementation plan for attractor/negative/dead-zone snapshot |
| [Knowledge Usage Signal Redesign](docs/compile-knowledge-usage-signal-redesign-plan.md) | Compile-run usage signal and feedback redesign |
| [Knowledge Feedback Staged Learning](docs/knowledge-feedback-staged-learning-plan.md) | Manual feedback and staged learning design |
| [Doctor Operational Hardening](docs/doctor-distillation-operational-hardening-plan.md) | Doctor/distillation health and operational diagnostics |
| [Failure Experience Candidates](docs/failure-experience-knowledge-candidate-plan.md) | `register_candidate` and failure-experience distillation plan |
| [Web UI Component Refactor](docs/web-ui-component-dry-refactor-plan.md) | Admin UI component cleanup plan |

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

[MIT](LICENSE)
