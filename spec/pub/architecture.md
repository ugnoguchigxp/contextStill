# Architecture Overview

context-still is a local-first runtime for turning work evidence into reusable task context.

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
| CLI | `src/cli/` | Operational commands for compile, sync, distillation, diagnostics, and automation |
| MCP server | `src/mcp/` | Agent-facing tool surface |
| REST API | `api/` | Admin UI API and local automation surface |
| Admin UI | `web/` | Review, graph, queue, compile, settings, and diagnostics UI |
| Database | `src/db/`, `drizzle/` | PostgreSQL schema, migrations, and seed tooling |
| Distillation | `src/modules/distillation*`, `src/modules/finalizeDistille/` | Candidate extraction, evidence coverage, and finalization |
| Context compiler | `src/modules/context-compiler/` | Retrieval, ranking, budget allocation, and pack formatting |
| Context decision | `src/modules/context-decision/`, `api/modules/context-decision/`, `web/src/modules/context-decision/` | Knowledge-backed autonomous decisions, audit traces, and feedback effects |
| Knowledge graph | `src/modules/landscape/`, `api/modules/graph/` | Graph/replay diagnostics and review-item workflows |
| Doctor | `src/modules/doctor/` | System health checks |

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
- `doctor` reports whether DB, embedding, provider, sync, queue, and landscape signals are healthy.

## Boundaries

- The admin UI is local control-plane software, not a hosted multi-tenant product.
- Landscape diagnostics create reviewable artifacts; they do not directly mutate production ranking.
- MCP tools are the primary agent integration surface. REST API endpoints are primarily for the admin UI and local automation.
