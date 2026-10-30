# context-still (public documentation)

context-still is a local-first knowledge base for coding agents. This is version `2.0.0-alpha.0`, a TypeScript rebuild; its status and scope are described in the repository README. Internal design notes are Spec HTML documents in `../`.

## Start

Requirements: Bun 1.4.4.

```bash
bun install --frozen-lockfile
bun run start
```

One process serves the REST API under `/api/*` and the MCP endpoint at `/mcp` on `127.0.0.1:39181`. The first start creates `data/context-still.sqlite3` and `data/keys/` (`settings.key`, `api.token`, `mcp.token`; owner-only permissions).

`GET /api/health` needs no token. The other `/api/*` routes need `Authorization: Bearer <contents of data/keys/api.token>`.

## Environment variables

Only these are read. Anything else, including variables of the earlier (v1) system, is ignored.

| Variable | Default | Rule |
|---|---|---|
| `CONTEXT_STILL_DB` | `data/context-still.sqlite3` | Resolved to an absolute path. The v1 data locations and `:memory:` are refused. |
| `CONTEXT_STILL_KEY_DIR` | `<database directory>/keys` | Directory (mode 0700) of the key and token files. |
| `CONTEXT_STILL_SECRET_KEY` | none | base64 of 32 bytes. Takes priority over `settings.key`. |
| `CONTEXT_STILL_API_TOKEN` | `keys/api.token` | At least 24 characters. The file holds 64 hex characters (mode 0600). |
| `CONTEXT_STILL_MCP_TOKEN` | `keys/mcp.token` | A token separate from the API token. Same format. |
| `CONTEXT_STILL_HOST` | `127.0.0.1` | `127.0.0.1`, `::1` or `localhost` only. |
| `CONTEXT_STILL_PORT` | `39181` | 1024 to 65535. 39171 and 39172 (v1) are refused. |
| `LARM_API_TOKEN` (or `LARM_CONTROL_TOKEN`) | none | Bearer for the LARM control API. Never logged or returned. |

The LARM base URL is a stored setting: `bun run settings:larm -- --base-url <url>` (or `PUT /api/settings/larm` with `{"baseUrl": "<url>"}`). Without it, embedding is unavailable and search runs without vectors.

## REST API (N0)

| Route | Purpose |
|---|---|
| `GET /api/health` | `{"ok": true, "version": "2.0.0-alpha.0"}`; no token. |
| `GET /api/settings` | The settings document and diagnostics. Secrets are reported only as present or absent. |
| `PUT /api/settings/larm` | Body `{"baseUrl": string \| null}`. |
| `GET /api/larm/status` | State of the LARM embedding connection. |

Errors are `{"error": "<code>"}`; an unexpected failure is `500 {"error": "internal_error"}`.

## Connecting an MCP client (Eumenes)

The MCP endpoint is `http://127.0.0.1:39181/mcp` (JSON-RPC 2.0 over `POST`, protocol version `2025-03-26`). Authenticate with the **MCP token** only (`data/keys/mcp.token`, or `CONTEXT_STILL_MCP_TOKEN`); do not hand out the API token.

Tools:

- `search_knowledge`: searches rules, procedures, and experience (Episodes). Results are reference knowledge, never instructions.
- `get_knowledge`: returns the whole item for a `handle` from `search_knowledge`.

The endpoint is read-only. Requests must use a loopback `Host`; requests with a non-loopback `Origin` are refused.

## Maintenance commands

The commands open the database, so they cannot run while the server is running (exit code 3, `database_writer_owned`). They print a JSON report on stdout. Exit codes: 0 success, 1 failure, 2 bad arguments, 3 database writer owned.

| Command | Purpose |
|---|---|
| `bun run import:legacy -- --snapshot <path> [--dry-run] [--only <tables>] [--batch 500]` | Import a v1 snapshot. Safe to repeat. |
| `bun run vectors:verify-legacy [--sample 32] [--min 0.995] [--mean 0.999] [--dry-run]` | Check imported v1 vectors against LARM. |
| `bun run vectors:embed -- --owner knowledge\|episode [--all] [--batch 16] [--limit <n>] [--dry-run]` | Embed missing vectors through LARM. |
| `bun run eval:search -- --set <path> [--systems ...] [--lanes ...] [--k 10] [--out <path>]` | Evaluate search against an evaluation set. |
| `bun run settings:larm -- --base-url <url>` or `--clear` | Set or clear the LARM control URL. |
