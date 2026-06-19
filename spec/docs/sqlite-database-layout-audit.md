# SQLite Database Layout Audit

> 状態: design audit
> 関連コンセプト: [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md)
> 関連計画: [Portable Knowledge Import/Export Draft Plan](portable-knowledge-import-export-plan.md)

## 目的

この文書は、Knowledge import/export、SQLite queues、Tauri baseline の実装前に、現行 PostgreSQL schema から SQLite storage layout を考え直すための監査文書である。

以前の "core data" と "logs" の粗い分割だけでは不十分である。現行 schema には Knowledge、evidence、agent memory、compile/decision runs、distillation、landscape review、queues、settings、audit、usage logs にまたがる42 tables がある。durable assets、workflow state、diagnostics が混在しており、いくつかの tables は durable evidence と runtime locks を同じ row に含んでいる。

SQLite design は table names だけではなく、table responsibility と recovery semantics に基づくべきである。

## 移行カバレッジ方針

SQLite backend migration は、Portable Knowledge import/export より広い。

原則として、現行 PostgreSQL/pgvector backend 上で context-still の active behavior に使われている data はすべて SQLite 側へ移す。Knowledge だけでなく、run history、feedback、agent ingest、workflow queues、settings、audit、usage telemetry も移行対象である。

移行しないものを置く場合は、次のどれかに分類する。

- legacy 機能として削除する。
- rebuildable cache として再生成する。
- retention policy に従って破棄できる short-retention data として扱う。

「portable Knowledge archive に含めない」ことは、「SQLite backend migration で移行しない」ことを意味しない。

## 現行 Table Families

| Family | Tables | 主な責務 |
|---|---|---|
| Knowledge assets | `knowledge_items`, `knowledge_tag_definitions`, `knowledge_community_labels`, `knowledge_quality_adjustments`, `knowledge_origin_links` | Durable user-owned Knowledge、taxonomy、scoring adjustments、provenance |
| Source evidence | `sources`, `source_fragments`, `knowledge_source_links` | Knowledge を説明する evidence records と fragment-level links |
| Agent memory ingest | `vibe_memories`, `vibe_goals`, `vibe_memory_marks`, `agent_diff_entries`, `vibe_migration_runs`, `sync_states` | coding-agent history の import/sync、extracted memory、diff snippets、sync cursors |
| Compile runs | `context_compile_runs`, `context_compile_evals`, `context_compile_task_traces`, `context_pack_items`, `context_compile_candidate_traces`, `knowledge_usage_events`, `knowledge_review_queue` | retrieval run history、evaluations、ranking traces、pack contents、usage feedback、follow-up review queue |
| Decision runs | `context_decision_runs`, `context_decision_evidence`, `context_decision_coverage_traces`, `context_decision_human_feedback`, `context_decision_feedback`, `context_decision_feedback_effects` | decision history、evidence、coverage traces、feedback effects |
| Distillation pipeline | `distillation_target_states`, `distillation_evidence_cache`, `find_candidate_results`, `cover_evidence_results`, `finding_candidate_queue`, `found_candidates`, `covering_evidence_queue`, `evidence_coverage_results`, `finalize_distille_queue`, `distillation_queue_events`, `distillation_queue_migration_map` | candidate discovery、evidence coverage、queue state、queue events、generated Knowledge linkage |
| Landscape review | `landscape_review_items`, `landscape_review_item_candidate_links`, `dead_zone_merge_review_queue`, `merge_activation_finalize_queue`, `landscape_snapshots` | review workflow、candidate links、merge/finalize queues、cached landscape views |
| Local operations | `settings`, `audit_logs`, `llm_usage_logs` | local configuration、short-retention audit、usage/cost telemetry |

## 責務クラス

tables は、何を残すべきか、何を再構築できるか、何を machine-local にすべきかで分類する。

| Class | 意味 | 例 |
|---|---|---|
| Portable durable asset | backend をまたいで export/import すべき user-owned state | Knowledge rows、source evidence、Knowledge-source links、origin links、tag definitions |
| Portable learning signal | 将来の ranking や quality decision に影響する feedback/evaluation | Compile evals、Knowledge usage events、decision feedback、feedback effects、quality adjustments |
| Historical trace | 診断には有用だが active retrieval には必須ではない履歴 | Compile candidate traces、pack items、coverage traces、decision run transcripts |
| Ingest substrate | Knowledge を生成するための local coding-agent history と extracted memory | Vibe memories、agent diff entries、sync states |
| Workflow state | retries、locks、attempts、heartbeats を持つ mutable queue/review state | Distillation queues、review queues、merge/finalize queues |
| Rebuildable cache | 再生成できる derived rows | Landscape snapshots、external evidence cache、vector indexes |
| Short-retention operational log | retention policy を持つ local telemetry/audit | Audit logs、LLM usage logs |

この区別は重要である。SQLite files は user-visible operational units になる。short-retention audit table と durable Knowledge graph を混ぜると、backup、compaction、import/export の境界が曖昧になる。

## 提案する SQLite Files

最初の SQLite baseline は、少数の physical databases と、それらをまたぐ stable IDs で構成する。SQLite は attached database files をまたぐ foreign keys を単一 PostgreSQL schema と同じ形では強制できないため、cross-file references は application-level references として明示する。

| SQLite file | 所有するもの | 所有しないもの |
|---|---|---|
| `context-still-core.sqlite` | Durable Knowledge graph、source evidence、portable provenance、tag/community taxonomy、compact quality state | Raw agent logs、queue locks、audit logs、source of truth としての rebuildable vector indexes |
| `context-still-runs.sqlite` | Compile/decision run history、pack traces、coverage traces、evals、usage events、decision feedback records | Core Knowledge rows、queue scheduling、raw agent transcript storage |
| `context-still-ingest.sqlite` | Agent memory ingest、vibe memories、diff entries、sync cursors、imported histories の migration bookkeeping | Canonical Knowledge と source evidence、portable import/export manifest state |
| `context-still-workflow.sqlite` | Distillation queues、review queues、found candidates、evidence coverage results、landscape review workflow、queue event logs | Long-term Knowledge graph ownership、short-retention audit、local provider settings |
| `context-still-ops.sqlite` | Settings、audit logs、LLM usage logs、landscape snapshots、external evidence cache、app-local maintenance state | Portable Knowledge assets、user workflows の runtime queue leases |

これは `core` と `logs` の二分割より意図的に細かい。高価値の portable state を high-churn workflow や local telemetry から分離しつつ、desktop app が管理できる程度に file 数を抑える。

## Table 配置

### `context-still-core.sqlite`

Core は backup、import/export、trust inspection を最適化する。

対象Tables:

- `knowledge_items`
- `knowledge_tag_definitions`
- `knowledge_community_labels`
- `knowledge_quality_adjustments`
- `knowledge_origin_links`
- `sources`
- `source_fragments`
- `knowledge_source_links`

理由:

- `knowledge_source_links` は `knowledge_items` と `source_fragments` の両方に近い場所に置くべきである。そうしないと、最重要の evidence link が最初から cross-file weak reference になる。
- `sources` と `source_fragments` は大きくなり得るが、それでも portable Knowledge の evidence envelope の一部である。
- Vector data を portable source of truth として扱わない。SQLite では vec side tables をこれらの rows の横に置けるが、再構築可能でなければならない。

### `context-still-runs.sqlite`

Runs は diagnostics、feedback history、Knowledge graph を危険にさらさない pruning/compaction を最適化する。

対象Tables:

- `context_compile_runs`
- `context_compile_evals`
- `context_compile_task_traces`
- `context_pack_items`
- `context_compile_candidate_traces`
- `knowledge_usage_events`
- `context_decision_runs`
- `context_decision_evidence`
- `context_decision_coverage_traces`
- `context_decision_human_feedback`
- `context_decision_feedback`
- `context_decision_feedback_effects`

理由:

- これらの tables は Knowledge を強く参照するが、多くの rows は run-scoped である。
- `context_compile_evals`、`knowledge_usage_events`、decision feedback は learning signals であり、関連する場合は portable exports に含めるべきである。
- `knowledge_items.id` への cross-file references は enforced SQLite foreign keys ではなく、stable IDs として保存し、services で検証する。
- feedback effects が startup scoring に必須なほど compact になった場合は、summary projection を `context-still-core.sqlite` に materialize できる。

### `context-still-ingest.sqlite`

Ingest は、大きな local histories と agent-log sync safety を最適化する。

対象Tables:

- `vibe_goals`
- `vibe_memories`
- `vibe_memory_marks`
- `agent_diff_entries`
- `vibe_migration_runs`
- `sync_states`

理由:

- coding-agent history は急速に増える可能性があり、machine-local である。
- raw log access は、server deployment より desktop/local app が合う理由の一つである。
- extracted Knowledge は `context-still-core.sqlite` へ promote する。ingest rows は source material と sync index として残す。
- `sync_states` は agent-log cursors を追跡する場合ここに置く。将来 ingest と無関係な sync state が出るなら、namespaced key として `context-still-ops.sqlite` に移す。

### `context-still-workflow.sqlite`

Workflow は local worker reliability、retries、cleanup を最適化する。

対象Tables:

- `distillation_target_states`
- `find_candidate_results`
- `cover_evidence_results`
- `finding_candidate_queue`
- `found_candidates`
- `covering_evidence_queue`
- `evidence_coverage_results`
- `finalize_distille_queue`
- `distillation_queue_events`
- `distillation_queue_migration_map`
- `knowledge_review_queue`
- `landscape_review_items`
- `landscape_review_item_candidate_links`
- `dead_zone_merge_review_queue`
- `merge_activation_finalize_queue`

理由:

- これらの tables は queue と review workflows を通じて強く結合している。
- いくつかの rows は durable evidence-like payloads と、status、attempts、locks、heartbeats、retry timestamps などの runtime fields を混ぜている。
- import/export は live queue state を active jobs として copy してはいけない。evidence-bearing rows は historical workflow evidence records へ project する。
- `found_candidates`、`cover_evidence_results`、`evidence_coverage_results` は Knowledge exports を説明する材料になり得るが、active workflow rows として import してはいけない。

### `context-still-ops.sqlite`

Ops は local maintenance と retention を最適化する。

対象Tables:

- `settings`
- `audit_logs`
- `llm_usage_logs`
- `distillation_evidence_cache`
- `landscape_snapshots`

理由:

- `audit_logs` は現在7日 retention policy であり、portable durable assets ではなく operational logs である。
- `llm_usage_logs` は telemetry と cost history として有用だが、Knowledge portability を block すべきではない。
- `distillation_evidence_cache` と `landscape_snapshots` は rebuildable caches である。
- Settings は secret references や machine-local configuration を含む可能性があり、default Knowledge export に含めるべきではない。

## Vector Storage

現行では `knowledge_items`、`source_fragments`、`vibe_memories`、`context_compile_task_traces` などに vector columns がある。ただし、実際に embedding を生成し検索経路で使っている対象と、schema 上の列だけが先行している対象は分けて扱う。

現行コード上の実態:

- `knowledge_items` は `title` + `body` を passage embedding し、Knowledge vector search で使っている。
- `source_fragments` は source chunk の `content` を passage embedding し、source vector search で使っている。
- query embedding は Knowledge/source vector search のための一時入力として生成される。vector search を使う限り query 側の embedding は必要だが、永続化は検索実行の必須条件ではない。
- 現行実装では query embedding を `context_compile_task_traces` に診断用として保存している。
- `context_compile_task_traces.embedding` は run/trajectory 診断用の保存値であり、初期 SQLite baseline の default vector search 面ではない。
- `vibe_memories.embedding` は schema と index が存在するが、通常の vibe-memory record / agent-log sync / search 経路では embedding 生成や vector search に使っていない。

SQLite ではこれらを portable values として保存しない。推奨 policy は次の通り。

- canonical text/JSON rows は owning SQLite file に保存する
- 初期 sqlite-vec 対象は `knowledge_items_vec` と `source_fragments_vec` に限定する
- query embedding は検索時に一時生成して sqlite-vec の検索入力に使う。query embedding 用の sqlite-vec table は作らない
- `context_compile_task_traces.embedding` は row data として保存し、初期段階では sqlite-vec side table を作らない
- `vibe_memories_vec` は、vibe-memory の embedding 生成・backfill・vector search 経路を明示的に実装するまで作らない
- embedding model と dimension を local metadata に記録する
- import、model change、vector schema change 後に vectors を rebuild する
- portable SQL から vector rows を default で除外する

これにより、backup や cross-backend import を pgvector binary representation、embedding dimension drift、sqlite-vec implementation details に結合しない。

## Import And Export への影響

import/export feature は physical database copy であってはならない。

portable projection として export する。

- `context-still-core.sqlite` から Knowledge assets
- `context-still-core.sqlite` から source evidence
- `context-still-runs.sqlite` から relevant learning signals
- `context-still-workflow.sqlite` から relevant historical workflow evidence projections
- manifest、checksums、dialect-specific SQL、skipped-row reports

default では export しない。

- queue locks または pending jobs
- audit logs
- LLM usage logs
- local settings と secrets
- raw agent logs または full vibe memory history
- vector side tables
- rebuildable snapshots と caches

つまり `Portable Knowledge Import/Export` は logical ownership boundaries をまたいで query する必要がある。Knowledge を説明する evidence は保存しつつ、machine-local runtime state を silent rehydrate してはいけない。

複数の SQLite file へ write import する場合、単一の cross-file transaction に依存してはいけない。store-aware import session journal と per-file transactions が必要である。それが存在するまでは、writable SQLite import は `context-still-core.sqlite` に限定する。

## Cross-Database Reference ルール

SQLite split rules:

1. hard evidence edges は可能な限り `context-still-core.sqlite` 内に保つ。
2. cross-file references には stable UUID/text IDs を使う。
3. cross-file foreign key enforcement に依存しない。
4. repository services と `doctor` で cross-file references を検証する。
5. missing cross-file references は low-level SQL crash ではなく degraded data として扱う。
6. import dry-run は skipped または unresolved evidence edge をすべて報告する。

重要な cross-file references:

- run と decision tables は `knowledge_items.id` を参照する
- landscape review tables は Knowledge、run history、usage events、distillation artifacts を参照する
- workflow finalization tables は resulting `knowledge_items.id` を参照し得る
- ingest rows は Knowledge provenance になり得るが、canonical Knowledge rows を所有しない

## Migration Sequence

推奨順序:

1. この responsibility map を planning baseline として固定する。
2. import/export を physical DB dumps ではなく portable projections として再設計する。
3. 単一 SQL connection を前提にしない repository interfaces を導入する。
4. まず `context-still-core.sqlite` の SQLite provider support を追加する。
5. compile/decision history と feedback 用に `context-still-runs.sqlite` を追加する。
6. agent ingest を `context-still-ingest.sqlite` へ移す。
7. queues と review workflows を `context-still-workflow.sqlite` へ移す。
8. audit、usage logs、snapshots、evidence cache を `context-still-ops.sqlite` へ移す。
9. file roles が安定した後、Tauri の database location、backup、export/import、health screens を追加する。

この順序は、全 table を一度に rewrite することを避けるためのものであり、最終移行対象を減らす意図ではない。また portable import/export が live queue migration に依存しないようにする。

## Active State Classification Task

SQLite 実装へ入る前に、現行 PostgreSQL schema を次の分類で棚卸しする。

| Class | 意味 | 次の扱い |
|---|---|---|
| active migrate | 現行機能が使っており、SQLite へ移す | SQLite store と migration order を決める |
| active rebuildable | active capability に必要だが row は再生成できる | source rows から rebuild する |
| retention-disposable | retention policy に従って破棄できる | migration window と prune policy を決める |
| legacy delete candidate | 現行コードから不要なら削除する | 削除前に参照と operator impact を確認する |
| uncertain | 参照はあるが実使用が未確定 | code reference、row count、runtime path を追加調査する |

分類時に見るもの:

- `src/db/schema-*.ts` の table 定義。
- repositories、services、CLI、API、MCP tools からの参照。
- migrations 上の現役 table。
- 実 DB の row counts と freshness。
- `doctor` が見る operational state。
- queue、audit、sync、distillation、landscape の実使用経路。

この分類は backend migration の入力であり、Portable Knowledge import/export の scope を広げるためのものではない。

## Open Design Points

- `context_decision_feedback_effects` を compact scoring projection として core に duplicate すべきか。
- 非常に大きな import に備えて、source bodies を `sources.body` に inline し続けるか、content-addressed files と SQLite metadata に移すか。
- `settings` を `context-still-ops.sqlite` に残すか、Tauri-managed config file に移し、SQLite は history のみに使うか。
- backend migration 前に workflow evidence rows を legacy queue-shaped rows ではなく separate historical evidence table にする必要があるか。
- `context-still-runs.sqlite` の retention policy。特に candidate traces と pack items。
- どの tables/features を legacy として削除し、どれを active state として移行するか。

## 現時点の結論

安全な方向は "one SQLite database" でも "core plus logs" でもない。

安全な baseline は次の通り。

```text
context-still-core.sqlite      durable Knowledge and evidence
context-still-runs.sqlite      compile/decision history and feedback
context-still-ingest.sqlite    coding-agent history substrate and sync cursors
context-still-workflow.sqlite  queues, distillation, review workflows
context-still-ops.sqlite       settings, audit, usage logs, caches
```

import/export は、これらの responsibilities をまたいだ portable relational projection として設計する。その projection が durable user-facing contract であり、physical SQLite files は local runtime layout である。
