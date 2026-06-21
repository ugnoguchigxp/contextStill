# Architecture Overview

context-still is a local-first runtime for turning work evidence into reusable task context.

## Product Shape

The default product path is a desktop/local control plane for coding-agent memory.

| Path | Backend | Audience | Status |
|---|---|---|---|
| Desktop local | SQLite | Individual/local team usage, Tauri packaging target | Default |
| Advanced server backend | PostgreSQL / pgvector | Compatibility and future server-style deployment work | Opt-in |
| Compatibility legacy | old command names and migration paths | Existing users and scripts | Preserve without leading the product |

The admin UI, CLI, MCP server, and automation workers are local control-plane surfaces. They are not a hosted multi-tenant SaaS architecture.

## Runtime Boundary

The runtime boundary is deliberately split so that UI maintenance does not define the lifetime of background work.

| Surface | Lifetime | Responsibility |
|---|---|---|
| Daemon / worker runtime | Long-lived; may continue after the UI closes | MCP server management, CLI command execution, queue supervision, agent-log sync, automation, doctor, backup, bootstrap, and process supervision |
| Hono API | UI-facing HTTP surface; can follow the admin UI lifecycle unless promoted to a daemon control API | Admin UI facade for knowledge, sources, graph, queue controls, settings, context runs, decision history, and dashboards |
| Tauri / web UI | On-demand operator surface | Knowledge maintenance, review, settings, diagnostics, and explicit operator actions |

Hono should not become the owner of durable runtime behavior by accident. If a future desktop/server build needs a long-lived control API, it should be modeled as daemon control surface separately from the admin UI facade. MCP and CLI remain daemon-side entrypoints and should not depend on the admin UI being open.

## Core Loop

```text
sources + web + agent logs + candidates
  -> staged distillation
  -> draft/active knowledge
  -> task-specific context_compile
  -> context_decision as the pre-question gate at blocking judgment points
  -> compile_eval + decision/usage feedback
  -> new candidates
```

## Runtime Components

| Component | Path | Role |
|---|---|---|
| CLI | `src/cli/` | Operational commands for compile, sync, distillation, diagnostics, backups, and automation |
| MCP server | `src/mcp/` | Optional agent-facing tool surface |
| REST API | `api/` | Hono admin UI API facade and dashboard/control HTTP surface |
| Admin UI | `web/` | Review, graph, queue, compile, settings, and diagnostics UI |
| SQLite backend | `src/db/sqlite/`, SQLite repositories | Default local backend for the desktop product path |
| Server backend | `src/db/`, `drizzle/` | PostgreSQL schema, migrations, and compatibility tooling |
| Distillation | `src/modules/distillation*`, `src/modules/finalizeDistille/` | Candidate extraction, evidence coverage, and finalization |
| Context compiler | `src/modules/context-compiler/` | Retrieval, ranking, budget allocation, and pack formatting |
| Context decision | `src/modules/context-decision/`, `api/modules/context-decision/`, `web/src/modules/context-decision/` | Knowledge-backed autonomous decisions, audit traces, and feedback effects |
| Knowledge graph | `src/modules/landscape/`, `api/modules/graph/` | Graph/replay diagnostics and review-item workflows |
| Doctor | `src/modules/doctor/` | Health checks and desktop readiness summary |

## Backend Support Matrix

| Feature family | SQLite local | PostgreSQL server |
|---|---|---|
| Knowledge items and tags | Complete for primary local path | Preserved |
| Candidate registration | Complete for primary local path | Preserved |
| Knowledge search | Complete with text search and vector fallback/extension support | Preserved with pgvector |
| Source documents and fragments | Complete for local source search | Preserved |
| `context_compile` runs and pack snapshots | Complete for local path | Preserved |
| `compile_eval` | Complete for local path | Preserved |
| Runtime settings | Complete for local path | Preserved |
| Audit logs | Complete for local path | Preserved |
| Context decision history | SQLite repository exists for local path | Preserved |
| Landscape / overview diagnostics | SQLite-capable for active local diagnostics | Preserved |
| Queue/distillation automation | Partially migrated; use explicit support checks | Preserved advanced path |
| Multi-user/auth/server deployment | Not a desktop goal | Future productization work |

New features should declare one backend target before implementation starts:

- `sqlite-local`: default desktop backend
- `postgres-server`: advanced server backend
- `compat-legacy`: migration or old-name compatibility only

## Data Families

| Family | Tables | Purpose |
|---|---|---|
| Evidence | `sources`, `source_fragments`, `vibe_memories`, `agent_diff_entries` | Raw or lightly structured inputs |
| Knowledge | `knowledge_items`, `knowledge_source_links`, `knowledge_tag_definitions` | Reusable `rule` / `procedure` knowledge and traceability |
| Distillation | `distillation_target_states`, `find_candidate_results`, `cover_evidence_results`, `distillation_evidence_cache` | Staged extraction and evidence coverage |
| Compile | `context_compile_runs`, `context_pack_items`, `context_compile_evals`, `knowledge_usage_events` | Compile output, selected items, and usefulness feedback |
| Decision | `context_decision_runs`, `context_decision_evidence`, `context_decision_coverage_traces`, `context_decision_feedback*` | Autonomous decision history, selected Knowledge evidence, coverage traces, and feedback effects |
| Landscape | `landscape_review_items`, `landscape_review_item_candidate_links`, `knowledge_community_labels` | Graph/replay review loop and approval-gated candidates |
| Operations | `sync_states`, `settings`, `audit_logs`, `llm_usage_logs` | Runtime state, settings, audit, and observability |

## Desktop Bootstrap States

Desktop startup should present recoverable states instead of raw development errors:

| State | User-facing status | Expected action |
|---|---|---|
| no database | Needs setup | Create/open the SQLite DB under the app data path |
| database needs migration | Needs setup | Apply local migrations/bootstrap |
| settings incomplete | Needs setup or Optional improvement | Save required local settings; keep optional model settings non-blocking |
| embedding unavailable | Optional improvement | Continue with fallback/text search, or configure embedding |
| MCP not registered | Optional improvement | Offer explicit registration; do not block local app usage |
| server backend selected | Advanced server backend only | Show PostgreSQL/pgvector diagnostics only in the advanced path |

## Knowledge Lifecycle

Knowledge moves through explicit states:

- `draft`: created by import, seed, or distillation and awaiting review.
- `active`: eligible for compile retrieval.
- `deprecated`: retained for audit/history but penalized or excluded from normal selection.

Candidates and review items remain separate from final knowledge. This separation keeps diagnostics, proposals, and promoted operational knowledge auditable.

## Automation Model

context-still uses queue workers instead of hidden background mutation:

- `agent-log-sync` imports local agent logs on demand or through LaunchAgent / Task Scheduler.
- `queue-supervisor` runs distillation stages continuously or on a schedule.
- `doctor` reports DB, optional embedding/LLM, provider, sync, queue, landscape, and desktop readiness signals.

## Server Backend Constraints

The PostgreSQL / pgvector backend is intentionally preserved. It remains opt-in until server productization work resolves:

- multi-user/auth model
- remote DB latency assumptions
- backup/restore differences from SQLite
- N+1 query avoidance under network latency
- deployment and migration ownership

Server backend compatibility tests should stay explicit, but desktop users should not need to understand pgvector to complete onboarding.

## Boundaries

- The admin UI is local control-plane software, not a hosted multi-tenant product.
- Landscape diagnostics create reviewable artifacts; they do not directly mutate production ranking.
- MCP tools and CLI commands are daemon-side entrypoints. REST API endpoints are primarily for the admin UI facade and should not be required for background work to continue.
- `.env` is a development/advanced configuration surface, not a required desktop onboarding step.
- `context-stilld` is an in-progress Rust boundary host for paths, preflight, lifecycle status, and delegated process supervision. It does not replace TypeScript product logic yet; TypeScript commands remain the fallback/source of truth until each boundary passes its own smoke gate.
