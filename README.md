# context-still

Local-first knowledge base for coding agents and Eumenes. Version `2.0.0-alpha.0`: a TypeScript (Bun + Hono + SQLite) rebuild of the v1 system.

## Status

This repository is at stage **N0 (skeleton) / N1 (ingest and search)** of the v2 rebuild. The design is in [`spec/docs/contextstill-v2-n0-n1-implementation-plan.html`](spec/docs/contextstill-v2-n0-n1-implementation-plan.html).

- N0 (done): single-writer SQLite store with a migration list, settings and secrets, API/MCP tokens, the LARM embedding connection, a job queue (no handlers yet), vector storage, and the schemas of every N1 domain.
- N1 (in progress): import from a v1 snapshot, trigram full-text search, vectors, hybrid search (RRF), an MCP endpoint for Eumenes (`search_knowledge`, `get_knowledge`), and an evaluation runner against the v1 lexical scorer.
- Not built yet: canonical knowledge, themes, distillation, `context_compile`, the web UI.

The v1 system lives on the `legacy/v1` branch and in `~/Code/contextStill-legacy`. v2 never opens the live v1 database (a snapshot is read read-only), and it refuses v1's ports (39171, 39172) and paths.

## Requirements

Bun 1.4.4. No Rust, no PostgreSQL, no Docker.

```bash
bun install --frozen-lockfile
bun run verify
```

## Running

```bash
bun run start    # one process: API under /api/*, MCP at /mcp, on 127.0.0.1:39181
```

The server owns the SQLite writer. Maintenance commands open the database too, so they cannot run while the server is up (exit code 3, `database_writer_owned`).

| Command | Purpose |
|---|---|
| `bun run settings:larm -- --base-url <url>` / `--clear` | Set the LARM control URL |
| `bun run import:legacy -- --snapshot <path>` | Import a v1 snapshot (idempotent) |
| `bun run vectors:verify-legacy` | Check imported v1 vectors against LARM |
| `bun run vectors:embed -- --owner knowledge\|episode` | Embed missing vectors through LARM |
| `bun run eval:search -- --set <path>` | Compare v2 search with the v1 lexical scorer |

Exit codes: 0 success, 1 failure, 2 bad arguments, 3 database writer owned. Commands print a JSON report on stdout.

## Configuration

The only environment variables read (see `api/application/config.ts`); everything else, including v1 variables, is ignored.

| Variable | Default | Rule |
|---|---|---|
| `CONTEXT_STILL_DB` | `data/context-still.sqlite3` | Absolute after resolution; v1 locations are refused |
| `CONTEXT_STILL_KEY_DIR` | `<DB dir>/keys` | Holds `settings.key`, `api.token`, `mcp.token` (0700) |
| `CONTEXT_STILL_SECRET_KEY` | none | base64, 32 bytes; wins over `settings.key` |
| `CONTEXT_STILL_API_TOKEN` | `keys/api.token` | 24+ characters |
| `CONTEXT_STILL_MCP_TOKEN` | `keys/mcp.token` | 24+ characters; the only token Eumenes gets |
| `CONTEXT_STILL_HOST` | `127.0.0.1` | Loopback only |
| `CONTEXT_STILL_PORT` | `39181` | 1024-65535; 39171 and 39172 are refused |
| `LARM_API_TOKEN` (or `LARM_CONTROL_TOKEN`) | none | Bearer for the LARM control API |

The LARM base URL is a setting stored in the database, not an environment variable.

## Layout

```
api/infrastructure   store, locks, digests, handles, time, vectors, auth tokens
api/application      config, runtime, app, server, migrations, commands/
api/domains/<name>   index.ts contracts/ service/ repository/ controller/ test/
scripts              verify, boundaries, domain table, test preload
eval/sets            evaluation sets (JSONL)
data/                runtime database and keys (git-ignored)
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). `bun run verify` runs format check, lint, typecheck, domain boundaries, tests, and the Spec HTML check.

## License

MIT, see [LICENSE](LICENSE).
