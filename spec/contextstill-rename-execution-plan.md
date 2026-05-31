# contextStill Rename Execution Plan

この計画は、現行 `memoryRouter` / `memory-router` / `memory_router` / `MEMORY_ROUTER_*` ブランドを `contextStill` へ全面移行するための実行計画である。

`contextStill` は表示名として扱う。コード・運用面では次の表記を使い分ける。

| Surface | New Name | Current Examples |
|---|---|---|
| Product display | `contextStill` | `memoryRouter`, `memory-router` |
| Package / CLI / service | `context-still` | `memory-router` |
| Type / class prefix | `ContextStill` | `MemoryRouter` |
| Env var prefix | `CONTEXT_STILL_*` | `MEMORY_ROUTER_*` |
| DB / volume / snake case | `context_still` | `memory_router` |
| Domain | `contextstill.com` | GitHub Pages `/memoryRouter` |
| MCP resource URI | `context-still://...` | `memory-router://...` |

## 1. Current Impact Summary

Live repo scan shows old naming across these areas:

| Area | Current Findings | Rename Risk |
|---|---|---|
| Package / CLI | `package.json` name is `memory-router`; bin and npm script expose `memory-router`; CLI file is `src/cli/memory-router.ts`. | Published CLI users and MCP client config can break if aliases are removed immediately. |
| MCP server | `src/mcp/server.ts` publishes server name `memory-router` and resource URIs like `memory-router://packs/latest`. | MCP clients and tests depend on the URI scheme. Needs alias window. |
| Environment variables | `MEMORY_ROUTER_*` appears across config, onboarding, tests, docs, scripts, and GitHub Actions. | Existing `.env`, CI, LaunchAgents, and local automations break without fallback. |
| Database / Docker | Defaults use `memory_router`, `memory_router_test`, `memory-router-db`, `memory_router_pgdata`. | Renaming DB/volume can orphan existing local data unless migrated or documented. |
| API / Admin UI | Health service names and admin storage keys use `memory-router` / `memory_router`. | Mostly internal, but browser localStorage and dashboards may lose saved state. |
| Automation | LaunchAgent labels and Windows task paths use `com.memory-router.*` and `\\memory-router\\...`. | Old scheduled jobs can keep running unless uninstall/migration is handled. |
| GitHub / website | README, badges, canonical URLs, Jekyll `baseurl: /memoryRouter`, generated docs, sitemap, SEO checklist, and GitHub links use old repo/page path. | Domain cutover requires canonical, sitemap, redirects, and Search Console updates. |
| Tests / fixtures | Many tests assert old names and env vars. | Tests should encode alias behavior intentionally, not preserve stale names accidentally. |
| Historical docs / seeds | `spec/`, generated `github-pages/docs`, and `src/db/seeds/knowledge-seed.json` contain old names. | Decide whether historical references are rewritten or retained as archived history. |

## 2. Migration Policy

### 2.1 Replace Immediately

These should move directly to `contextStill` naming in the first implementation pass:

- README, README.jp, user-facing UI labels, product descriptions, badges, website copy.
- `package.json` package name and primary script name.
- Primary CLI binary: `context-still`.
- MCP server display name: `context-still`.
- API health service names: `context-still-api`.
- Admin UI brand label.
- Docker service/container/volume defaults for new installs.
- GitHub Pages/Jekyll source and generated docs.
- Automation templates for new installs.
- Error class names, tests, and source comments that refer to the old brand.

### 2.2 Keep Temporary Compatibility Aliases

The old names should remain callable for one deprecation window, but should be hidden from new docs where possible:

- CLI alias: keep `memory-router` bin and npm script as an alias to `context-still`.
- MCP resource alias: accept `memory-router://...` while publishing `context-still://...` as canonical.
- Env var fallback: read `CONTEXT_STILL_*` first, then `MEMORY_ROUTER_*`.
- `.env` writer: write only `CONTEXT_STILL_*` for new setup, but preserve existing `MEMORY_ROUTER_*` unless explicitly migrated.
- DB URL default: new default should be `context_still`; integration default should be `context_still_test`. Tests must still allow explicit old `DATABASE_URL`.
- Automation uninstall/migration: new labels are `com.context-still.*`; uninstall commands should know how to remove old `com.memory-router.*` jobs.
- Browser storage: read old `memory_router_admin_api_key` once, then write `context_still_admin_api_key`.

### 2.3 Acceptable Remaining Old Names

After implementation, `rg` may only find old names in:

- Explicit compatibility alias code and tests.
- Migration documentation/changelog that explains the rename.
- Historical data fixtures where the old name is the subject being tested.
- Git history, lockfile generated metadata if unavoidable, and user-owned external data.

Everything else should be treated as a missed rename.

## 3. Execution Slices

### Slice 0: Freeze Decisions And Protect Current Worktree

1. Confirm whether the GitHub repository itself will be renamed from `memoryRouter` to `contextStill`.
2. Confirm whether `contextstill.com` becomes the canonical public site immediately, or whether GitHub Pages remains a transitional mirror.
3. Record current dirty worktree before editing:
   - `git status --short`
   - Do not overwrite unrelated in-progress changes.
4. Create a focused branch, for example `codex/contextstill-rename`.

Completion criteria:

- Naming table above is accepted.
- Repository/domain cutover direction is known.
- Existing unrelated local changes are not touched.

### Slice 1: Centralize Naming Constants And Compatibility Helpers

Add a single source of truth for project naming:

- `src/project-identity.ts` or equivalent:
  - `displayName = "contextStill"`
  - `packageName = "context-still"`
  - `envPrefix = "CONTEXT_STILL"`
  - `legacyEnvPrefix = "MEMORY_ROUTER"`
  - `mcpUriScheme = "context-still"`
  - `legacyMcpUriScheme = "memory-router"`

Add helpers:

- `readProjectEnv(key)` reads `CONTEXT_STILL_${key}` first, then `MEMORY_ROUTER_${key}`.
- `projectEnvKeys` lists canonical env keys.
- `normalizeMcpResourceUri(uri)` maps legacy `memory-router://` to canonical handling.

Then update config/onboarding code to use helpers before broad text replacement:

- `src/config.ts`
- `src/config.types.ts`
- `src/modules/onboarding/env-writer.ts`
- `src/modules/onboarding/startup-prompts.ts`
- `src/modules/onboarding/setup.service.ts`
- `src/mcp/tools/index.ts`
- `src/mcp/tools/system.tool.ts`

Completion criteria:

- New env vars work.
- Old env vars still work.
- New setup writes only `CONTEXT_STILL_*`.
- Tests prove canonical priority when both old and new env vars are set.

### Slice 2: Rename Runtime Surfaces

Update primary runtime identities:

- `package.json`
  - `"name": "context-still"`
  - `"bin": { "context-still": "./src/cli/context-still.ts", "memory-router": "./src/cli/context-still.ts" }`
  - Replace script `"memory-router"` with `"context-still"` and keep `"memory-router"` alias temporarily.
- Rename `src/cli/memory-router.ts` to `src/cli/context-still.ts`.
- Update CLI usage text from `memory-router ...` to `context-still ...`.
- Update `src/index.ts` startup error prefix.
- Update `src/mcp/server.ts`:
  - server name `context-still`
  - canonical resources `context-still://...`
  - legacy `memory-router://...` accepted by read handler.
- Update API service identity and auth realm:
  - `context-still-api`
  - `ApiKey realm="context-still-admin"`.
- Update Admin UI visible brand.

Completion criteria:

- `bun run context-still -- --help` or equivalent CLI smoke succeeds.
- `bun run memory-router ...` still works as deprecated alias.
- `context-still://packs/latest` and `memory-router://packs/latest` both resolve, with docs using only canonical URI.

### Slice 3: Rename Persistence, Docker, CI, And Automation

Update new-install defaults:

- `docker-compose.yml`
  - service/container: `context-still-db`
  - database: `context_still`
  - volume: `context_still_pgdata`
- `drizzle.config.ts`
  - default DB: `context_still`
- `package.json`
  - test DB defaults: `context_still_test`
- `.github/workflows/verify.yml`
  - `POSTGRES_DB=context_still_test`
  - `DATABASE_URL=.../context_still_test`
  - `CONTEXT_STILL_RUN_DB_TESTS=1`
- Backup/export scripts:
  - default container `context-still-db`
  - default DB `context_still`
  - old names supported by explicit override only.
- Automation:
  - plist names `com.context-still.agent-log-sync.plist`, `com.context-still.queue-supervisor.plist`
  - labels `com.context-still.*`
  - Windows task path `\\context-still\\...`
  - uninstall path handles both old and new labels.

Data migration should be explicit, not automatic:

1. Existing users either keep their old `DATABASE_URL` and continue to run against `memory_router`, or migrate manually.
2. Provide `scripts/migrate-local-db-name.sh` only if needed:
   - backup old DB.
   - create `context_still`.
   - restore dump.
   - update `.env`.
3. Do not rename Docker volumes destructively.

Completion criteria:

- Fresh `docker compose up -d` creates `context_still`.
- CI uses `context_still_test`.
- Existing deployments can opt out by keeping explicit `DATABASE_URL`.

### Slice 4: Rename Public Docs, Website, And Domain

Update source docs and generated site:

- `README.md`
- `README.jp.md`
- `LICENSE`
- `hooks.json.example`
- `docs/`
- `spec/` active plans, except historical sections that intentionally discuss the old name.
- `github-pages/_config.yml`
- `github-pages/site/index.md`
- `github-pages/site/site.webmanifest`
- `github-pages/docs/` generated artifacts after rebuild.
- `github-pages/SEO_CHECKLIST.md`
- `github-pages/README.md`
- `github-pages/scripts/run-lighthouse.sh`

Domain plan:

1. Make `https://contextstill.com/` canonical.
2. Add/confirm DNS and hosting target.
3. Update canonical URLs, Open Graph URLs, JSON-LD, sitemap, robots, manifest scope/start URL.
4. Keep GitHub Pages as redirect or mirror if repository hosting still requires it.
5. Add Search Console property for `contextstill.com`.
6. Submit `https://contextstill.com/sitemap.xml`.

Completion criteria:

- Website source builds with canonical `contextstill.com`.
- No public docs point users to `/memoryRouter` as primary.
- GitHub links point to the renamed repository if the repo rename is completed.

### Slice 5: Tests And Fixture Updates

Update tests in two groups:

1. Canonical behavior tests:
   - assert `CONTEXT_STILL_*`.
   - assert `context-still://`.
   - assert `context-still` CLI and service names.
2. Compatibility tests:
   - old env vars still load as fallback.
   - old MCP resource URIs still resolve.
   - old CLI alias still dispatches.
   - old browser localStorage key migrates.

High-priority test files from scan:

- `test/mcp-server.test.ts`
- `test/mcp.tools.test.ts`
- `test/mcp.contract.test.ts`
- `test/startup-env-writer.test.ts`
- `test/startup-doctor-loop.test.ts`
- `test/init-project.test.ts`
- `test/errors.test.ts`
- `test/helpers/integration.ts`
- `test/api.routes.system.test.ts`
- `web/src/smoke.test.ts`

Completion criteria:

- Tests no longer assert old names except in explicit compatibility cases.
- Compatibility cases are named with `legacy` or `deprecated alias`.

### Slice 6: Final Sweep And Release Notes

Run exhaustive searches:

```sh
rg -n "memoryRouter|memoryrouter|MemoryRouter|memory-router|memory router|Memory Router|MEMORY_ROUTER|memory_router|memory-router://"
rg -n "contextStill|context-still|ContextStill|CONTEXT_STILL|context_still|context-still://"
```

Classify every remaining old-name hit:

- `compatibility alias`: allowed.
- `historical archive`: allowed.
- `missed rename`: fix.
- `external URL awaiting repo/domain cutover`: track before release.

Add release notes:

- New name: `contextStill`.
- New CLI: `context-still`.
- New env vars: `CONTEXT_STILL_*`.
- Old CLI/env/MCP URI are deprecated aliases for one release window.
- DB rename is not automatic; existing `DATABASE_URL` keeps working.
- New domain: `contextstill.com`.

Completion criteria:

- Final old-name allowlist is short and intentional.
- Release notes include migration steps.
- No generated artifact is stale.

## 4. Verification Commands

Run these after each relevant slice:

```sh
bun install
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run build:web
```

Run MCP and DB checks after Slice 2 and Slice 3:

```sh
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still_test} bun run db:migrate
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still_test} bun run test:mcp:contract
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still_test} bun run mcp:smoke
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/context_still_test} bun run doctor
```

Run website checks after Slice 4:

```sh
bun run lp:optimize-image
bun run lp:lighthouse
rg -n "memoryRouter|memory-router|/memoryRouter|ugnoguchigxp.github.io/memoryRouter" github-pages
```

Expected results:

- Typecheck, lint, format, unit tests, and web build pass.
- MCP contract exposes canonical resources and keeps legacy resource reads working.
- Doctor succeeds or reports only environment-specific external service issues.
- Website canonical URLs use `https://contextstill.com/`.

## 5. Rollback Strategy

- Code rollback is normal Git revert.
- Existing user data is protected because DB rename is not automatic.
- Users who keep `DATABASE_URL=.../memory_router` continue using the old DB name.
- Automation migration must uninstall old jobs only after new jobs are installed and verified.
- Keep old env fallback until a later cleanup release.

## 6. Open Decisions

Before implementation, decide:

1. Should the GitHub repository be renamed to `contextStill`, `context-still`, or another exact spelling?
2. Should the npm package name be public/unscoped `context-still` or scoped, for example `@contextstill/context-still`?
3. Should `contextstill.com` host docs directly, or should it redirect to GitHub Pages during the first release?
4. How long should `memory-router` CLI, `MEMORY_ROUTER_*`, and `memory-router://` aliases remain?
5. Should historical evaluation/spec documents be rewritten, or left as historical records with a short rename note?
