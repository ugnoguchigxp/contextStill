# REST API Reference

The REST API is served under `/api/*`. It primarily supports the local admin UI and local automation.

If `CONTEXT_STILL_ADMIN_API_KEY` is configured, requests under `/api/*` must include the configured admin key according to the admin UI/API client behavior.

## Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Basic health |
| `GET` | `/api/health/live` | Liveness probe |
| `GET` | `/api/health/ready` | Readiness probe |

## Context Compile

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/context/compile` | Compile a context pack |
| `GET` | `/api/context/runs` | List compile runs |
| `GET` | `/api/context/runs/:id` | Get compile run detail |
| `GET` | `/api/context/runs/:id/ranking-trace` | Get ranking trace for a run |
| `POST` | `/api/context/runs/:id/knowledge-feedback` | Record per-knowledge usage feedback |

## Knowledge

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/knowledge` | List and search knowledge |
| `POST` | `/api/knowledge` | Create knowledge |
| `POST` | `/api/knowledge/bulk-status` | Bulk promote/deprecate items |
| `PUT` | `/api/knowledge/:id` | Update knowledge |
| `POST` | `/api/knowledge/:id/feedback` | Record direct feedback |
| `DELETE` | `/api/knowledge/:id` | Delete knowledge |
| `GET` | `/api/knowledge/tags` | List tag definitions |

## Sources

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/sources/health` | Source repository health |
| `GET` | `/api/sources/tree` | Wiki tree |
| `GET` | `/api/sources/search` | Search source pages |
| `POST` | `/api/sources/reindex` | Rebuild source fragments |
| `POST` | `/api/sources/web` | Queue one URL for web ingest |
| `POST` | `/api/sources/web/bulk` | Queue up to 1000 URLs |
| `POST` | `/api/sources/web/upload` | Extract URLs from an uploaded file |
| `GET` | `/api/sources/folders` | List folders |
| `POST` | `/api/sources/folders` | Create folder |
| `PUT` | `/api/sources/folders/*` | Rename folder |
| `DELETE` | `/api/sources/folders/*` | Delete folder |
| `POST` | `/api/sources/pages` | Create page |
| `GET` | `/api/sources/pages/*` | Read page |
| `PUT` | `/api/sources/pages/*` | Update page |
| `DELETE` | `/api/sources/pages/*` | Delete page |
| `GET` | `/api/sources/history/*` | Page Git history |
| `GET` | `/api/sources/diff/*` | Page diff |

## Vibe Memory and Session Memo

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/vibe-memory` | List memories |
| `POST` | `/api/vibe-memory` | Create memory |
| `GET` | `/api/vibe-memory/context` | Get contextual memory view |
| `GET` | `/api/vibe-memory/goals` | List goal rooms |
| `GET` | `/api/vibe-memory/:id` | Read memory |
| `DELETE` | `/api/vibe-memory/:id` | Delete memory |
| `POST` | `/api/vibe-memory/reply` | Reply to a memory capsule |
| `POST` | `/api/vibe-memory/mark` | Mark memory status |
| `GET` | `/api/session-memo` | List legacy session memos |
| `GET` | `/api/session-memo/item` | Fetch one legacy memo |
| `POST` | `/api/session-memo` | Write legacy memo |

## Graph and Landscape

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/graph` | Graph data |
| `GET` | `/api/graph/nodes/:id` | Graph node detail |
| `GET` | `/api/graph/community-labels` | List community labels |
| `PUT` | `/api/graph/community-labels/:communityKey` | Update community label |
| `GET` | `/api/graph/landscape` | Landscape snapshot |
| `GET` | `/api/graph/landscape/cache-status` | Landscape cache status |
| `GET` | `/api/graph/landscape/replay` | Replay diagnostics |
| `GET` | `/api/graph/landscape/replay/compare` | Baseline/current comparison |
| `POST` | `/api/graph/landscape/replay/queue` | Materialize review items |
| `GET` | `/api/graph/landscape/review-items` | List review items |
| `POST` | `/api/graph/landscape/review-items/candidates` | Create candidate drafts |
| `PATCH` | `/api/graph/landscape/review-items/:id` | Resolve/dismiss review item |
| `PATCH` | `/api/graph/landscape/review-items/:id/candidate-links/:linkId` | Approve/reject candidate link |

## Queue, Candidates, Audit, Doctor, Settings

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/queue` | List distillation targets |
| `GET` | `/api/queue/stats` | Queue stats |
| `GET` | `/api/queue/active` | Active target states |
| `POST` | `/api/queue/:id/pause` | Pause target |
| `POST` | `/api/queue/:id/resume` | Resume target |
| `POST` | `/api/queue/:queue/:id/resume` | Resume target in a specific queue |
| `POST` | `/api/queue/:id/retry` | Retry target |
| `GET` | `/api/candidates` | List candidates |
| `POST` | `/api/candidates/:id/premium-reprocess` | Reprocess candidate through premium coverage |
| `GET` | `/api/audit-logs` | Audit log timeline |
| `GET` | `/api/agent-diffs` | Agent diff entries |
| `GET` | `/api/overview` | Overview metrics |
| `GET` | `/api/overview/domains/:domain` | Domain-specific overview |
| `GET` | `/api/doctor` | Full doctor report |
| `GET` | `/api/doctor/domains/:domain` | Domain-specific doctor report |
| `GET` | `/api/settings` | Runtime settings |
| `PUT` | `/api/settings` | Update runtime settings |
| `POST` | `/api/settings/providers/:provider/test` | Test provider |
| `GET` | `/api/settings/providers/codex/auth/status` | Codex auth status |
| `POST` | `/api/settings/providers/codex/auth/login-command` | Generate Codex login command |
| `POST` | `/api/settings/reload-runtime-cache` | Reload runtime settings cache |
