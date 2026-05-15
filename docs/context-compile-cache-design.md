# context_compile cache key / invalidation design (pre-implementation)

## Scope

- This document defines cache-key shape and invalidation rules before introducing runtime cache storage.
- Current implementation only records compile latency and cache-key draft in `diagnostics.retrievalStats.cacheKeyDraft`.
- No cache read/write path is enabled yet.

## Exact-key strategy (phase 1)

- Cache mode: exact normalized key only.
- Semantic similarity cache: out of scope for phase 1.
- Reason: avoid false-hit risk while HITL review and source freshness behavior are still being hardened.

## Cache key components

`cacheKeyDraft.version = "v1-exact-normalized"`

`cacheKeyDraft` includes:

- `repoPath` / `repoKey`
- `retrievalMode`
- `tokenBudget`
- `includeDraft`
- `intent` / `taskType`
- `goalHash`
- `filesHash`
- `changeTypesHash`
- `technologiesHash`
- freshness markers:
  - `freshness.knowledgeActiveUpdatedAt`
  - `freshness.knowledgeDraftUpdatedAt`
  - `freshness.sourceCorpusUpdatedAt`

Notes:

- Goal/files/changeTypes/technologies are hashed to keep diagnostics compact.
- Freshness markers are timestamps from DB aggregate queries (`MAX(updated_at)` / relevant scoped queries).

## Invalidation rules

When cache storage is introduced, invalidate by namespace (`repoKey` first, fallback `repoPath`) under these events:

1. `knowledge_items.status` transition to `active`
2. `knowledge_items.status` transition to `deprecated`
3. source/vibe distillation creates or updates knowledge rows that become eligible for compile
4. `sources.updated_at` changes for relevant corpus

Additional rules:

- Global-scope knowledge changes invalidate all repo namespaces.
- Repo-scoped knowledge changes invalidate only matching repo namespace.
- Draft-only updates do not invalidate active-only compile caches unless `includeDraft=true` key namespace is targeted.

## Future semantic-cache gate

Do not enable semantic cache until the following test gates exist:

1. deterministic false-hit regression tests (different repo scope / token budget / retrieval mode)
2. stale-hit tests after knowledge activation/deprecation
3. degraded fallback tests in environments without embedding

Until then, keep exact-key cache only.
