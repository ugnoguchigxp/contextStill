# Desktop Readiness And Doctor States

## Purpose

Define the product-state baseline that future Tauri shell work should use. The desktop app should expose recoverable local states instead of leaking PostgreSQL-era setup assumptions or raw development errors.

## Backend Categories

| Category | Meaning | User-facing default |
|---|---|---|
| `sqlite-local` | SQLite local backend for desktop/local use | Default |
| `postgres-server` | PostgreSQL / pgvector backend for advanced server deployments | Advanced only |
| `compat-legacy` | Migration paths, aliases, and old command names | Compatibility only |

New work should name its backend target before implementation starts.

## Desktop Data Paths

Future Tauri packaging should resolve these under the app data/log locations supplied by Tauri:

| Data | Development fallback | Notes |
|---|---|---|
| SQLite DB | `./data/context-still-core.sqlite` | Controlled by `CONTEXT_STILL_SQLITE_CORE_PATH` in development |
| logs | `./logs/` | App logs and automation logs should not require a terminal |
| backups | `./backup/` | SQLite backups use `VACUUM INTO` |
| runtime settings | SQLite `settings` table | `.env` is development/advanced configuration |
| MCP registration metadata | app data path | Registration is explicit user action |
| source root | `./wiki` | Desktop can later offer user-selected source roots |

## First-Run State Machine

```text
start
  -> no_database
  -> database_needs_migration
  -> settings_incomplete
  -> ready_minimal
  -> optional_embedding_or_llm_setup
  -> optional_mcp_registration
```

Recoverable states:

| State | Doctor state | Recovery |
|---|---|---|
| no database | `Needs setup` | Create/open SQLite DB under app data |
| database exists but needs migration | `Needs setup` | Apply local migrations/bootstrap |
| settings incomplete | `Needs setup` or `Optional improvement` | Save required local settings; leave model setup optional |
| embedding unavailable | `Optional improvement` | Continue with text/fallback search or configure embedding |
| MCP not registered | `Optional improvement` | Offer registration action |
| server backend selected | `Advanced server backend only` | Show server diagnostics separately |

## Doctor Copy

Doctor should use user-action labels:

- `Ready`
- `Needs setup`
- `Optional improvement`
- `Advanced server backend only`

Avoid implementation-history labels in the default desktop path. In SQLite mode, missing PostgreSQL / pgvector must not be presented as a default failure. If server backend is selected, PostgreSQL / pgvector diagnostics are valid and should be clearly labeled as advanced server backend diagnostics.

## Desktop Smoke

`verify:desktop-readiness` should cover:

- docs link validation
- TypeScript compilation
- SQLite repository/runtime tests
- SQLite MCP smoke
- SQLite doctor smoke with `desktopReadiness.backendCategory = sqlite-local`
- no `VECTOR_EXTENSION_MISSING` reason in SQLite desktop doctor output

## Open Implementation Questions

1. Whether the first packaged desktop release includes distillation workers or starts with manual/imported knowledge plus compile/search.
2. Whether local LLM setup is first-run guided or an advanced settings flow.
3. Whether backup on upgrade is automatic, manual, or both.
4. Which admin UI pages are hidden until their backend support is SQLite-complete.
