# DB Session And Repository Decoupling Plan

## Current Problem

Repository and service modules currently import the module-global `db` or `getDb()` directly from `src/db/index.ts` / `src/db/client.ts`. This couples persistence logic to the current PostgreSQL pool singleton.

That coupling is manageable while PostgreSQL absorbs concurrency through pools, but it creates two concrete problems:

1. MCP, API, queue, and CLI processes each create their own pool after first DB use.
2. A future SQLite backend would not tolerate the same multi-process write pattern, because SQLite has one active writer.

The goal is not to rewrite all database code at once. The goal is to introduce a request/job-scoped DB session boundary, move write-heavy paths first, and make the backend implementation swappable later.

## Goals

- Keep repository code focused on SQL/Drizzle persistence.
- Move pool ownership, transaction boundaries, close behavior, backend selection, and write serialization outside repositories.
- Preserve the current PostgreSQL behavior while reducing direct dependency on the singleton `db`.
- Prepare for SQLite by making write boundaries explicit before introducing a SQLite adapter.
- Keep migration incremental and testable.

## Non-Goals

- Do not migrate to SQLite in this plan.
- Do not change schema semantics as part of the decoupling.
- Do not introduce a new ORM abstraction above Drizzle.
- Do not convert every repository in one large change.
- Do not make repositories return HTTP responses, Hono contexts, or MCP payloads.

## Target Shape

### DB Session Boundary

Introduce a narrow session module, for example `src/db/session.ts`.

```ts
export type DatabaseClient = ReturnType<typeof getDb>;

export type DatabaseSession = {
  db: DatabaseClient;
  mode: "read" | "write";
};

export async function withDbSession<T>(
  fn: (session: DatabaseSession) => Promise<T>,
): Promise<T>;

export async function withDbTransaction<T>(
  fn: (session: DatabaseSession) => Promise<T>,
): Promise<T>;
```

Initial PostgreSQL implementation may delegate to the existing `getDb()` and `db.transaction(...)`. The important change is that callers pass a session into repositories instead of repositories importing the singleton themselves.

### Repository Factory Pattern

Prefer repository factories for modules with multiple functions.

```ts
export function createContextCompilerRepository(session: DatabaseSession) {
  const { db } = session;

  return {
    listRecentCompileRuns(limit: number) {
      return db.select().from(contextCompileRuns).limit(limit);
    },
  };
}
```

For small modules, a function-level session parameter is acceptable.

```ts
export async function recordAuditEvent(session: DatabaseSession, input: AuditEventInput) {
  return session.db.insert(auditLogs).values(input);
}
```

### Entry Point Ownership

MCP, API routes, CLI commands, and queue workers should own the session boundary.

```ts
return withDbSession((session) =>
  createContextCompilerRepository(session).listRecentCompileRuns(20),
);
```

This keeps connection management out of repositories and makes tool-call/request/job scope visible.

## Slice 1: Add Session Infrastructure

### Changes

- Add `src/db/session.ts`.
- Define `DatabaseClient`, `DatabaseSession`, and transaction/session helpers.
- Keep `src/db/client.ts` as the PostgreSQL connection manager.
- Keep `src/db/index.ts` exports temporarily for compatibility.
- Add tests around session helper behavior with a mocked DB client.

### Acceptance Criteria

- Existing runtime behavior is unchanged.
- `withDbSession` returns values and propagates errors.
- `withDbTransaction` uses the underlying Drizzle transaction path.
- No production repository needs to be migrated in this slice.

### Verification

- `bun run typecheck`
- targeted session helper tests
- `bun run doctor`

## Slice 2: Move Context Compiler Persistence

### Why First

Context compiler is on the MCP hot path and writes `context_compile_runs`, `context_pack_items`, and candidate trace rows. It is also a good model for request/tool-call scoped session ownership.

### Target Files

- `src/modules/context-compiler/context-compiler.repository.ts`
- `src/modules/context-compiler/context-compile-eval.repository.ts`
- `src/modules/context-compiler/context-compile-task-trace.repository.ts`
- `src/modules/context-compiler/context-compiler.service.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/mcp/tools/compile-eval.tool.ts`

### Changes

- Convert repository exports to accept `DatabaseSession` or expose a factory.
- Move session creation into the service/tool layer.
- Keep transaction boundaries around multi-row writes.
- Avoid changing ranking, rendering, or retrieval logic.

### Acceptance Criteria

- Context compiler repositories no longer import `db` or `getDb()` directly.
- MCP `context_compile` and `compile_eval` still persist rows.
- Existing compile repository tests are updated to pass a session.

### Verification

- context compiler repository tests
- `bun run typecheck`
- `bun run doctor`
- MCP `context_compile` smoke

## Slice 3: Move Decision And Candidate Write Paths

### Target Files

- `src/modules/context-decision/context-decision.repository.ts`
- `src/modules/context-decision/context-decision.feedback.service.ts`
- `src/modules/registerCandidate/register-candidate.service.ts`
- `src/modules/registerCandidate/register-review-corrections.service.ts`
- `src/modules/knowledge/knowledge-feedback.service.ts`
- `src/modules/knowledge/knowledge-quality.service.ts`

### Changes

- Pass `DatabaseSession` through decision services.
- Convert transaction-heavy registration paths to `withDbTransaction`.
- Keep deterministic scoring and retrieval behavior unchanged.

### Acceptance Criteria

- Decision and candidate write paths do not create or access pools directly.
- Transaction boundaries are explicit at service/use-case level.
- Feedback and candidate registration tests still verify persisted side effects.

### Verification

- decision repository/service tests
- register candidate tests
- `bun run typecheck`
- MCP `context_decision`, `context_decision_feedback`, and `register_candidates` smoke

## Slice 4: Move Queue And Sync Writes

### Why This Matters For SQLite

Queue claiming and sync ingestion are high-risk for SQLite because they are write-heavy and can run from daemon processes. These paths need explicit write coordination before a SQLite adapter exists.

### Target Files

- `src/modules/queue/core/claim.ts`
- `src/modules/queue/core/events.ts`
- `src/modules/queue/core/state.ts`
- `src/modules/queue/core/worker.ts`
- `src/modules/agent-log-sync/sync.service.ts`
- `src/modules/settings/settings.repository.ts`

### Changes

- Add `withWriteSession` as an alias or wrapper around `withDbTransaction`.
- Route queue claim/state changes through `withWriteSession`.
- Keep queue behavior and priorities unchanged.
- Keep settings persistence behind session-aware repository functions.

### Acceptance Criteria

- Queue write paths have one visible write boundary per job/claim/update.
- Sync service no longer imports the singleton `db` directly.
- Settings repository can run through a provided session.

### Verification

- queue claim/state/events tests
- agent log sync service tests
- settings repository tests
- `bun run typecheck`
- `bun run doctor`

## Slice 5: Move Remaining Read-Heavy Repositories

### Target Areas

- landscape repositories
- graph and overview API repositories
- sources repositories
- memory reader and vibe memory repositories
- doctor inspectors

### Changes

- Convert read-heavy modules after write-heavy modules are stable.
- Prefer factory pattern where modules have many query functions.
- Keep API route response shaping outside repositories.

### Acceptance Criteria

- Production repository modules under `src/modules` and `api/modules` no longer import `db` or `getDb()` directly, except the DB/session infrastructure itself.
- Tests can inject sessions without mocking global module state.

### Verification

- `rg 'import \\{ db|getDb' src api` returns only allowed infrastructure and entrypoint imports.
- full unit test suite
- `bun run typecheck`
- `bun run doctor`

## Slice 6: SQLite Readiness Adapter

Do this only after repository decoupling is mostly complete.

### Changes

- Add a backend selection layer behind `src/db/session.ts`.
- Add SQLite driver wiring separately from PostgreSQL.
- Configure SQLite with:
  - `PRAGMA journal_mode=WAL`
  - `PRAGMA busy_timeout`
  - `PRAGMA foreign_keys=ON`
- Implement `withWriteSession` with write serialization for SQLite.
- Add a SQLite-only stress test for concurrent MCP-like writes.

### Acceptance Criteria

- PostgreSQL remains the default backend.
- SQLite adapter can run a limited repository test subset.
- Concurrent write stress does not produce unhandled `SQLITE_BUSY` failures.
- Write retry/serialization is in the session layer, not inside repositories.

### Verification

- SQLite repository smoke tests
- concurrent write stress test
- PostgreSQL test suite still passes
- `bun run doctor` against PostgreSQL remains unchanged

## Implementation Order

1. Add `src/db/session.ts` without moving repositories.
2. Convert context compiler repositories and MCP tools.
3. Convert context decision and candidate registration write paths.
4. Convert queue, sync, audit, and settings write paths.
5. Convert remaining read-heavy repositories.
6. Add SQLite adapter and concurrency tests.

## Start Here

Start with the context compiler path because it is MCP-visible, read/write mixed, and already central to observed connection behavior.

First checkpoint:

- `src/db/session.ts` exists.
- `context-compiler.repository.ts` no longer imports `db`.
- `context_compile` still persists a run and pack items.
- `bun run typecheck` passes.
- `bun run doctor` reports DB reachable.

## Open Questions

- Should MCP read-only tools use a lighter read session that does not open a transaction?
- Should write sessions be serialized only for SQLite, or should some queue writes be serialized for PostgreSQL too?
- Should audit logging be best-effort outside the main transaction or included in the same write boundary?
- Should repository tests use a fake session object or integration DB fixtures by default?

## Operational Notes

- Current PostgreSQL local runtime can support higher connection counts, but that does not solve the architectural coupling.
- `application_name` should remain on PostgreSQL pools so `pg_stat_activity` can identify process owners.
- Long-lived MCP processes should not be the owner of connection policy. Tool-call/request/job scope should own DB session boundaries.
