# pgvector to SQLite Migration Scope

> 状態: scope classification
> 作成日: 2026-06-19
> 関連: [SQLite Database Layout Audit](sqlite-database-layout-audit.md)

## 目的

この文書は、現行 PostgreSQL/pgvector backend から SQLite/sqlite-vec backend へ移す対象を、schema、実装、実 DB activity の3点から分類する。

ここでの「選別」は、active な context-still state を削るためではない。現行 active behavior に使われているものは原則すべて移行対象にする。その上で、SQLite 側の保存先、vector 化の有無、rebuildable/retention/legacy の扱いを分ける。

## 調査 Snapshot

調査対象:

- schema: `src/db/schema-*.ts`
- vector search implementation: `knowledge.repository.ts`, `source.repository.ts`, `context-compile-task-trace.repository.ts`, `landscape-trajectory.service.ts`, `vibe-memory.repository.ts`
- live DB: `postgres://postgres:postgres@localhost:7889/context_still`

実 DB snapshot は 2026-06-19 23:55 JST 頃の値である。timestamp column は table ごとに `created_at`、`updated_at`、`fetched_at` など最も activity を表しやすいものを参照した。

## 判定ルール

| 判定 | 意味 |
|---|---|
| `migrate` | SQLite backend cutover で移す。active state として扱う。 |
| `migrate-retained` | 移すが retention policy を尊重する。全履歴の永久保存ではない。 |
| `rebuildable` | row 自体は移す場合があるが、index/cache/vector side table は再構築対象。 |
| `legacy-drop` | schema export から外れており、現 DB activity もない。SQLite backend には持ち込まない。 |

## Vector Scope

現行 pgvector column は4種類ある。

| Table | Row count | Embedding present | 実装上の用途 | SQLite 方針 |
|---|---:|---:|---|---|
| `knowledge_items.embedding` | 6071 | 6066 | `vectorSearchKnowledge()` が `<=>` で直接検索する。`context_compile` の主要 retrieval path。 | `knowledge_items` は migrate。初期 sqlite-vec 対象として `knowledge_items_vec` を作る。vector rows は rebuildable。 |
| `source_fragments.embedding` | 2260 | 2138 | `vectorSearchSourceContent()` が `<=>` で直接検索する。source/evidence retrieval path。 | `source_fragments` は migrate。初期 sqlite-vec 対象として `source_fragments_vec` を作る。vector rows は rebuildable。 |
| `context_compile_task_traces.embedding` | 2263 | 2244 | SQL vector search ではなく、recent traces を読み出して TypeScript 側で cosine similarity を計算する。 | `context_compile_task_traces` は migrate。embedding 値は run diagnostic data として保存するが、初期 sqlite-vec side table は作らない。 |
| `vibe_memories.embedding` | 3323 | 0 | schema/index はあるが、通常の agent-log sync/search path は text search。現 DB は全件 NULL。 | `vibe_memories` は migrate。初期 sqlite-vec 対象外。将来 vector memory search を実装する時に backfill する。 |

query embedding は永続化対象ではない。Knowledge/source vector search を実行するために query embedding は必要だが、検索時に一時生成して sqlite-vec へ渡す。query 専用 table は作らない。

## Migration Target By SQLite File

### `context-still-core.sqlite`

Durable Knowledge graph と source evidence を所有する。portable import/export の中心でもある。

| Table | Rows | Last activity | 判定 | 補足 |
|---|---:|---|---|---|
| `knowledge_items` | 6071 | 2026-06-19 13:30:05 | migrate | canonical Knowledge。embedding capability は sqlite-vec side table で復元する。 |
| `knowledge_tag_definitions` | 36 | 2026-05-28 09:29:38 | migrate | taxonomy。 |
| `knowledge_community_labels` | 0 | - | migrate | active schema。空でも schema と service contract は維持する。 |
| `knowledge_quality_adjustments` | 0 | - | migrate | learning/scoring 用。空でも active schema。 |
| `knowledge_origin_links` | 893 | 2026-05-30 11:48:32 | migrate | provenance。 |
| `sources` | 178 | 2026-06-12 02:43:52 | migrate | source evidence owner。 |
| `source_fragments` | 2260 | 2026-06-12 02:43:52 | migrate | evidence fragment。embedding capability は sqlite-vec side table で復元する。 |
| `knowledge_source_links` | 646 | 2026-06-12 05:35:40 | migrate | Knowledge と evidence の hard edge。core 内に置く。 |

### `context-still-runs.sqlite`

Compile/decision の run history、retrieval traces、learning signals を所有する。

| Table | Rows | Last activity | 判定 | 補足 |
|---|---:|---|---|---|
| `context_compile_runs` | 2424 | 2026-06-19 14:55:19 | migrate | compile history。 |
| `context_compile_evals` | 1677 | 2026-06-19 14:51:37 | migrate | learning signal。 |
| `context_compile_task_traces` | 2263 | 2026-06-19 14:55:19 | migrate | query/task diagnostic。embedding は row data として保存し、vec index 化しない。 |
| `context_pack_items` | 10868 | 2026-06-19 14:55:19 | migrate | run-scoped pack output。 |
| `context_compile_candidate_traces` | 35926 | 2026-06-19 14:55:19 | migrate | ranking diagnostics。large だが active diagnostics。 |
| `knowledge_usage_events` | 10729 | 2026-06-19 14:55:19 | migrate | scoring/feedback input。 |
| `knowledge_review_queue` | 0 | - | migrate | active schema。 |
| `context_decision_runs` | 78 | 2026-06-18 06:11:09 | migrate | decision history。 |
| `context_decision_evidence` | 526 | 2026-06-18 06:11:09 | migrate | decision evidence. |
| `context_decision_coverage_traces` | 430 | 2026-06-18 06:11:09 | migrate | coverage diagnostics。 |
| `context_decision_human_feedback` | 2 | 2026-06-13 14:35:32 | migrate | learning signal。 |
| `context_decision_feedback` | 13 | 2026-06-17 13:43:53 | migrate | learning signal。 |
| `context_decision_feedback_effects` | 96 | 2026-06-17 13:43:53 | migrate | applied effect history。 |

### `context-still-ingest.sqlite`

agent history ingest と local sync cursor を所有する。

| Table | Rows | Last activity | 判定 | 補足 |
|---|---:|---|---|---|
| `vibe_memories` | 3323 | 2026-06-19 13:23:36 | migrate | coding-agent history substrate。embedding は全 NULL なので vec 対象外。 |
| `agent_diff_entries` | 15229 | 2026-06-19 13:23:36 | migrate | code diff evidence。 |
| `vibe_goals` | 93 | 2026-06-06 21:06:02 | migrate | legacy capsule columns の参照先としても残す。 |
| `vibe_memory_marks` | 1 | 2026-05-31 00:41:29 | migrate | marks/annotations。 |
| `vibe_migration_runs` | 1 | - | migrate | migration bookkeeping。 |
| `sync_states` | 10 | 2026-06-19 14:55:10 | migrate | agent-log sync cursor。ingest owner とする。 |

### `context-still-workflow.sqlite`

distillation/review/queue state を所有する。SQLite cutover では live locks をそのまま信頼せず、locked fields は stale として扱うか clear する。

| Table | Rows | Last activity | 判定 | 補足 |
|---|---:|---|---|---|
| `distillation_target_states` | 5637 | 2026-06-19 12:29:28 | migrate | active distillation target state。pending 4548, completed 256, skipped 831, failed 2。 |
| `find_candidate_results` | 2473 | 2026-06-19 12:29:28 | migrate | candidate discovery result。 |
| `cover_evidence_results` | 1375 | 2026-05-25 14:51:15 | migrate | older cover evidence result path still referenced by reprocess code。 |
| `finding_candidate_queue` | 6563 | 2026-06-19 13:25:03 | migrate | queue state。completed 3122, skipped 3422, failed 19。 |
| `found_candidates` | 9181 | 2026-06-19 13:25:03 | migrate | queue candidate payload。 |
| `covering_evidence_queue` | 9150 | 2026-06-19 13:30:00 | migrate | queue state。completed 8918, failed 232。 |
| `evidence_coverage_results` | 9178 | 2026-06-19 13:30:00 | migrate | current evidence coverage result path。 |
| `finalize_distille_queue` | 5191 | 2026-06-19 13:30:05 | migrate | queue state。completed 5188, skipped 3。 |
| `distillation_queue_events` | 40802 | 2026-06-19 13:30:05 | migrate | workflow diagnostic log。future retention/pruning は別途。 |
| `distillation_queue_migration_map` | 0 | - | migrate | queue migration bookkeeping。 |
| `landscape_review_items` | 53 | 2026-06-14 02:42:03 | migrate | review workflow。 |
| `landscape_review_item_candidate_links` | 50 | 2026-05-24 09:52:33 | migrate | review to candidate link。 |
| `dead_zone_merge_review_queue` | 4 | 2026-06-14 02:42:30 | migrate | merge review queue。all completed。 |
| `merge_activation_finalize_queue` | 4 | 2026-06-14 02:43:28 | migrate | activation/finalize queue。all completed。 |

### `context-still-ops.sqlite`

local settings、audit、telemetry、cache を所有する。

| Table | Rows | Last activity | 判定 | 補足 |
|---|---:|---|---|---|
| `settings` | 8 | 2026-06-18 14:26:31 | migrate | local config。secret value の扱いは redaction/secret-ref policy に従う。 |
| `audit_logs` | 7930 | 2026-06-19 14:55:19 | migrate-retained | 7日 retention policy。SQLite cutover では retained window のみ移す。portable Knowledge export には含めない。 |
| `llm_usage_logs` | 46085 | 2026-06-19 14:55:19 | migrate-retained | local telemetry/cost history。portable Knowledge export には含めない。 |
| `distillation_evidence_cache` | 22156 | 2026-06-19 13:27:54 | rebuildable | external evidence cache。初期 cutover では移してよいが、失っても再取得可能な cache として扱う。 |
| `landscape_snapshots` | 0 | - | rebuildable | generated cache。 |

## Legacy Inventory

以下は現 DB には残るが、現在の Drizzle schema export には含まれず、実 DB activity もない。SQLite backend には持ち込まない。

| Table | Rows | 判定 | 根拠 |
|---|---:|---|---|
| `distillation_candidates` | 0 | legacy-drop | old migration table。current schema export なし。 |
| `distillation_jobs` | 0 | legacy-drop | old queue/read pipeline。current schema export なし。 |
| `distillation_read_events` | 0 | legacy-drop | old reader cache event。current schema export なし。 |
| `source_distillation_runs` | 0 | legacy-drop | old source distillation run table。current schema export なし。 |
| `vibe_memory_distillation_runs` | 0 | legacy-drop | old vibe distillation run table。current schema export なし。 |

これらは PostgreSQL cleanup migration の候補ではあるが、SQLite migration の blocker ではない。

## 実装上の注意

### JSONB と FTS

PostgreSQL 実装は `jsonb` operators、GIN、`to_tsvector` に依存している。SQLite では次へ置き換える。

- JSON storage: SQLite `TEXT` + JSON validation、または Drizzle sqlite JSON mode。
- JSON query: `json_extract` / generated columns / application-side filters。
- FTS: SQLite FTS5 virtual tables。
- vector: sqlite-vec side tables。

### Queue Cutover

workflow tables は active state と historical payload が混在している。SQLite cutover 時は次を行う。

- `running` / locked rows はそのまま running 扱いにしない。
- `locked_by`, `locked_at`, `heartbeat_at` は cutover journal に基づいて stale/cleared として扱う。
- `pending`, `failed`, `skipped`, `completed` は preserve する。
- queue event logs は migrate するが、retention policy は別途決める。

### Portable Import/Export との差分

この文書は backend migration scope であり、portable Knowledge archive scope ではない。

portable archive から除外するものでも、SQLite backend migration では移すものがある。

- `vibe_memories`
- `agent_diff_entries`
- `context_compile_*`
- `context_decision_*`
- workflow queues
- `settings`
- `audit_logs`
- `llm_usage_logs`

逆に、portable archive では vector side table を持ち運ばない。SQLite migration でも source-of-truth は canonical row であり、vector side table は rebuildable capability として扱う。

## 次の実装 Slice

1. SQLite driver/session abstraction を追加し、PostgreSQL singleton から repository を切り離す。
2. `context-still-core.sqlite` の DDL と repository adapter を作る。
3. `knowledge_items_vec` と `source_fragments_vec` の sqlite-vec rebuild path を作る。
4. `searchKnowledge` / `vectorSearchKnowledge` / `searchSourceContent` / `vectorSearchSourceContent` の SQLite implementation を追加する。
5. core data の PostgreSQL -> SQLite migration dry-run を作る。
6. `doctor` に backend kind、vector capability、migration coverage を出す。
