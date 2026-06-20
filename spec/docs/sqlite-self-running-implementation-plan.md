# SQLite 自走化 実装計画

> 状態: 実装中
> 作成日: 2026-06-20
> 最終更新: 2026-06-20
> 関連: [pgvector to SQLite Migration Scope](pgvector-to-sqlite-migration-scope.md), [SQLite Database Layout Audit](sqlite-database-layout-audit.md), [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md)

## 目的

この文書は、pgvector Docker を日常運用から外し、context-still が SQLite backend だけで MCP/API の主要機能を自走できる状態に到達するための残 TODO を実装計画に落とす。

PostgreSQL/pgvector support は削除しない。既存 install、large dataset、server 実験、互換検証のために `postgres` backend として残す。ただし default operator path は SQLite-first に寄せ、PostgreSQL/pgvector は明示的に選ぶ advanced backend とする。

## 目標状態

- PostgreSQL/pgvector Docker を停止しても、日常的な MCP/API 起動、Knowledge 登録、検索、`context_compile`、`compile_eval`、audit/settings が動く。
- backend は `CONTEXT_STILL_DB_BACKEND=sqlite|postgres` で明示的に切り替える。
- SQLite mode では実行時に pgvector SQL、PostgreSQL-only DDL、`DATABASE_URL` 必須 check に落ちない。
- PostgreSQL mode は既存の pgvector path を維持し、互換性確認用の test/smoke を残す。
- SQLite store は、value と churn の違いに応じて core、runs、ingest、workflow、ops に分離できる構造にする。

## 非目標

- 直ちに PostgreSQL/pgvector 実装を削除すること。
- pgvector と sqlite-vec の ranking を完全一致させること。
- agent history、audit、queue、Knowledge を単一 SQLite file に押し込むこと。
- portable Knowledge export と backend full migration を同一機能として扱うこと。
- Tauri UI を SQLite backend 完了の前提にすること。

## 現在できていること

直近の実装で、SQLite backend は primary Knowledge/context flow と、日常運用に必要な runtime support の多くを持っている。

| 領域 | 現状 |
|---|---|
| backend selection | `CONTEXT_STILL_DB_BACKEND` と SQLite path 解決が存在する |
| core SQLite schema/repository | Knowledge、sources、compile runtime support の基盤がある |
| Knowledge registration/search | `register_candidates`、`search_knowledge` は SQLite branch を持つ |
| Source search | source/evidence search は SQLite branch を持つ |
| Context compile | compile run、pack items、candidate traces、task traces の SQLite 保存がある |
| Runtime support | settings、audit logs、`compile_eval` は SQLite branch を持つ |
| Doctor/onboarding | SQLite backend、SQLite file、SQLite schema capability を PostgreSQL なしで検査できる |
| MCP smoke | `mcp:smoke:sqlite` と `verify:sqlite` がある |
| Queue runtime | queue claim、pause、retry、event logging の代表 path は SQLite branch を持つ |
| Agent/vibe memory | vibe memory、agent diff entries、sync state、memory read/search の SQLite branch がある |
| Context decision | decision runs、evidence、coverage、feedback の SQLite branch がある |
| Maintenance | `sqlite:backup` と `sqlite:rebuild-vectors` がある |
| Verification | `test:sqlite-core`、`test:sqlite-knowledge`、`test:sqlite-runtime` が存在する |

ただし、PostgreSQL -> SQLite full migration と multi-store file split はまだ完了していない。現時点の SQLite 実装は、単一 core SQLite file に active runtime tables を寄せた self-running baseline である。

## マイルストーン表記

`M1` は milestone 1 の略で、この計画では「Docker なし起動 smoke」を指す。番号は優先順と依存関係を見やすくするためのラベルであり、機能名ではない。

## 実装状況

| マイルストーン | 状態 | 備考 |
|---|---|---|
| M0: 計画と operator surface の整理 | 完了 | 本計画書、SQLite/PostgreSQL verify 分離、SQLite smoke を追加済み |
| M1: Docker なし起動 smoke | 完了 | SQLite doctor、MCP smoke、onboarding、landscape guard を追加済み |
| M2: Queue/distillation SQLite store | 部分完了 | queue schema、claim/pause/retry/event logging は実装済み。distillation worker の全結果 table migration は未完了 |
| M3: Agent/vibe ingest SQLite store | 部分完了 | vibe memory、agent diff、sync state、memory reader/search は実装済み。別 ingest DB 分離と compaction は未完了 |
| M4: Context decision / learning feedback SQLite store | 部分完了 | decision/evidence/coverage/feedback repository は実装済み。usage/review queue signals の全移植は未完了 |
| M5: Migration / backup / rebuild | 完了 | SQLite backup、vector rebuild、PostgreSQL -> SQLite full migration dry-run/apply を実装済み。restore 専用コマンドは未実装だが、backup SQLite file を target path として復旧できる |
| M6: SQLite default release gate | 部分完了 | `verify:sqlite` は実装済み。README/getting-started の public docs 更新は未完了 |

## 残っている実行時ブロッカー

### 1. Doctor と onboarding が PostgreSQL 前提を持つ

`doctor` は DB reachability、pgvector、required tables、queue、agent-log sync などを PostgreSQL 前提で検査する箇所が残っている。SQLite mode では、selected backend、SQLite file、PRAGMA、schema capability、vector capability、未対応 feature を明示的に報告する必要がある。

対応:

- `doctor` report の database section に backend kind と SQLite file paths を出す。
- SQLite mode では pgvector extension check を skip ではなく `not-applicable` として出す。
- required table list を backend ごとに分離する。
- queue、agent-log sync、landscape など未移行 domain は `degraded` ではなく `unsupported-in-sqlite` または `pending-migration` として分類する。
- onboarding/setup/startup は SQLite-first を default path にし、SQLite mode で `DATABASE_URL` 不足を修復 action にしない。

### 2. MCP tools に PostgreSQL 直結 path が残る

一部 MCP tools は repository abstraction を通らず `db` を直接 import している。SQLite mode で tools が PostgreSQL pool を触ると、Docker 停止時に失敗する。

優先対象:

- `src/mcp/tools/knowledge.tool.ts`
- `src/mcp/tools/memory.tool.ts`
- `src/mcp/tools/system.tool.ts` 経由の doctor report

対応:

- MCP tool は service/repository contract 経由へ寄せる。
- 未移行 tool は SQLite mode で structured error を返す。PostgreSQL に黙って接続しない。
- MCP smoke を SQLite mode で追加する。

### 3. Landscape vector comparison が pgvector SQL を直接使う

以下の landscape path は `<=>` を直接使っており、SQLite mode で実行されると pgvector なしでは動かない。

- `src/modules/landscape/landscape-contradiction.repository.ts`
- `src/modules/landscape/landscape-deadzone-review.repository.ts`
- `src/modules/landscape/landscape-community-comparison.ts`

対応:

- 初期対応では SQLite mode の landscape vector comparison を capability flag で無効化し、doctor と UI/API に明示する。
- 次段で `sqlite-vec` または TypeScript cosine fallback を追加する。
- PostgreSQL path は現状維持する。

### 4. Package scripts と public docs が PostgreSQL default を前提にしている

`mcp:smoke`、`verify:mcp`、`verify:queue:smoke`、integration tests は test PostgreSQL URL を強制する。README/getting-started/operations も Docker PostgreSQL を default setup として説明している。

対応:

- SQLite smoke script を追加する。
- PostgreSQL smoke は `verify:postgres` または advanced gate として残す。
- public docs は SQLite-first、PostgreSQL-optional に更新する。

## 残 TODO 分類

### A. SQLite-first runtime foundation

目的: Docker pgvector を停止しても MCP/API が起動し、主要 tool が動く。

TODO:

- `doctor` の backend-aware 化。完了。
- onboarding/setup/startup の SQLite-first 化。完了。
- MCP smoke の SQLite mode 追加。完了。
- SQLite file bootstrap を operator command から実行可能にする。
- `PRAGMA foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout`、`synchronous=NORMAL` を runtime init の明示契約にする。
- Postgres failure から SQLite へ silent fallback しない。backend は明示選択にする。

### B. Queue/distillation store

目的: workflow queue が PostgreSQL なしで claim、retry、pause、event logging できる。

移行対象:

- `distillation_target_states`
- `finding_candidate_queue`
- `found_candidates`
- `covering_evidence_queue`
- `evidence_coverage_results`
- `finalize_distille_queue`
- `distillation_queue_events`
- `distillation_queue_migration_map`
- `distillation_evidence_cache`
- `find_candidate_results`
- `cover_evidence_results`

実装方針:

- 当面は single core SQLite file に実装し、次段で `context-still-workflow.sqlite` へ分離する。
- SQLite queue claim は `BEGIN IMMEDIATE` を使い、短い transaction で rows を claim する。
- `running`/locked rows の migration は stale として扱い、必要なら cutover journal で clear する。
- queue event は移行するが、retention/compaction を別タスクで持つ。
- PostgreSQL queue repository は残し、同じ service contract にぶら下げる。

### C. Agent/vibe memory ingest store

目的: Codex 等の local history ingest を PostgreSQL なしで保存・検索できる。

移行対象:

- `vibe_memories`
- `agent_diff_entries`
- `vibe_goals`
- `vibe_memory_marks`
- `vibe_migration_runs`
- `sync_states`

実装方針:

- 当面は single core SQLite file に実装し、次段で `context-still-ingest.sqlite` へ分離する。
- coding-agent history は大きくなるため core Knowledge DB と同居させない。
- 初期は text search と metadata filters を移植する。
- `vibe_memories.embedding` は現行通常経路で生成・検索されていないため、初期 sqlite-vec 対象にしない。
- sync cursor と raw imported history の retention/compaction policy を doctor に出す。

### D. Context decision / learning feedback store

目的: `context_decision` と feedback/quality learning signals を SQLite mode で失わない。

移行対象:

- `context_decision_runs`
- `context_decision_evidence`
- `context_decision_coverage_traces`
- `context_decision_human_feedback`
- `context_decision_feedback`
- `context_decision_feedback_effects`
- `knowledge_usage_events`
- `knowledge_review_queue`
- `knowledge_quality_adjustments`

実装方針:

- 当面は single core SQLite file に実装し、次段で `context-still-runs.sqlite` へ分離する。
- quality adjustment の compact projection は core に置いてよい。
- feedback import/export は portable Knowledge export の optional learning signal として扱う。

### E. Landscape/admin/support store

目的: review workflow と admin surface が SQLite mode の capability を正しく表示する。

移行対象:

- `landscape_review_items`
- `landscape_review_item_candidate_links`
- `dead_zone_merge_review_queue`
- `merge_activation_finalize_queue`
- `landscape_snapshots`
- landscape vector comparison paths

実装方針:

- review queues は `context-still-workflow.sqlite` に置く。
- snapshots は rebuildable cache として `context-still-ops.sqlite` に置く。
- vector comparison は最初に capability guard、次に sqlite-vec/fallback implementation を入れる。
- UI/API は SQLite mode で unsupported feature を空データのように見せない。

### F. Import/export/migration

目的: PostgreSQL から SQLite へ移れること、SQLite mode で backup/restore できることを担保する。

TODO:

- PostgreSQL -> SQLite migration dry-run。完了。
- PostgreSQL -> SQLite migration apply。完了。
- SQLite core backup。完了。
- SQLite restore。未完了。現時点では backup file を `CONTEXT_STILL_SQLITE_CORE_PATH` に指定して復旧確認する。
- SQLite dialect の portable Knowledge SQL。
- Multi-store SQLite import session journal。
- Vector rebuild command。完了。
- Migration coverage report。完了。`sqlite:migrate-from-postgres` の summary が table ごとの source/target/migrated/skipped columns を報告する。

運用コマンド:

```bash
# 事前確認。SQLite target schema を作成し、PostgreSQL source rows と移行対象 columns を報告する。
bun run sqlite:migrate-from-postgres -- --dry-run --sqlite-path ./data/context-still-core.sqlite

# 空の SQLite target へ insert-only で移行する。既存 row と衝突した場合は失敗させる。
bun run sqlite:migrate-from-postgres -- --apply --sqlite-path ./data/context-still-core.sqlite

# 明示的に上書きしたい場合のみ使う。
bun run sqlite:migrate-from-postgres -- --replace --sqlite-path ./data/context-still-core.sqlite
```

移行対象:

- Knowledge/source/evidence/source links。
- compile runs、pack items、candidate/task traces、compile evals。
- context decision runs/evidence/coverage/feedback/effects。
- vibe memories、agent diff entries、goals/marks/sync state。
- distillation queues/results/events/migration map。
- landscape review queues/snapshots。
- settings、audit logs、LLM usage logs。
- `knowledge_items.embedding` と `source_fragments.embedding` は SQLite canonical table には入れず、`*_vec_fallback` へ変換する。sqlite-vec virtual tables は `sqlite:rebuild-vectors` で再構築する。

注意:

- portable Knowledge import/export は full backend migration ではない。
- vector side tables は export せず、import 後に rebuild する。
- audit、LLM usage、local settings、raw agent logs は default portable export に含めない。

### G. PostgreSQL/pgvector advanced backend の隔離

目的: pgvector 切替機能を残しつつ、SQLite default path を汚染しない。

TODO:

- `postgres` backend の scripts/docs を advanced section に移す。
- PostgreSQL-only tests を名前で分離する。
- PostgreSQL migrations/drizzle schema は残すが、SQLite runtime init からは参照しない。
- repository contracts に `pg` client object を漏らさない。
- PostgreSQL mode の smoke は継続する。

## マイルストーン

### M0: 計画と operator surface の整理

成果物:

- 本計画書。
- README/spec public docs の SQLite-first 方針更新。
- scripts の PostgreSQL-only と SQLite smoke の分類。

完了条件:

- 日常運用の default が SQLite であることを docs が説明している。
- PostgreSQL/pgvector は optional advanced backend として説明されている。

### M1: Docker なし起動 smoke

成果物:

- SQLite mode の `doctor`。
- SQLite mode の MCP smoke。
- onboarding/startup の SQLite-first path。
- landscape PostgreSQL-only path の capability guard。

完了条件:

- PostgreSQL/pgvector Docker を停止した状態で MCP/API が起動する。
- `register_candidates`、`search_knowledge`、`context_compile`、`compile_eval`、audit/settings、doctor smoke が通る。
- SQLite mode で PostgreSQL connection error が primary flow に出ない。

### M2: Queue/distillation SQLite store

成果物:

- workflow SQLite schema/repository。
- queue claim/retry/pause/event logging の SQLite implementation。
- queue migration dry-run。

完了条件:

- `queue:*:once` の代表 path が SQLite mode で PostgreSQL なしに動く。
- claim concurrency と stale lock handling の tests がある。
- PostgreSQL queue smoke は advanced backend として残る。

### M3: Agent/vibe ingest SQLite store

成果物:

- ingest SQLite schema/repository。
- agent log sync と memory reader の SQLite implementation。
- ingest DB retention/compaction diagnostics。

完了条件:

- `sync:agent-logs` と memory search/read が SQLite mode で動く。
- raw history が core Knowledge DB を肥大化させない。

### M4: Context decision / learning feedback SQLite store

成果物:

- context decision repository の SQLite implementation。
- usage/feedback/quality learning signals の SQLite coverage。
- portable export との境界整理。

完了条件:

- `context_decision` と feedback tools が SQLite mode で PostgreSQL に触らない。
- learning signals が compile/search ranking に必要な形で保存される。

### M5: Migration / backup / rebuild

成果物:

- PostgreSQL -> SQLite migration dry-run/apply。
- SQLite backup/restore。
- vector rebuild command。
- coverage report。

完了条件:

- 既存 PostgreSQL install から SQLite stores を構築できる。
- import/export は evidence を silent drop せず、skipped rows を report する。
- Knowledge/source vectors は rebuild で復元できる。

### M6: SQLite default release gate

成果物:

- SQLite-first public docs。
- `verify:sqlite` gate。
- PostgreSQL advanced gate。
- known unsupported list が doctor/docs に一致している。

完了条件:

- 新規 user は Docker pgvector なしで始められる。
- 既存 user は明示的な backend switch で PostgreSQL/pgvector に戻せる。
- CI/local verify が SQLite default と PostgreSQL compatibility を分けて検証する。

## 検証計画

既存 gate:

- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run test:sqlite-core`
- `bun run test:sqlite-knowledge`
- `bun run test:sqlite-runtime`
- `bun run test:unit`

追加する gate:

- `bun run test:sqlite-doctor`
- `bun run test:sqlite-mcp`
- `bun run test:sqlite-queue`
- `bun run test:sqlite-agent-log`
- `bun run test:sqlite-context-decision`
- `bun run test:sqlite-migration`
- `bun run verify:sqlite`
- `bun run verify:postgres`

Smoke 条件:

1. PostgreSQL/pgvector Docker を停止する。
2. `CONTEXT_STILL_DB_BACKEND=sqlite` で MCP/API を起動する。
3. `doctor` が SQLite backend と file paths を報告する。
4. `register_candidates`、`search_knowledge`、`context_compile`、`compile_eval` を実行する。
5. SQLite files に expected rows が入ることを確認する。
6. PostgreSQL connection attempt が primary flow に出ていないことを確認する。

## リスクと対策

| リスク | 対策 |
|---|---|
| SQLite write contention | WAL、busy timeout、短い transaction、queue claim の `BEGIN IMMEDIATE` |
| agent history の肥大化 | ingest DB を分離し、retention/compaction を持つ |
| vector extension availability | sqlite-vec capability check と TypeScript fallback を持つ |
| pgvector との ranking drift | exact parity を非目標にし、contract-level behavior と regression tests を見る |
| UI/API が unsupported を空結果に見せる | backend capability と unsupported reason を response/doctor に出す |
| PostgreSQL path の劣化 | advanced backend tests と smoke を残す |
| import/export と full migration の混同 | portable archive と backend migration を別コマンド/別 docs にする |

## 完了の定義

SQLite 自走化は、次を満たした時点で「pgvector Docker を日常運用から外せる」と判定する。

- `CONTEXT_STILL_DB_BACKEND=sqlite` で MCP/API の通常操作が PostgreSQL なしに動く。
- `doctor` が SQLite backend の健全性、未対応 capability、file paths、migration coverage を説明する。
- queue、agent ingest、context decision、landscape review の active state が SQLite stores に移っているか、明示的な unsupported state として扱われる。
- PostgreSQL/pgvector backend は `CONTEXT_STILL_DB_BACKEND=postgres` で明示的に選べる。
- README/getting-started/operations は Docker pgvector を default prerequisite として扱っていない。
- Migration/backup/rebuild により、既存 PostgreSQL install から SQLite daily-use state を作れる。
