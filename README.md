<p align="center">
  <strong>memory-router</strong><br/>
  <em>Local-first Adaptive Knowledge Compiler for Coding Agents</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/memoryRouter/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/memoryRouter/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#knowledge-landscape--action-queue">Landscape & Queue</a> ·
  <a href="#mcp-integration">MCP Integration</a> ·
  <a href="#cli-reference">CLI</a> ·
  <a href="#api-reference">API</a> ·
  <a href="spec/mcp-tools.md">MCP Tool Contract</a>
</p>

<p align="center">
  <a href="README.jp.md">🇯🇵 日本語版 README</a>
</p>

---

## What is memory-router?

**memory-router** is a local-first adaptive knowledge compiler for coding agents.

It turns working evidence (wiki/docs, website URLs, agent logs, and candidate knowledge proposed by agents) into reusable `rule` / `procedure` knowledge, compiles task-specific context packs under token budgets, and improves future selection quality through compile evaluations and usage feedback.

It is not a "document chunks -> prompt stuffing" system. It is an evidence-backed **distill -> compile -> evaluate -> evolve** loop for real coding workflows.

```
┌──────────────┐  ┌────────────┐  ┌─────────────────────┐  ┌─────────────────────────┐
│ Wiki / Docs  │  │ Web URLs   │  │ Agent Logs          │  │ Candidate Registration  │
│ (Markdown)   │  │ (web_ingest│  │ (Codex /            │  │ (register_candidate,    │
│              │  │  queue)    │  │  Antigravity/Claude)│  │  post-commit prompt)    │
└──────┬───────┘  └─────┬──────┘  └──────────┬──────────┘  └───────────┬─────────────┘
       │                │                     │                         │
       └────────────────┴─────────────────────┴─────────────────────────┘
                                   ▼
                     ┌──────────────────────────────┐
                     │ Distillation + Evidence Loop │
                     │ search_web / fetch_content   │
                     │ dedupe / quality gates       │
                     └──────────────┬───────────────┘
                                    ▼
                  ┌────────────────────────────────────────┐
                  │ knowledge_items + knowledge_source_links│
                  │ type: rule|procedure                   │
                  │ status: draft -> active -> deprecated  │
                  │ score: dynamic_score + decay-aware rank│
                  └───────────────┬────────────────────────┘
                                  ▼
                        ┌─────────────────────┐
                        │ context_compile     │
                        │ tag-aware ranking   │
                        │ token budget split  │
                        └─────────┬───────────┘
                                  ▼
                        ┌─────────────────────┐
                        │ Context Pack        │
                        │ + run diagnostics   │
                        └─────────┬───────────┘
                                  ▼
           ┌───────────────────────────────────────────────────────┐
           │ compile_eval + knowledge_usage_events + new candidates│
           │ => utility feedback + knowledge lifecycle evolution   │
           └───────────────────────────────────────────────────────┘
```

### Key Differentiators

| Feature | memory-router | Naive RAG | CLAUDE.md / Cursor Rules |
|---|---|---|---|
| Knowledge distillation | ✅ Staged pipeline (`finding -> covering -> premium -> finalize`) | ❌ Raw search | ❌ Manual |
| Knowledge model | ✅ `rule` / `procedure` split + skill-like procedure checks | ❌ Chunk-centric | ❌ Flat instruction text |
| Evidence traceability | ✅ `knowledge_source_links` + source refs + tool events | ❌ Weak | ❌ Usually none |
| Upstream variety | ✅ Wiki + web ingest + agent logs + candidate queue | △ Mostly docs | ❌ Manual only |
| Compile quality tracking | ✅ Run history + `compile_eval` (`score`, `outcome`) | ❌ | ❌ |
| Utility feedback signals | ✅ `knowledge_usage_events` (`used/not_used/off_topic/wrong`) | ❌ | ❌ |
| Lifecycle and decay | ✅ `draft/active/deprecated` + `dynamic_score` + decay penalties | ❌ | ❌ |
| Tag-aware retrieval | ✅ technologies/changeTypes/domains/general + repo scope | △ Prompt hacks | ❌ |
| Landscape diagnostics | ✅ Graph, replay, attractor/dead-zone, action queue | ❌ | ❌ |
| Candidate approval workflow | ✅ Review item -> candidate draft -> manual approval gate | ❌ | ❌ |
| MCP standard | ✅ Official SDK | ❌ | ❌ |

### Project Status

memory-router is an active local-first project for personal and team coding-agent workflows. It runs as a local MCP server, REST API, and admin UI. It is not a hosted multi-tenant SaaS product.

The current checkout includes staged distillation, web URL ingestion queueing, Codex/Antigravity/Claude log sync, context compile run diagnostics, compile evaluation storage, knowledge usage signals, knowledge graph + landscape replay diagnostics, persisted review items, candidate-draft generation, queue control plane, and manual approval enforcement for landscape-origin candidates.

The project favors auditability over invisible automation: compile runs, selected knowledge, source links, distillation targets, candidate rows, evidence checks, usage/eval signals, landscape review items, approval links, runtime settings, LLM usage logs, and health diagnostics are stored so you can inspect why a context pack was produced and why a candidate was or was not finalized.

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

The admin UI includes views for Overview, Source, Vibe Memory, Candidates, Queue, Knowledge, Graph, Compile, Audit, Doctor, and Settings. The Candidates view is the main place to inspect whether a candidate became stored knowledge, still needs finalization, was rejected, is retryable, only exists as a raw candidate, or requires landscape manual approval.

---

## How It Works

memory-router operates as a three-stage pipeline:

### Stage 1: Collect

Ingest raw evidence from multiple sources:

```bash
# Import Markdown documentation
bun run import:wiki ./wiki/pages

# Sync agent conversation logs (Codex / Antigravity / Claude)
bun run sync:agent-logs
```

You can also queue website URLs from the admin UI or API (`POST /api/sources/web`, `/api/sources/web/bulk`, `/api/sources/web/upload`). These are processed as `web_ingest` targets and converted into wiki-backed source pages for downstream distillation.

### Stage 2: Distill

Convert raw evidence into structured **rules** and **procedures** using a local LLM:

```bash
# Run one distillation cycle (auto selects wiki, vibe memory, or candidate targets)
bun run queue:finding:once

# Process queued follow-up stages
bun run queue:covering:once
bun run queue:premium:once
bun run queue:finalize:once
```

The staged distillation pipeline:
1. Selects a target from wiki files, agent memories, web-ingest targets, or knowledge candidates.
2. Extracts minimal `find_candidate_results` rows.
3. Checks source support, duplicate/near-duplicate matches, and external claims in `cover_evidence_results`.
4. Uses `search_web` to find source URLs and `fetch_content` to ground external claims. Search and fetched content are cached in `distillation_evidence_cache`.
5. Finalizes `knowledge_ready` candidates into `draft` knowledge when they remain valuable enough (`importance > 50`), can be embedded, and pass any landscape manual-approval gate.

Candidate outcomes are intentionally separated from final knowledge. `rejected` means the cover-evidence stage found a terminal reason such as `duplicate`, `near_duplicate`, `unsupported_by_source`, `not_actionable`, or `external_fetch_evidence_missing`; retryable provider/tool/parse failures are tracked separately.

For `knowledge_candidate` targets created from Landscape review items, finalization is approval-gated. If the candidate link is not `approved`, `finalizeDistille` rejects it with `landscape_manual_approval_required` and marks the link as `review_required` when writing.

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
3. Ranks by weighted score (importance, confidence, dynamic score, source evidence, applicability), with decay/deprecated/stale penalties
4. Allocates token budget across sections (rules → procedures → sources)
5. Returns a structured Markdown context pack with diagnostics

### Operational Feedback Loop

After compile, memory-router records and uses multiple feedback channels:

1. `context_pack_items` records what was selected for a run.
2. `knowledge_usage_events` records per-knowledge usage signals (`used`, `not_used`, `off_topic`, `wrong`).
3. `compile_eval` stores run-level usefulness (`score: 0-100`, `outcome`, rationale `body`) in `context_compile_evals`.
4. `register_candidate` / `register_candidates` stores new reusable lessons as `knowledge_candidate` targets for distillation.

Optional pre/post-commit reminder hooks can be installed to make this loop explicit in day-to-day coding:

```bash
./scripts/setup-candidate-registration-hook.sh install
```

With hooks installed:
- pre-commit reminder asks for `compile_eval` when `context_compile` was used.
- post-commit reminder writes a prompt to review the commit and register durable candidates.

---

## Knowledge Landscape & Action Queue

Knowledge Landscape turns compile history, feedback, graph communities, and replay comparisons into an operational review loop.

### What it surfaces

| Area | What it answers |
|---|---|
| Graph view | How knowledge items, sources, sessions, projects, and semantic neighbors relate |
| Community landscape | Which clusters are strong attractors, useful attractors, negative candidates, over-selected, stale, or dead-zone risks |
| Replay comparison | Whether current retrieval loses previously used baseline knowledge, drifts, or has no current match |
| Review items | Persisted action items for replay drift, landscape risks, semantic/relation splits, and promotion-gate concerns |
| Candidate drafts | Deterministic `rule` / `procedure` drafts generated from review items |
| Approval links | Traceability from review item to distillation target and candidate, with `draft_created -> review_required -> approved/rejected -> finalized` lifecycle |

### CLI workflow

```bash
# Inspect the current landscape
bun run landscape -- --window-days 30 --json

# Materialize replay/landscape/promotion risks into persisted review items
bun run landscape -- --queue --queue-source replay_compare,landscape_snapshot,semantic_relation_comparison,promotion_gate

# List review items
bun run landscape -- --queue-list --queue-status pending

# Create candidate drafts from pending/reviewing review items
bun run landscape -- --queue-create-candidates --queue-status pending --queue-limit 20

# Run a single generated candidate through the distillation pipeline
bun run queue:covering:once
```

Approve a landscape candidate link before finalization when review is required:

```bash
curl -X PATCH http://localhost:5173/api/graph/landscape/review-items/<reviewItemId>/candidate-links/<linkId> \
  -H "content-type: application/json" \
  -d '{"status":"approved","note":"manual review complete","actor":"local-admin"}'
```

### Admin UI workflow

1. Open **Graph** and switch to community view.
2. Use **Create Review Items** to persist replay and landscape diagnostics.
3. Use **Create Candidate Drafts** to turn pending review items into deterministic candidate targets.
4. Open **Queue** to inspect active distillation targets, pause/requeue work, and monitor worker heartbeats.
5. Open **Candidates** to inspect outcome diffs, landscape warnings, and `targetStateId` filtered candidates.
6. Approve or reject landscape candidate links through the approval API before finalization when a promotion-gate or review-required warning is present.

The queue and approval flow is deliberately explicit. Landscape diagnostics do not directly mutate `knowledge_items`, runtime ranking, or production behavior; they create reviewable artifacts that can be audited and promoted.

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
| `compile_eval` | Record post-task context usefulness (`score`, `outcome`, rationale) | After the task, per compile run |
| `search_knowledge` | Raw knowledge candidate inspection | When `context_compile` results need investigation |
| `register_candidate` | Register a lightweight rule/procedure candidate | When the agent discovers reusable patterns |
| `register_candidates` | Bulk register multiple candidates | When several reusable lessons were found |
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
6. compile_eval             → Save usefulness evaluation for the run
7. register_candidate(s)    → Save reusable discoveries as candidates
8. doctor                   → Check system health if issues arise
```

For the full MCP tool contract, see [spec/mcp-tools.md](spec/mcp-tools.md).

---

## CLI Reference

| Command | Description |
|---|---|
| `bun run init:project` | Run first-time onboarding flow (import, preset, smoke compile) |
| `bun run compile` | Compile a context pack |
| `bun run import:wiki <path>` | Import Markdown into sources |
| `bun run import:markdown <file>` | Import a single Markdown file |
| `bun run sync:agent-logs` | Sync Codex / Antigravity / Claude logs |
| `bun run queue:finding:once` | Run one finding-queue cycle (source/provided candidate intake) |
| `bun run queue:covering:once` | Run one covering-evidence queue cycle |
| `bun run queue:premium:once` | Run one premium covering-evidence queue cycle |
| `bun run queue:finalize:once` | Run one finalize queue cycle |
| `bun run queue:supervisor` | Run queue supervisor continuously |
| `bun run queue:migrate:dry-run` | Preview queue migration mapping without writes |
| `bun run queue:migrate:write` | Write queue migration mapping rows |
| `bun run doctor` | Run system diagnostics |
| `bun run landscape -- --window-days 30` | Generate a community-based landscape snapshot |
| `bun run landscape -- --window-days 30 --json` | Emit full landscape snapshot JSON |
| `bun run landscape -- --queue --queue-source ...` | Materialize landscape/replay diagnostics into review items |
| `bun run landscape -- --queue-list --queue-status pending` | List persisted landscape review items |
| `bun run landscape -- --queue-create-candidates --queue-status pending` | Create deterministic candidate drafts from review items |
| `bun run backfill:knowledge-project-context` | Backfill project context on existing knowledge |
| `./scripts/backup-db.sh` | Dump and zip the PostgreSQL database |
| `bun run db:seed:export` | Export current knowledge-focused seed snapshot (`src/db/seeds/knowledge-seed.json`) |
| `bun run db:seed` | Upsert knowledge-focused seed data (excludes audit/candidate tables) |

### Cold Start Flow

Use `init:project` on a fresh repository to connect the first-run path end-to-end:

```bash
# import wiki + seed global preset + smoke compile
bun run init:project -- --wiki-root ./wiki/pages

# run queue cycles
bun run queue:finding:once
bun run queue:covering:once
```

- Global preset entries are stored as `scope: global`.
- Repo-specific knowledge stays in `scope: repo` through `import:wiki` / `queue:supervisor`.
- If smoke compile returns no relevant items, the command prints concrete next actions.

### Examples

```bash
# Compile with task facets and JSON output
bun run compile --goal "fix context compiler" \
  --change-types bugfix,backend \
  --technologies bun,typescript \
  --domains context-compiler \
  --json

# Distill one cycle (auto target selection)
bun run queue:finding:once

# Process each queue stage once
bun run queue:finding:once
bun run queue:covering:once
bun run queue:premium:once
bun run queue:finalize:once

# Create and process review-item candidate drafts
bun run landscape -- --queue-create-candidates --queue-status pending --queue-limit 20
bun run queue:covering:once
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
| `POST` | `/api/sources/web` | Queue one website URL for web-ingest distillation |
| `POST` | `/api/sources/web/bulk` | Queue multiple website URLs |
| `POST` | `/api/sources/web/upload` | Extract URLs from uploaded file and queue them |
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
| `GET` | `/api/graph/landscape/replay` | Replay-based community landscape diagnostics |
| `GET` | `/api/graph/landscape/replay/compare` | Baseline-vs-current retrieval comparison |
| `POST` | `/api/graph/landscape/replay/queue` | Materialize replay/landscape diagnostics into review items |
| `GET` | `/api/graph/landscape/review-items` | List persisted landscape review items |
| `POST` | `/api/graph/landscape/review-items/candidates` | Create deterministic candidate drafts from review items |
| `PATCH` | `/api/graph/landscape/review-items/:id` | Resolve or dismiss a landscape review item |
| `PATCH` | `/api/graph/landscape/review-items/:id/candidate-links/:linkId` | Approve or reject a landscape candidate link |
| `GET` | `/api/graph/community-labels` | List persisted community labels |
| `PUT` | `/api/graph/community-labels/:communityKey` | Update a community label |
| `GET` | `/api/graph/nodes/:id` | Knowledge graph node detail |
| `GET` | `/api/queue` | List distillation queue targets with filters |
| `GET` | `/api/queue/stats` | Distillation queue status and kind counters |
| `GET` | `/api/queue/active` | Active running distillation targets |
| `POST` | `/api/queue/:id/pause` | Pause a target state |
| `POST` | `/api/queue/:id/resume` | Requeue or resume a target state |
| `GET` | `/api/audit-logs` | Audit log timeline |
| `GET` | `/api/candidates` | List distillation candidates with outcome stats, diffs, target filters, and landscape warnings |
| `GET/PUT` | `/api/settings` | Read / update runtime settings |
| `POST` | `/api/settings/providers/:provider/test` | Test an LLM provider configuration |
| `POST` | `/api/settings/reload-runtime-cache` | Reload runtime settings cache |

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
| `sources` | Canonical source corpus (`source_kind` currently `wiki`). Human-authored wiki pages and web-research pages land here. |
| `source_fragments` | Internal search index for wiki pages. Not a user-facing input. |
| `vibe_memories` | Natural language conversation logs from coding agents (Codex/Antigravity/Claude). |
| `agent_diff_entries` | Code diffs extracted from conversation logs (`diff_hunk` + symbol metadata). |

### Knowledge layer

| Table | Description |
|---|---|
| `knowledge_items` | Distilled rules and procedures. `type: rule \| procedure`, `status: draft \| active \| deprecated`, `scope: repo \| global`, with utility counters and `dynamic_score`. |
| `knowledge_source_links` | Links knowledge back to its source evidence. |
| `knowledge_tag_definitions` | Shared applicability tag definitions (`technology`, `change_type`, `domain`, `retrieval_mode`). |
| `knowledge_community_labels` | Persisted human labels for graph communities. |

### Processing layer

| Table | Description |
|---|---|
| `distillation_evidence_cache` | Short-lived cache for external evidence lookup results. |
| `distillation_target_states` | Target selection and lifecycle state for the staged distillation flow. |
| `find_candidate_results` | Minimal candidate rows produced by `findCandidate`. |
| `cover_evidence_results` | Evidence coverage results keyed by `find_candidate_results.id`. |
| `knowledge_items` metadata indexes | Fast joins from finalized knowledge back to candidate/cover-evidence IDs. |
| `context_compile_runs` | Compile execution history with diagnostics. |
| `context_compile_evals` | Run-level compile usefulness evaluations (`score`, `outcome`, rationale). |
| `context_pack_items` | Items selected for each compile run. |
| `knowledge_usage_events` | Per-knowledge usage feedback (`used` / `not_used` / `off_topic` / `wrong`). |
| `knowledge_review_queue` | Review queue for explicit wrong-knowledge feedback. |
| `landscape_review_items` | Persisted Knowledge Landscape action items from replay, attractor/dead-zone, semantic comparison, and promotion-gate signals. |
| `landscape_review_item_candidate_links` | Traceability and approval state between review items, distillation targets, and candidate rows. |
| `knowledge_quality_adjustments` | Quality adjustment records derived from review/feedback flows. |
| `llm_usage_logs` | LLM request/usage telemetry for local/cloud provider observability. |
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

Continuously ingest conversation logs from Codex, Antigravity, and Claude:

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
- Claude: `~/.claude/projects`
- On Windows, fallback roots under `%APPDATA%` / `%LOCALAPPDATA%` are scanned in addition to defaults.

### Distillation Automation (Conveyor)

Run Queue V2 distillation workers (`findingCandidate -> coveringEvidence -> premiumCoveringEvidence -> finalizeDistille`) on a schedule:

```bash
# One-time run
bun run queue:finding:once

# Install and load as macOS LaunchAgent
bun run automation:queue-supervisor -- install
bun run automation:queue-supervisor -- load
bun run automation:queue-supervisor -- status

# Windows Task Scheduler
bun run automation:queue-supervisor -- install
bun run automation:queue-supervisor -- load
bun run automation:queue-supervisor -- status
```

Progress / recovery commands:

```bash
# Queue state + latest counters
bun run doctor
bun run queue:finding:once

# Queue migration/backfill dry-run
bun run queue:migrate:dry-run
```

The **Queue** admin page is the primary operational view: status counters, running locks, worker heartbeat age, queue/status filters, and pause/resume/retry controls.

### Candidate Registration Reminder Hooks (Optional)

Install local Git hooks that remind compile evaluation and post-commit candidate extraction:

```bash
./scripts/setup-candidate-registration-hook.sh install
```

Common operations:

```bash
./scripts/setup-candidate-registration-hook.sh status
./scripts/setup-candidate-registration-hook.sh uninstall
./scripts/setup-candidate-registration-hook.sh install-global
./scripts/setup-candidate-registration-hook.sh status-global
```

Behavior (when installed):
- pre-commit: reminder to run `compile_eval` for tasks that used `context_compile`.
- post-commit: writes a candidate-registration prompt (`logs/post-commit-candidate-reminders/latest.md` in this repo, or state directory for other repos).

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
- Agent log sync reads local Codex, Antigravity, and Claude log directories when configured.
- Distillation can call external search providers (`brave`, `exa`) and external LLM providers (`azure-openai`, `bedrock`) if you configure those providers.
- Use `MEMORY_ROUTER_DISTILLATION_PROVIDER=local-llm` and omit search API keys for the most local setup.
- `test:integration` is destructive and must target a dedicated database whose name includes `test`.

---

## Current Limitations

- Authentication and multi-user authorization are not part of the local admin UI.
- Distilled items enter the system as `draft` or candidate records; high-quality operation still depends on human review before promotion.
- External evidence coverage depends on provider availability, API keys, and rate limits.
- Knowledge Landscape produces reviewable diagnostics and candidate drafts; it does not automatically change production ranking or mutate active knowledge without the normal review/finalization path.
- Landscape-origin candidates require manual approval before finalization when a promotion-gate or review-required warning is present.
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
│   │   ├── landscape/          # Knowledge Landscape, replay, review items, candidate links
│   │   ├── distillationPipeline/# Staged target runner
│   │   ├── distillation/       # Shared distillation runtime + prompts
│   │   ├── finalizeDistille/   # Candidate finalization + approval gate
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
└── spec/                 # Architecture and planning documents
```

---

## Documentation

| Document | Description |
|---|---|
| [MCP Tool Contract](spec/mcp-tools.md) | Full MCP tool input/output specifications |
| [Project Evaluation](spec/project-evaluation.md) | Evidence-backed project value and current maturity notes |
| [Knowledge Landscape Concept](spec/knowledge-landscape-concept-design.md) | Concept model for graph/community/knowledge-field views |
| [OSS Onboarding & Localization Plan](spec/oss-onboarding-and-localization-plan.md) | OSS onboarding flow and README localization rollout plan |

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
