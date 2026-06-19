# Local-First SQLite And Tauri Concept

## 目的

この文書は、context-still を SQLite、sqlite-vec、SQLite管理のqueue、Tauri control plane を軸にした local-first desktop baseline へ移行するためのコンセプトを定義する。

これは実装計画ではなくコンセプト文書である。今後のマイルストーンを小さく進めつつ、設計方向と境界を残すことを目的にする。

物理的な SQLite ファイル配置は [SQLite Database Layout Audit](sqlite-database-layout-audit.md) で扱う。この監査文書は、durable data と logs の単純な二分割より優先される。

## 位置づけ

context-still は、coding agent のための local user-owned context substrate として扱うべきである。

デフォルトのプロダクト形状は次の方向へ移す。

```text
Tauri desktop app
  -> local SQLite database
  -> sqlite-vec retrieval
  -> local queue workers
  -> MCP server sidecar
  -> Codex / Claude / Antigravity / other coding agents
```

この形は server-first よりもプロジェクトに合っている。価値の高い入力は、基本的に local かつ user-scoped だからである。

- coding-agent session logs
- local source files と wiki files
- local provider settings
- local evaluation と feedback history
- queue と diagnostics の local operational state

server deployment は、file permissions、home-directory paths、privacy、multi-user boundaries、agent-log access の面で摩擦を生む。desktop app なら、履歴を読む対象の coding agents と同じ local user boundary を使える。

## 中核方針

主な利用体験は次から、

```text
clone repo -> install dependencies -> start PostgreSQL/pgvector -> configure services
```

次へ移す。

```text
install app -> open app -> register MCP -> start compiling context
```

PostgreSQL は advanced backend として残してよい。ただし SQLite baseline が十分になった後は、PostgreSQL がデフォルト体験を定義する状態から外す。

## 外部契約

外部の agent-facing contract は MCP-first のままにする。

database や app packaging が変わっても、caller が使う core tools は変えない。

- `initial_instructions`
- `context_compile`
- `compile_eval`
- `context_decision`
- `context_decision_feedback`
- `search_knowledge`
- `register_candidates`
- `register_review_corrections`
- `search_memory`
- `fetch_memory`
- `doctor`

caller は context-still 専用 client、repository、schema、fallback path を意識しなくてよい。MCP server に接続し、context-still を optional external capability として扱えばよい。

## Backend 方針

長期的な backend の位置づけは次の通り。

| Backend | 役割 | 想定ユーザー |
|---|---|---|
| SQLite + sqlite-vec | default desktop backend | individual users と small local workflows |
| PostgreSQL + pgvector | advanced または legacy backend | existing installs、大きな dataset、team/server experiments |

SQLite が実際の default workflow を満たすまでは PostgreSQL を残す。

- Knowledge の import または register
- Knowledge search
- `context_compile` の実行
- compile runs と evaluations の永続化
- `context_decision` と feedback の記録
- agent logs の sync
- local queues の処理
- `doctor` の実行
- data の安全な export/import

これらが安定したら、PostgreSQL は main setup path ではなく advanced mode として文書化できる。

## Knowledge Portability

Knowledge import/export は、migration と trust のための first-class feature である。

これは desktop app 全体の完成を待つべきではない。SQLite を default にする前に、ユーザーが Knowledge と evidence を移動し、backup できる reliable path が必要である。

ただし、portable Knowledge import/export は SQLite backend migration の代替ではない。portable export は operator が inspect/backup/restore しやすい狭い契約であり、SQLite 化は現行 context-still の active state を移す backend migration である。

最初の portable format は退屈で監査しやすいものにする。canonical payload は deterministic SQL と manifest であり、JSONL は後から optional diagnostic companion として追加できる。

```text
context-still-export/
  manifest.json
  checksums.sha256
  sql/
    postgres.sql
    sqlite.sql        # added by the SQLite dialect slice
  evidence-index.json
```

import/export contract は次を保存する。

- 安全な範囲での Knowledge identity
- title、body、type、status、polarity、tags、applicability
- source refs と provenance metadata
- compile evaluation history
- decision feedback history
- schema/export version
- secrets または local-only paths の redaction status

portable Knowledge archive は、active queue row、audit log、provider settings、raw agent logs をそのまま持ち運ぶ契約ではない。これらは SQLite backend migration では別途移行対象になる。

## Backend Migration Scope

SQLite 化では、現行 PostgreSQL/pgvector backend 上で context-still の active behavior に使われている state は原則すべて移行する。

移行対象には次を含める。

- Knowledge と source evidence。
- compile/decision run history、eval、feedback、usage signals。
- coding-agent history ingest state、vibe memories、sync cursors。
- distillation、review、landscape workflow state。
- local settings、audit、LLM usage telemetry、diagnostics。
- active queue state と queue event logs。

例外は「legacy として削除する」と判断した機能だけにする。移行しない table や feature は、rebuildable cache、short-retention data、legacy deletion のいずれなのかを明示する。

pgvector vector columns は portable source of truth ではないが、SQLite 化後に `sqlite-vec` side tables として再構築する。つまり vector values は binary-compatible に持ち運ぶのではなく、active retrieval capability を復元する。

## SQLite Baseline

SQLite は一時的な fallback ではなく、default local persistence layer として設計する。

必要な database behavior は次の通り。

- connection 直後に `PRAGMA foreign_keys=ON` を有効化する
- 通常の desktop operation では WAL mode を使う
- fragile concurrent access failures を避けるため `busy_timeout` を設定する
- write operations は single-writer gate の背後に置く
- 可能な範囲で read paths と write coordination を分離する
- transaction ownership を begin から commit、rollback、close まで明示する
- partial migration 中は raw SQL errors ではなく structured unsupported-capability reasons を返す

実装順序は user-facing critical path から小さく進める。ただし最終的な SQLite baseline は、legacy 削除対象を除く active context-still state をすべて所有する。

## sqlite-vec Baseline

sqlite-vec は `context_compile` と関連 diagnostics に必要な vector search を担う。

vector table contract は明示する。

- 初期対象は `knowledge_items` と `source_fragments` とする
- `knowledge_items_vec` は `context_compile` の Knowledge retrieval に使う
- `source_fragments_vec` は Knowledge の根拠確認、source search、補助 retrieval に使う
- query embedding は vector search 実行時の一時入力として生成する。初期 baseline では query embedding の永続化や sqlite-vec index 化を必須にしない
- `context_compile_task_traces.embedding` は診断用に保存するが、初期 sqlite-vec retrieval surface には含めない
- `vibe_memories` は現行通常経路では embedding 生成・vector search をしていないため、初期 sqlite-vec 対象に含めない
- vec table dimension は configured embedding model dimension と一致する
- vector rows は Top-K search 後に Knowledge または source metadata へ join する
- vector rebuild は通常の maintenance operation として扱う
- embedding model の変更には new vector table または rebuild plan が必要
- `doctor` は vector capability と dimension compatibility を報告する

SQLite と pgvector が同一であるかのように扱わない。両者が共有すべきなのは context-still の repository/service contract である。

## SQLite Queue Baseline

desktop queue は SQLite-managed かつ lease-based にする。

最小 job shape は次を含む。

- `id`
- `queue_name`
- `status`
- `priority`
- `payload`
- `attempt_count`
- `max_attempts`
- `locked_until`
- `last_error`
- `created_at`
- `updated_at`

queue workers は job を1件 claim し、処理後に completed、failed、retryable、skipped のいずれかへ mark する。

最初の desktop queue goal は distributed throughput ではなく operational predictability である。single-user local execution を baseline とする。

## Tauri Control Plane

Tauri app は local control plane になる。

- database location と backup
- Knowledge import/export
- MCP registration と removal
- agent-log sync status
- queue supervisor status
- provider と embedding health
- `doctor` summary と next actions
- 既存 React app の admin UI screens

MCP server は sidecar または shim-managed process として残す。Tauri は登録、起動、停止、health 表示を担えるが、external callers は引き続き MCP 経由で通信する。

## マイルストーン

### Milestone 0: Concept And Boundaries

目標:

- この文書を今後の slice の baseline として残す
- context-still が local-first かつ MCP-first であることを文書化する
- PostgreSQL を target default ではなく advanced mode として残す

完了条件:

- concept document が存在する
- 後続の implementation plans がこの文書を参照できる

### Milestone 1: Portable Knowledge Export

目標:

- 現行 PostgreSQL backend から durable Knowledge assets を export する

範囲:

- SQL archive または zip-compatible export
- schema version を含む manifest
- Knowledge、source links、source metadata、compile evals、decision feedback
- secrets と machine-local paths の redaction policy

範囲外:

- full queue state export
- binary backups
- cross-machine path rewriting

完了条件:

- backend migration 前に重要な Knowledge assets を export できる

### Milestone 2: Portable Knowledge Import

目標:

- exported Knowledge を empty store または existing store に import する

範囲:

- dry-run summary
- conflict strategy
- stable content identity による duplicate detection
- import report

範囲外:

- すべての conflicting Knowledge の automatic merge
- runtime locks または pending queue state の保存

完了条件:

- clean local database へ export を round-trip し、有用な search を実行できる

### Milestone 3: Database Provider Boundary

目標:

- application が database provider を明示的に選べるようにする

範囲:

- `postgres` provider は現行 behavior を維持する
- `sqlite` provider は limited capability flag の背後で存在できる
- repository/service contracts が node-postgres details を前提にしない
- `doctor` が selected provider と unsupported capabilities を報告する

範囲外:

- full SQLite parity
- PostgreSQL error 後の silent fallback to SQLite

完了条件:

- PostgreSQL behavior が安定している
- SQLite が limited smoke path で選択でき、abstraction を壊さない

### Milestone 4: SQLite Text-Only Knowledge Path

目標:

- SQLite 上で basic Knowledge storage と text retrieval を実行する

範囲:

- core Knowledge と source link tables の schema
- Knowledge の insert/list/search
- SQLite に対する import/export
- text-only `context_compile` smoke

範囲外:

- vector search parity
- graph と landscape parity

完了条件:

- 最小 SQLite database が vector search なしで有用な `context_compile` を支えられる

### Milestone 5: sqlite-vec Retrieval

目標:

- SQLite backend に vector search を追加する

範囲:

- sqlite-vec table setup
- embedding dimension checks
- Top-K search と metadata join
- vector rebuild command
- `doctor` vector diagnostics

範囲外:

- exact pgvector ranking parity
- すべての landscape graph query

完了条件:

- SQLite-backed `context_compile` が vector candidates を使え、degraded vector states を説明できる

### Milestone 6: SQLite Queue

目標:

- local worker queues を desktop operation 用に SQLite へ移す

範囲:

- lease-based queue schema
- one-job claim/process/complete loop
- failed/retryable handling
- `doctor` queue health

範囲外:

- distributed workers
- cross-machine locking
- high-throughput queue optimization

完了条件:

- local distillation または sync jobs を SQLite から処理でき、health が見える

### Milestone 7: Tauri Shell

目標:

- 既存 admin UI と local services を desktop shell で包む

範囲:

- 現行 React admin UI を Tauri 内で開く
- database location を設定する
- `doctor` を表示する
- local workers を start/stop する
- MCP server を register/remove する

範囲外:

- すべての admin screen の redesign
- CLI entrypoints の削除
- MCP 利用に Tauri を必須化すること

完了条件:

- ユーザーが app を install/open し、PostgreSQL を手動起動せず coding agent を MCP 経由で接続できる

### Milestone 8: Default SQLite Desktop Mode

目標:

- SQLite/Tauri を新規ユーザー向け recommended path にする

範囲:

- docs update
- startup/onboarding update
- desktop packaging では default database provider を SQLite にする
- PostgreSQL docs を advanced mode へ移す

範囲外:

- PostgreSQL support の削除
- existing installs の強制 migration

完了条件:

- 新規ユーザーが desktop app から始めて、動作する local context-still setup を得られる

## Migration Policy

SQLite desktop mode が実証されるまで、migration は reversible にする。

ルール:

- SQLite が import/export と `context_compile` を持つまで PostgreSQL code を削除しない
- user data を silent migrate しない
- PostgreSQL errors 後に SQLite を hidden fallback にしない
- selected database provider を必ず `doctor` に表示する
- destructive migration steps の前に export を使える状態にする
- backend 間で MCP tool behavior を安定させる

## Privacy And Local Data

local-first baseline は accidental data exposure を減らすべきである。

設計上の含意:

- agent-log sync は local user paths から読む
- secrets は local configuration に残し、Knowledge exports には入れない
- export は machine-local paths を識別し、redaction できるようにする
- Tauri は cloud sync を意味しない
- external LLM/search providers は opt-in configuration のままにする

## Non-Goals

この concept で次を導入しない。

- hosted SaaS behavior
- multi-tenant server assumptions
- 他 app 内の context-still-specific client
- database providers 間の silent fallback
- early milestone での full PostgreSQL removal
- distributed queue semantics
- cloud sync
- implementation-level schema diffs
- すべての admin UI screens の rewrite

## Adoption Principle

最初に価値がある変更は Tauri そのものではない。

最初に価値がある変更は portability である。

```text
export Knowledge -> import Knowledge -> run context_compile on SQLite
```

その後で、Tauri は risky rewrite ではなく packaging と control-plane の改善になる。
