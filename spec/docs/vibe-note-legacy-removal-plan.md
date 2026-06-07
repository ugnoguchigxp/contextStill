# Vibe Note Legacy Removal Plan

Status: implemented through runtime/API/UI removal; physical DB cleanup deferred
Updated: 2026-06-07

## Decision

Deprecate and remove Vibe Note / Goal Room Memory as a coordination surface.

Vibe Note currently means the `vibe_memory_say` family of MCP tools, the Goal Room / Capsule API surface, and the `/vibe-note` admin UI. Its intended role was multi-agent coordination: shared notes, open loops, wants, decisions, marks, and brief generation. In practice this does not justify asking coding agents to spend LLM tokens authoring extra capsules. Durable lessons should continue to use `register_candidate` / `register_candidates`, and work state should remain owned by product/runtime tables such as NightWorkers Todo/queue state.

The removal must not damage Vibe Memory. Vibe Memory is the raw agent-log memory layer backed by `vibe_memories` chat rows, agent diff entries, search, reader, and distillation/finding candidate workflows.

Implementation note: the Vibe Note UI, MCP tools, Capsule API routes, Goal Room service behavior, schemas, tests, and active docs have been removed. The historical DB tables/columns and existing capsule rows remain intentionally preserved.

## Vocabulary

- Vibe Memory: raw agent-log memories and their downstream use.
- Vibe Note: Goal Room / Capsule coordination layer built on top of `vibe_memories.memory_type = 'capsule'`.
- Capsule: a row inserted by `vibe_memory_say` / API `/api/vibe-memory/record`.
- Mark: status metadata for Capsules in `vibe_memory_marks`.
- Goal Room: grouping metadata in `vibe_goals`.

## Keep

These are Vibe Memory responsibilities and must not be removed in this effort.

- `vibe_memories` table itself.
- `memory_type = 'chat'` rows from agent log sync.
- `agent_diff_entries`.
- `/api/vibe-memory` list/create/delete routes for raw memories, except the Capsule-specific routes listed below.
- Vibe Memory admin page at `/vibe-memory`.
- `recordVibeMemoryWithDiffEntries`.
- `searchVibeMemories` and `retrieveVibeMemoryContext` when used for non-Goal-Room lookup.
- `readVibeMemoryByTokenWindow`.
- findCandidate support for `targetKind = 'vibe_memory'`.
- distillation target inventory and queue processing for raw Vibe Memory.
- knowledge source links and metadata fields such as `sourceVibeMemoryIds`.

## Remove

These are the Vibe Note / Goal Room surfaces.

- Web route `/vibe-note`.
- `web/src/modules/admin/components/vibe-note.page.tsx`.
- app-shell navigation entry labeled `Vibe Note`.
- Vibe Memory page link to `/vibe-note`.
- Vibe Note CSS blocks such as `.vibe-note-*` and Goal Room dashboard-only styles.
- Admin repository types and functions that only serve Goal Room/Capsule UI:
  - `VibeGoal`
  - `VibeMemoryMark`
  - `VibeMemoryCapsule`
  - `VibeMemoryContextPack` if no remaining non-Goal-Room caller needs it
  - `fetchVibeGoals`
  - `fetchVibeMemoryContext` only if MCP/API Goal Room context is removed and no raw memory lookup depends on it
  - `postMarkVibeMemory`
  - `postRecordVibeMemoryCapsule`
- MCP tools:
  - `vibe_memory_say`
  - `vibe_memory_reply`
  - `vibe_memory_peek`
  - `vibe_memory_mark`
- MCP exports/registration for those tools in `src/mcp/tools/index.ts`.
- Initial instructions that require agents to call `vibe_memory_peek` and post Capsules.
- Public MCP docs that describe Goal Room Memory as the normal workflow.
- Public API docs that describe Goal Room/Capsule routes:
  - `spec/pub/api.md`
  - Note: current docs appear stale around Capsule routes. The code has `POST /api/vibe-memory/record`; the public API doc lists `POST /api/vibe-memory/reply`, but no matching route was observed during review.
- Old internal design docs/index entries that still make Vibe Note look active:
  - `spec/docs/vibe-note-session-memo-design.md`
  - `spec/docs/README.md`
- API routes:
  - `GET /api/vibe-memory/context` if it is only Goal Room brief/open-loop context
  - `GET /api/vibe-memory/goals`
  - `POST /api/vibe-memory/record`
  - `POST /api/vibe-memory/reply` if present
  - `POST /api/vibe-memory/mark`
- Goal Room/Capsule service functions:
  - `recordVibeMemoryCapsule`
  - `markVibeMemory`
  - Goal Room brief/open-loop retrieval logic if no raw Vibe Memory caller remains
  - `listVibeGoals`
- Goal Room/Capsule schemas:
  - `recordVibeMemoryCapsuleInputSchema`
  - `markVibeMemoryInputSchema`
  - Capsule-only types.
- Tests that exist only for Goal Room/Capsule behavior, including:
  - `test/vibe-memory.integration.test.ts` Goal Room/Capsule service coverage.
  - `test/components/admin/vibe-note-page.test.tsx` Vibe Note UI coverage.
  - Capsule-specific assertions in `test/api.routes.integration.test.ts`.

## Data Policy

Do not drop DB columns/tables in the first implementation.

Phase 1 should stop new writes and hide the surfaces. Existing Capsule data can remain as inert historical rows. This avoids accidental damage to `vibe_memories`, which is also the raw Vibe Memory table.

Recommended first migration policy:

- Keep `vibe_goals`.
- Keep `vibe_memory_marks`.
- Keep capsule columns on `vibe_memories`: `goal_id`, `parent_id`, `subject`, `intent`, `wants`, `refs`, `confidence`, `evidence_status`, `actor_id`, `ttl_at`.
- Keep existing `memory_type = 'capsule'` rows.
- Ensure raw Vibe Memory list/API continues excluding capsules where appropriate.

Only consider physical cleanup in a later major migration after export/backfill and after proving no runtime code reads Goal Room/Capsule data.

## Replacement Behavior

Use existing purpose-built surfaces instead of Vibe Note.

- Coordination/task state: product-owned runtime state, such as NightWorkers Todo/queue/review tables.
- Durable reusable lessons: `register_candidate` / `register_candidates`.
- Compile result evaluation: `compile_eval`.
- Short-lived scratch state: `session_memo`, if retained as an internal scratchpad.
- Evidence and raw history: Vibe Memory raw agent logs.

The new guidance should not ask agents to create coordination notes unless a replacement explicit tool exists.

## Phased Plan

### Phase 0: Inventory and Freeze

Goal: prove the exact deletion boundary before modifying behavior.

Tasks:

1. Capture live counts:
   - `vibe_memories` by `memory_type`.
   - `vibe_goals` count.
   - `vibe_memory_marks` count.
   - MCP exposed tool list.
2. Confirm current raw Vibe Memory routes exclude capsules from the raw session UI.
3. Add a short deprecation note to internal docs stating Vibe Note is frozen and should not be expanded.

Verification:

- `bun run doctor`
- DB count query output saved in the task notes or final report.
- No code path changed yet.

### Phase 1: Stop Agent Prompt Pressure

Goal: remove the instruction that makes agents spend tokens on Capsule creation.

Tasks:

1. Edit `src/shared/locales/initial-instructions.ts`.
2. Remove mandatory `vibe_memory_peek` startup guidance.
3. Remove guidance to immediately call `vibe_memory_say` / `reply` / `mark`.
4. Keep `context_compile`, `compile_eval`, and `register_candidate(s)` guidance.
5. Update `spec/pub/mcp-tools.md` recommended workflow to remove Goal Room Memory.
6. Update `spec/pub/api.md` so it no longer advertises Goal Room/Capsule API routes, and correct any stale route inventory while doing so.
7. Mark `spec/docs/vibe-note-session-memo-design.md` as historical or remove it from the active docs index.
8. Update `spec/docs/README.md` so Vibe Note design docs are not presented as current architecture.
9. Fix `scripts/post-commit-candidate-reminder.sh` wording that refers to Vibe Note compile results if it no longer reflects reality.

Verification:

- `bun run src/cli/doctor.ts` shows no missing primary tools after instruction changes.
- MCP public docs no longer say `initial_instructions -> vibe_memory_peek -> ...`.
- Public API docs no longer list Goal Room/Capsule routes as supported active APIs.
- Search for `vibe_memory_say`, `Goal Room`, `Capsule`, and `Vibe Note` in instruction/doc surfaces.

### Phase 2: Hide UI

Goal: remove Vibe Note from the user-facing admin UI while keeping Vibe Memory intact.

Tasks:

1. Remove `/vibe-note` route from `web/src/App.tsx`.
2. Remove `Vibe Note` nav entry from `web/src/modules/admin/components/app-shell.tsx`.
3. Remove the link from `web/src/modules/admin/components/vibe-memory.page.tsx` to `/vibe-note`.
4. Delete `web/src/modules/admin/components/vibe-note.page.tsx`.
5. Delete Vibe Note-only component tests, especially `test/components/admin/vibe-note-page.test.tsx`.
6. Remove unused repository methods and types only after TypeScript confirms no callers.
7. Remove Vibe Note-only CSS blocks.

Guardrails:

- Do not modify `/vibe-memory` route behavior except removing its link to Vibe Note.
- Do not change `visibleMemories = memories.filter(memoryType !== 'capsule')` unless a test explicitly covers the replacement behavior.

Verification:

- `bun run typecheck`
- Targeted UI tests for `VibeMemoryPage`.
- `rg -n "vibe-note|VibeNote|Vibe Note" web test spec src`
- Manual browser smoke if a dev server is already in use for admin UI work.

### Phase 3: Deprecate MCP Tools

Goal: remove the coordination tools from the exposed MCP surface.

Tasks:

1. Remove `vibeMemorySayTool`, `vibeMemoryReplyTool`, `vibeMemoryPeekTool`, and `vibeMemoryMarkTool` from `src/mcp/tools/index.ts`.
2. Decide whether to keep `src/mcp/tools/vibe-memory.tool.ts` temporarily as dead code for one release or delete it immediately.
3. Update MCP contract tests and smoke tests to remove these tools from expected tool lists.
4. Update `spec/pub/mcp-tools.md` inventory and workflow.

Compatibility option:

- If external clients may still call these names, keep stubs for one release that return a clear deprecation error and do not write DB rows.
- If this is local-only and all clients are controlled, remove the tools outright.

Recommended choice:

- Remove from exposed tool lists immediately.
- Avoid stubs unless a known external client breaks.

Verification:

- `bun run test:mcp:contract`
- `bun run mcp:smoke`
- `bun run doctor`
- Search exposed tool output for removed names.

### Phase 4: Remove API and Service Code

Goal: delete Goal Room/Capsule backend behavior after UI and MCP no longer use it.

Tasks:

1. Remove Capsule-specific API routes from `api/modules/vibe-memory/vibe-memory.routes.ts`.
2. Delete or split service functions in `src/modules/vibe-memory/vibe-memory.service.ts`:
   - Keep raw memory recording/search behavior.
   - Remove Goal Room brief/open-loop pipeline if no non-UI caller remains.
3. Remove schema definitions that only validate Capsule/Mark inputs.
4. Remove Goal Room/Capsule integration tests.
5. Keep raw Vibe Memory API tests, especially the assertion that raw sessions do not show capsules if historical rows remain.
6. Update `test/vibe-memory.integration.test.ts` to remove Capsule service coverage while preserving raw Vibe Memory coverage if any remains.
7. Update `test/api.routes.integration.test.ts` to remove Capsule write-route expectations and keep the historical capsule exclusion assertion if the fixture still creates or seeds capsule rows.

Guardrails:

- Do not remove `retrieveVibeMemoryContext` blindly if `search_memory` / older memory tools still depend on it for raw lookup.
- Do not remove `vibe_memories` table columns in this phase.
- Do not change findCandidate `memory_reader`.

Verification:

- `bun run typecheck`
- `bun test test/vibe-memory.service.test.ts`
- `bun test test/api.routes.integration.test.ts`
- `bun test test/reader.service.test.ts`
- `bun run doctor`

### Phase 5: Data Cleanup Decision

Goal: decide whether physical database cleanup is worth it.

Default: no physical cleanup.

Optional cleanup can be planned later if all are true:

- No code reads `vibe_goals`.
- No code reads `vibe_memory_marks`.
- No code reads `memory_type = 'capsule'`.
- Historical Capsule export is complete.
- A fresh DB migration smoke passes.

Possible cleanup steps:

1. Export `memory_type = 'capsule'` rows and marks to an archive file.
2. Delete capsule rows only if the user explicitly approves.
3. Drop `vibe_memory_marks` and `vibe_goals`.
4. Drop capsule-only columns from `vibe_memories`.
5. Update drizzle snapshots and migration tests.

Recommended: defer this indefinitely unless DB clutter becomes a real operational problem.

## Risk Register

| Risk | Why it matters | Mitigation |
|---|---|---|
| Removing Vibe Memory instead of Vibe Note | Names overlap heavily | Treat `memory_type = 'chat'`, agent log sync, reader, and findCandidate as protected |
| MCP contract failures | Tool lists currently include `vibe_memory_*` | Update tests and doctor required-tool expectations together |
| Raw UI starts showing capsules | `/vibe-memory` intentionally hides capsules | Preserve or test `memoryType !== 'capsule'` filtering |
| Distillation changes accidentally | findCandidate reads `vibe_memory` target kind | Do not modify findCandidate/memoryReader in this plan |
| DB migration damage | Capsule fields live on shared `vibe_memories` | No physical DB cleanup in first implementation |
| Docs still instruct agents to post Capsules | Token waste continues | Remove initial-instructions and public MCP workflow references first |

## Acceptance Criteria

- Admin UI has no Vibe Note page, nav entry, or cross-link.
- MCP exposed tools no longer include `vibe_memory_say`, `vibe_memory_reply`, `vibe_memory_peek`, or `vibe_memory_mark`.
- `initial_instructions` no longer asks agents to use Goal Room / Capsule tools.
- Public MCP docs no longer present Goal Room Memory as the normal workflow.
- Vibe Memory raw log UI still works.
- Agent log sync still inserts raw Vibe Memory chat rows.
- `readVibeMemoryByTokenWindow` still works.
- findCandidate can still process `targetKind = 'vibe_memory'`.
- Existing capsule data is preserved unless separately approved for deletion.

## Suggested Implementation Order

1. Phase 1 instruction/docs cleanup.
2. Phase 2 UI removal.
3. Phase 3 MCP tool removal.
4. Phase 4 backend route/service cleanup.
5. Phase 5 only after a separate explicit approval.

This order stops token waste first, then removes visible product surface, then removes callable write paths, and only then cleans backend code. It keeps Vibe Memory protected throughout.
