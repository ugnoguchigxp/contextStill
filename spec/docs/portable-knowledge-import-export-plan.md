# Portable Knowledge Import/Export Draft Plan

> 状態: draft。実装前に Slice 0 を完了すること
> 関連コンセプト: [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md)
> レイアウト監査: [SQLite Database Layout Audit](sqlite-database-layout-audit.md)

## 使う場面

- SQLite と Tauri への移行前に、最初の portable Knowledge import/export capability を実装するとき。
- durable user assets の reliable backup/restore path を作るとき。
- user Knowledge を一つの backend に閉じ込めず、context-still を PostgreSQL-first operation から SQLite desktop operation へ移す準備をするとき。

この計画は、Slice 0 完了後に implementation-oriented になる。broad data warehouse export plan ではなく、full database backup design でもない。

Slice 1 以降は、Slice 0 が SQLite layout audit に対して asset boundary、evidence projection、multi-store import policy を解決するまで実装してはいけない。

## Backend Migration との関係

この計画は Portable Knowledge import/export の契約であり、SQLite backend migration の完全な置き換えではない。

SQLite 化では、現行 context-still の active behavior に使われている PostgreSQL/pgvector state は原則すべて移行する。queue、audit、usage telemetry、settings、agent ingest、run history、workflow state は、portable Knowledge archive には含めない場合でも、backend migration では別の SQLite store へ移す。

移行しないものは、legacy 機能として削除する、rebuildable cache として再生成する、または retention policy に従って破棄できる short-retention data として扱う。silent skip はしない。

## 確定している判断

- 最初の実装は runtime state ではなく durable Knowledge assets を export する。
- 最初の import/export path は CLI-first かつ service-backed にする。
- export format は SQL files と manifest からなる directory または zip-compatible set にする。
- JSONL は後から diagnostic companion として出せるが、canonical import format は SQL にする。
- export は default で secrets を redact する。
- import は write 前に dry-run を support する。
- PostgreSQL は最初の source backend とする。
- 最初の writable import target は現行 single-store backend とする。
- SQLite support は後から同じ portable row model を消費する。ただし multi-file SQLite import には store-aware staging と recovery plan が必要である。
- Slice 1 では MCP tools は不要である。
- Slice 1 では Tauri UI は不要である。

## 資産境界

持ち運ぶ user assets:

- Knowledge items。
- Knowledge source links。
- exported source links に必要な source records。
- exported source links に必要な source fragments。
- Knowledge origin links。
- exported Knowledge を説明するための historical workflow evidence projections。
- exported Knowledge に接続された context decision evidence と coverage traces。
- Knowledge tag definitions。
- Knowledge community labels。
- Compile evaluation records。
- Knowledge usage feedback events。
- Context decision human/system feedback。

Runtime または environment state:

- Queue rows。
- Running locks。
- LaunchAgent state。
- Provider settings と secrets。
- Raw agent logs。
- Live workflow queue rows。
- LLM usage logs。
- Audit logs。
- Cached graph snapshots。
- Vector embeddings。

runtime state は machine-local、time-sensitive、または reproducible であるため、initial export から除外する。

Evidence は runtime state ではない。Knowledge がなぜ存在するのか、どのように使われたのかを説明する evidence は、可能な限り Knowledge と一緒に移動する。ただし locks、retries、heartbeats を混ぜている workflow tables は、portable にする前に historical evidence records へ project しなければならない。

## 形式

canonical archive layout:

```text
context-still-export/
  manifest.json
  checksums.sha256
  sql/
    postgres.sql
    sqlite.sql        # added by the SQLite dialect slice
  evidence-index.json
```

`manifest.json` shape:

```json
{
  "format": "context-still-portable-export",
  "schemaVersion": 1,
  "createdAt": "2026-06-19T00:00:00.000Z",
  "createdBy": {
    "packageName": "context-still",
    "packageVersion": "0.1.0"
  },
  "source": {
    "databaseProvider": "postgres",
    "embeddingDimension": 384
  },
  "sql": {
    "canonicalDialect": "postgres",
    "availableDialects": ["postgres"],
    "portableSubsetVersion": 1
  },
  "counts": {
    "knowledgeItems": 0,
    "knowledgeSourceLinks": 0,
    "knowledgeOriginLinks": 0,
    "sources": 0,
    "sourceFragments": 0,
    "historicalWorkflowEvidenceRecords": 0,
    "contextDecisionEvidence": 0,
    "contextDecisionCoverageTraces": 0,
    "knowledgeTagDefinitions": 0,
    "knowledgeCommunityLabels": 0,
    "contextCompileEvals": 0,
    "knowledgeUsageEvents": 0,
    "contextDecisionHumanFeedback": 0,
    "contextDecisionFeedback": 0
  },
  "redaction": {
    "enabled": true,
    "secretPlaceholder": "[REMOVED SENSITIVE DATA]",
    "localPathPolicy": "preserve"
  }
}
```

migration target は relational store なので、SQL を primary format として使う。export service は normalized row model を作り、selected dialect 向けに deterministic SQL を emit する。

初期 dialect support:

| Dialect | 役割 |
|---|---|
| `postgres` | 最初の実装と現行 backend restore path |
| `sqlite` | SQLite desktop import の follow-up dialect |

SQL は deterministic にする。

- tables は dependency order で emit する
- columns は fixed order で emit する
- row ごとに1 statement、または小さな deterministic batch にする
- strings と JSON の escaping を安定させる
- IDs と timestamps を明示する
- vector columns は含めない
- provider settings または secrets は含めない

`evidence-index.json` は navigation aid であり source of truth ではない。exported Knowledge IDs から evidence rows、source refs、origin refs、decision evidence への対応を持ち、dry-run や UI が何を持ち運ぶのか説明できるようにする。

portable format には vector columns を含めない。import 後に backend ごとに embeddings を rebuild する。

## Portable SQL ルール

SQL generator は raw PostgreSQL DDL や pgvector-specific expressions を dump してはいけない。

PostgreSQL SQL は必要に応じて PostgreSQL-safe casts を使ってよい。ただし row model は後から SQLite SQL を emit できる程度に portable でなければならない。

ルール:

- JSON と JSONB values は同じ normalized JSON value から emit する。
- Timestamps は ISO strings として emit する。
- Boolean-like values は emit 前に normalize する。
- UUID values は text literals として emit する。
- Vector columns は省略する。
- Generated SQL は、後続 slice が schema bootstrap を明示的に追加しない限り data-only にする。
- file 冒頭には format version、created timestamp、redaction status を含む comments を置く。
- Single-store import は explicit transaction の中で実行する。

SQLite dialect rules for the later slice:

- SQLite schema がより厳密な JSON handling を追加しない限り、JSON values は text として保存する。
- caller が `PRAGMA foreign_keys=ON` を有効化している前提にする。
- import SQL は PostgreSQL-only conflict syntax に依存しない。
- sqlite-vec tables は import SQL で populate しない。vectors は import 後に rebuild する。
- multi-file SQLite import は、単一 transaction がすべての physical database files を安全に cover できるとは仮定しない。
- SQLite dialect slice の初期 rebuild 対象は `knowledge_items_vec` と `source_fragments_vec` に限定する。
- query embedding は import/export 対象ではなく、vector search 実行時に一時生成する。
- `context_compile_task_traces.embedding` は import する場合でも診断用 row data として扱い、初期 sqlite-vec table は作らない。
- `vibe_memories.embedding` は現行通常経路で生成・検索されていないため、初期 portable import 後の vector rebuild 対象に含めない。

## Multi-Store SQLite Import ルール

SQLite layout audit は core、runs、ingest、workflow、ops data を別々の physical files に分けることを提案している。将来、複数 file に write する SQLite import は store-aware でなければならない。

必須ルール:

- core-only import は `context-still-core.sqlite` に対して1つの transaction を使ってよい
- multi-store import は `prepare`、`apply`、`finalize`、`recover` phases を持つ import session journal を使う
- 各 physical SQLite file は自分の transaction を所有する
- cross-file references は write 前と apply 後に検証する
- failed または interrupted imports は、store ごとに recoverable または rolled back として報告する

この rule が実装されるまでは、writable SQLite import は core Knowledge と source evidence store に限定する。

## Evidence Envelope

export は「この Knowledge はなぜ存在し、どこから来たのか」に答えるための evidence を持たなければならない。

Evidence assets は stable source/provenance rows を含む。

- `knowledge_source_links`
- linked `sources`
- linked `source_fragments`
- `knowledge_origin_links`
- exported Knowledge を参照する `context_decision_evidence` rows
- 同じ decision runs の `context_decision_coverage_traces`

Workflow-origin evidence は raw queue-shaped rows ではなく historical projection を使う。この projection は `found_candidates`、`cover_evidence_results`、`evidence_coverage_results`、`find_candidate_results`、`distillation_target_states` から作ってよいが、portable row から active scheduling fields を除外しなければならない。

- evidence identity、source URI、target kind、candidate key、outcome、references、tool events、metadata、timestamps を可能な範囲で保存する
- locks、heartbeats、attempt counters、retry scheduling、active queue status は保存しない
- import するときは historical evidence records としてのみ扱う
- target backend に historical evidence representation がない場合は `skipped_evidence` として報告する

target backend が evidence table を安全に import できない場合、dry-run はその rows を `skipped_evidence` として報告しなければならない。silent drop は禁止する。

## Identity と Conflict Policy

existing source links、usage events、evals、feedback rows は stable IDs を参照するため、stable IDs は default で保存する。

Import mode 一覧:

| Mode | Behavior |
|---|---|
| `dry-run` | files を validate し、rows を count し、conflicts を検出する。write はしない |
| `insert-only` | missing rows を insert し、existing IDs では fail する |
| `upsert` | missing rows を insert し、existing rows を ID で update する |

Slice 2 は `dry-run` を support する。

Slice 3 は `insert-only` を support する。

Slice 5 は conflict reporting が証明された後に `upsert` を追加する。

Conflict reporting は次を含む。

- table/file name
- ID または unique key
- conflict kind
- proposed action

最初の実装では silent に new IDs を生成しない。cross-instance merge が重要になった場合、ID remapping は後続 feature として追加できる。

## Redaction Policy

default redaction mechanism として既存の `redactSecretsFromValue` と `redactSecretRecord` helpers を使う。

既定の behavior:

- secret-looking object keys と string values を redact する
- local file paths は保存する
- redaction settings を manifest に記録する

後続で追加できる behavior:

- `--redact-local-paths`
- `--include-runtime-settings`
- trusted local backups 用の explicit な `--no-redact`

Slice 1 は settings や provider secrets を export に追加してはいけない。

## Workflow

### Slice 0: Reconcile Layout Audit

目標:

- この計画を SQLite layout audit に対して implementation-ready にする。

作業:

1. 残っている stale format references を canonical SQL archive contract に置き換える。
2. portable durable assets、portable learning signals、historical traces、workflow state、caches、short-retention logs に該当する rows を確定する。
3. historical workflow evidence projection と target table、または skipped-evidence behavior を定義する。
4. どの import slices が single-store only で、どれが multi-store SQLite import journal を必要とするか決める。
5. manifest counts と `evidence-index.json` shape を finalized projection に合わせて更新する。
6. Portable Knowledge archive のどの slice も active queue state、locks、audit logs、LLM usage logs、local settings、raw agent logs、vector side tables を import しないことを再確認する。
7. 上記が SQLite backend migration の skip 方針ではないことを明記する。

確認点:

- この文書に stale implementation instructions が残っていない。
- asset boundary が SQLite layout audit と一致している。
- 最初の writable import target と transaction model が明示されている。
- Workflow evidence は historical records へ project されるか、report 付きで明示的に skipped される。
- full backend migration は active contextStill state を原則すべて移行する、という方針と矛盾していない。

### Draft Slice 1: Export Service And CLI

目標:

- 現行 PostgreSQL backend から portable Knowledge assets を export する。

対象ファイル:

- `src/modules/knowledge-portability/export.service.ts`
- `src/modules/knowledge-portability/format.ts`
- `src/modules/knowledge-portability/redaction.ts`
- `src/modules/knowledge-portability/sql-writer.ts`
- `src/modules/knowledge-portability/evidence-envelope.ts`
- `src/cli/export-knowledge.ts`
- `test/knowledge-portability.export.test.ts`
- `test/cli.export-knowledge.test.ts`
- `package.json`
- `spec/pub/cli.md`

作業:

1. `knowledge-portability` module を追加する。
2. manifest、SQL dialect writers、export summary、evidence envelope、redaction options の TypeScript types を定義する。
3. Drizzle または repository helpers 経由で現行 database を query する。
4. portable table ごとに normalized rows を作る。
5. exported `knowledge_source_links` が参照する source rows と source fragments だけを export する。
6. Slice 0 で定義した historical workflow evidence projection を使い、exported Knowledge の evidence envelope を含める。
7. default ですべての exported records を redact する。
8. vector embedding columns を省略する。
9. deterministic `sql/postgres.sql` を emit する。
10. `evidence-index.json` を emit する。
11. row counts が確定した後に `manifest.json` と `checksums.sha256` を生成する。
12. CLI を追加する。

```bash
bun run export:knowledge -- --out ./exports/context-still-export
```

13. package script を追加する。

```json
{
  "export:knowledge": "bun run src/cli/export-knowledge.ts"
}
```

確認点:

- CLI 実行で manifest、checksum file、evidence index、SQL file が作成される。
- manifest count values が table ごとの SQL insert counts と一致する。
- evidence index が exported Knowledge から source、origin、historical workflow evidence、decision-evidence refs へ map する。
- export は Docker-specific container names を必要としない。
- export は hard-coded credentials ではなく `DATABASE_URL` を使う。

重点テスト:

```bash
bunx vitest run test/knowledge-portability.export.test.ts test/cli.export-knowledge.test.ts
bun run typecheck
```

### Draft Slice 2: Import Validation And Dry-Run

目標:

- export directory を database に write せず validate する。

対象ファイル:

- `src/modules/knowledge-portability/import.service.ts`
- `src/cli/import-knowledge.ts`
- `test/knowledge-portability.import-dry-run.test.ts`
- `test/cli.import-knowledge.test.ts`
- `package.json`
- `spec/pub/cli.md`

作業:

1. `manifest.json` を parse する。
2. unsupported `format` を reject する。
3. unsupported `schemaVersion` を reject する。
4. requested SQL dialect availability を validate する。
5. required files が存在するか確認する。
6. checksums を確認する。
7. table insert counts を数えるため、SQL statement boundaries を parse または inspect する。
8. row counts を manifest と照合する。
9. `evidence-index.json` consistency を exported IDs に対して確認する。
10. export 内の referential consistency を確認する。
    - links は exported Knowledge と source fragments を参照する
    - fragments は exported sources を参照する
    - origin links は exported Knowledge を参照する
    - historical workflow evidence は exported Knowledge を参照するか skipped evidence として報告する
    - decision evidence は exported Knowledge を参照するか null/unknown Knowledge refs として報告する
    - evals は supported な形で import される場合のみ exported または existing compile runs を参照する
    - feedback は supported な形で import される場合のみ exported または existing decision runs を参照する
11. target DB に対する conflicts を ID で確認する。
12. single-store target database が利用可能な場合、selected SQL dialect を transaction 内で実行して rollback する。
13. multi-store SQLite target が要求された場合、import session journal を必須にする。なければ write validation 前に fail する。
14. dry-run summary を出す。
15. CLI を追加する。

```bash
bun run import:knowledge -- --from ./exports/context-still-export --dry-run
```

16. package script を追加する。

```json
{
  "import:knowledge": "bun run src/cli/import-knowledge.ts"
}
```

確認点:

- Dry-run は rows を write しない。
- invalid manifest は fail する。
- missing SQL dialect は fail する。
- checksum mismatch は fail する。
- evidence-index mismatch は fail する。
- SQL rollback dry-run の後、target DB は変更されていない。
- conflict summary は deterministic である。

重点テスト:

```bash
bunx vitest run test/knowledge-portability.import-dry-run.test.ts test/cli.import-knowledge.test.ts
bun run typecheck
```

### Draft Slice 3: Insert-Only Import

目標:

- clean export を empty または compatible database に import する。

対象ファイル:

- `src/modules/knowledge-portability/import.service.ts`
- `test/knowledge-portability.import-write.test.ts`
- `test/knowledge-portability.roundtrip.integration.test.ts`

作業:

1. `--mode insert-only` を追加する。
2. write 前に dry-run validation を再利用する。
3. dependency order で rows を insert する。
   - sources
   - source fragments
   - tag definitions
   - Knowledge items
   - Knowledge source links
   - Knowledge origin links
   - supported な場合は historical workflow evidence rows
   - community labels
   - referenced decision runs が存在するか later slice に含まれる場合のみ context decision evidence と coverage traces
   - referenced run rows が存在するか later slice に含まれる場合のみ compile evals
   - referenced compile runs が存在するか later slice に含まれる場合のみ usage events
   - referenced decision runs が存在するか later slice に含まれる場合のみ decision feedback
4. single-store SQL を1つの database transaction で実行する。
5. multi-store SQLite import では import session journal と per-store transactions を使う。
6. conflict または missing dependency があれば whole import を fail する。
7. inserted counts と skipped-evidence counts を返す。

確認点:

- populated test DB からの export を clean test DB へ import できる。
- imported Knowledge が searchable である。
- imported source links が存在する。
- imported evidence links を Knowledge から source、origin、historical workflow evidence、decision evidence へ trace できる。
- `context_compile` が imported Knowledge を選択できる。

重点テスト:

```bash
bunx vitest run test/knowledge-portability.import-write.test.ts test/knowledge-portability.roundtrip.integration.test.ts
bun run typecheck
```

### Draft Slice 3.5: Isolated PostgreSQL Roundtrip Trial

目標:

- 現在運用している `context_still` database を import target にせず、別の PostgreSQL database で export/import roundtrip を試す。
- 実装の正しさだけでなく、operator 手順として安全に backup/restore rehearsal できることを確認する。

この slice は SQLite へ進む前の実地検証である。既存 docker pgvector service を直接破壊的に使うのではなく、source database と target database を明示的に分ける。

DB 方針:

| Role | 用途 | 例 |
|---|---|---|
| source DB | 現在の Knowledge を export する読み取り元 | `postgres://postgres:postgres@localhost:7889/context_still` |
| target DB | import rehearsal 用の空 DB | `postgres://postgres:postgres@localhost:7889/context_still_import_roundtrip` |

target DB は既存運用 DB と別名にする。より強く分離したい場合は、別 port の disposable pgvector container を使ってもよい。ただし計画とコマンドは `DATABASE_URL` で切り替え、container name には依存しない。

作業:

1. source DB の現状 backup を取得する。既存の full DB backup と portable export は別物なので、可能なら `./scripts/backup-db.sh` も実行する。
2. target DB 名を決める。例: `context_still_import_roundtrip`。
3. target DB を作成し、migrations を適用して schema を揃える。
4. source DB から portable export を作る。
5. target DB に対して import dry-run を実行する。
6. target DB に対して `--mode insert-only` を実行する。
7. target DB 上で row counts と evidence refs を確認する。
8. target DB 上で `doctor` または軽い Knowledge query を実行する。
9. 可能なら `context_compile` smoke を実行し、imported Knowledge が候補として使われることを確認する。
10. 結果を記録する。target DB は default で削除し、調査のために残す場合だけ `KEEP_TARGET_DB=1` を明示する。

推奨コマンド例:

```bash
RUN_FULL_BACKUP=1 bun run knowledge:roundtrip:trial
```

この script は default で target DB を削除する。target DB を残して手動確認したい場合だけ次を使う。

```bash
KEEP_TARGET_DB=1 RUN_FULL_BACKUP=1 bun run knowledge:roundtrip:trial
```

手順を個別に確認したい場合:

```bash
# 0. source を明示する
export SOURCE_DATABASE_URL='postgres://postgres:postgres@localhost:7889/context_still'
export TARGET_DATABASE_URL='postgres://postgres:postgres@localhost:7889/context_still_import_roundtrip'
export MAINTENANCE_DATABASE_URL='postgres://postgres:postgres@localhost:7889/postgres'
export TARGET_DATABASE_NAME='context_still_import_roundtrip'

# 1. target DB を作成する。既に存在する場合は別名にするか、明示的に破棄してよい時だけ作り直す。
psql "$MAINTENANCE_DATABASE_URL" -c "create database ${TARGET_DATABASE_NAME};"

# 2. target schema を current migrations に合わせる
DATABASE_URL="$TARGET_DATABASE_URL" bun run db:migrate

# 3. source から export する
DATABASE_URL="$SOURCE_DATABASE_URL" bun run export:knowledge -- --out ./exports/context-still-roundtrip

# 4. target に対して dry-run
DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from ./exports/context-still-roundtrip --dry-run

# 5. target に insert-only import
DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from ./exports/context-still-roundtrip --mode insert-only

# 6. target 側 health check
DATABASE_URL="$TARGET_DATABASE_URL" bun run doctor
```

target DB が既に存在する場合、既存の rehearsal data を残すなら別名を使う。破棄してよいと明示できる場合だけ、maintenance DB から `drop database context_still_import_roundtrip;` を実行して作り直す。

確認点:

- source DB は import target として使われていない。
- target DB は import 前に空、または rehearsal 用として明示的に破棄可能である。
- target DB は default で cleanup され、`KEEP_TARGET_DB=1` を指定したときだけ残る。
- `manifest.json` counts と target DB の imported row counts が一致する。
- `knowledge_source_links`、`source_fragments`、`sources` の参照が target DB 内で切れていない。
- `knowledge_origin_links` と `knowledge_quality_adjustments` が target DB で Knowledge に接続されている。
- `insert-only` を同じ target DB に再実行すると duplicate conflict で失敗し、部分 import が残らない。
- export/import の CLI は Docker container name に依存せず、`DATABASE_URL` の切り替えだけで動く。
- source DB に追加 write が発生していない。

記録する結果:

- source DB URL の database name。
- target DB URL の database name。
- export directory path。
- exported counts。
- dry-run summary。
- insert-only summary。
- target DB row counts。
- conflict 再実行テスト結果。
- `doctor` または `context_compile` smoke の結果。

### Draft Slice 4: Compile And Decision History Envelope

目標:

- Knowledge quality を migration 後も有用に保つため、十分な evaluation と feedback history を保存する。

未確定の設計点:

- `context_compile_evals`、`knowledge_usage_events`、decision feedback は run rows を参照するが、新しい local database へ full import しても有用とは限らない。
- `context_decision_evidence` と coverage traces は、early slices で fully imported されない可能性がある decision runs を参照する。

初期ルール:

- Slice 1 でこれらの rows を export する。
- Slice 2 で import validation が parse する。
- Insert-only import は、referenced run rows が target DB に存在するか later slice に含まれる場合を除き、run-dependent rows を skip する。
- later slice で、full runs を再作成せず feedback を metadata として保存する compact history envelope を追加してよい。

確認点:

- Export は rows を失わない。
- Import は dangling foreign keys を作らない。
- skipped rows を明確に報告する。
- dangling references なしで Knowledge に link できる evidence rows は import するか、明示的に skipped と報告する。

### Draft Slice 5: Upsert Import

目標:

- existing database への restore を可能にする。

作業:

1. `--mode upsert` を追加する。
2. table ごとの update fields を定義する。
3. 明示的に replace する場合を除き、target-side `created_at` を保存する。
4. imported row が newer の場合のみ `updated_at` を import row から更新する。
5. inserted、updated、skipped、conflicted counts を報告する。

確認点:

- 同じ export の re-import が idempotent である。
- explicit flag なしに local newer edits を上書きしない。

### Draft Slice 6: API And Admin UI

目標:

- 既存 admin control plane から import/export を使えるようにする。

対象ファイル:

- `api/modules/knowledge-portability/knowledge-portability.routes.ts`
- `web/src/modules/admin/components/settings.page.tsx` または dedicated portability page
- API と UI tests

作業:

1. export job を開始するか prepared file path を返す export endpoint を追加する。
2. import dry-run endpoint を追加する。
3. import apply endpoint を追加する。
4. counts、conflicts、skipped rows、redaction status を表示する。
5. すべての routes に admin auth を要求する。

確認点:

- UI は apply 前に dry-run を実行できる。
- dry-run に blocking errors がある場合、apply は disabled になる。

### Draft Slice 7: MCP Tool Consideration

目標:

- MCP が portability を expose すべきか決める。

既定の答え:

- CLI/API/UI が安定するまで MCP 経由で import/export を expose しない。

理由:

- Import/export は大きな local data を移動し得るため、通常の agent context retrieval より operator control に近い。

後から追加する場合、tool names は明示的にし、dry-run first にする。

- `export_knowledge_archive`
- `import_knowledge_archive_dry_run`

強い operator confirmation story なしに write import MCP tool を追加しない。

### Draft Slice 8: SQLite Consumer

目標:

- same portable SQL row model を使って future SQLite backend を seed する。

作業:

1. SQLite SQL dialect emitter を追加する。
2. 同じ service contract の背後に SQLite import adapter を実装する。
3. temporary SQLite database に対して SQLite SQL を validate する。
4. import 後に `knowledge_items_vec` と `source_fragments_vec` を rebuild する。
5. まず text-only compile smoke を実行する。
6. vector support が存在した後に sqlite-vec rebuild を追加する。

確認点:

- PostgreSQL export から SQLite SQL を生成し、SQLite へ import できる。
- `context_compile` が imported SQLite Knowledge 上で動作する。

## 検証

### 必須の受け入れ条件

- Export が `manifest.json`、`checksums.sha256`、`evidence-index.json`、SQL files を書き出す。
- Manifest counts が SQL insert counts と一致する。
- Export は default で secrets を redact する。
- Export は embeddings と runtime settings を省略する。
- Export は source evidence、origin links、historical workflow evidence、decision evidence を利用可能な範囲で含む。
- Import dry-run は rows を write しない。
- Import は missing dialect、checksum mismatch、evidence-index mismatch を報告する。
- Insert-only import は transactional である。
- Insert-only import は既存運用 DB ではなく isolated target DB で roundtrip rehearsal されている。
- Round-trip import は searchable Knowledge を生成する。
- Round-trip import は target schema が support する範囲で traceable evidence を保存する。
- `context_compile` が integration test で imported Knowledge を使える。
- 既存の `db:seed` と `db:seed:export` behavior は変わらない。

### 推奨検証コマンド

Slice 1:

```bash
bunx vitest run test/knowledge-portability.export.test.ts test/cli.export-knowledge.test.ts
bun run typecheck
```

Slice 2:

```bash
bunx vitest run test/knowledge-portability.import-dry-run.test.ts test/cli.import-knowledge.test.ts
bun run typecheck
```

Slice 3:

```bash
bunx vitest run test/knowledge-portability.import-write.test.ts test/knowledge-portability.roundtrip.integration.test.ts
bun run typecheck
```

Slice 3.5:

```bash
RUN_FULL_BACKUP=1 bun run knowledge:roundtrip:trial
```

Keep the target DB for manual inspection:

```bash
KEEP_TARGET_DB=1 RUN_FULL_BACKUP=1 bun run knowledge:roundtrip:trial
```

Manual equivalent:

```bash
export SOURCE_DATABASE_URL='postgres://postgres:postgres@localhost:7889/context_still'
export TARGET_DATABASE_URL='postgres://postgres:postgres@localhost:7889/context_still_import_roundtrip'
export MAINTENANCE_DATABASE_URL='postgres://postgres:postgres@localhost:7889/postgres'
export TARGET_DATABASE_NAME='context_still_import_roundtrip'

psql "$MAINTENANCE_DATABASE_URL" -c "create database ${TARGET_DATABASE_NAME};"
DATABASE_URL="$TARGET_DATABASE_URL" bun run db:migrate
DATABASE_URL="$SOURCE_DATABASE_URL" bun run export:knowledge -- --out ./exports/context-still-roundtrip
DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from ./exports/context-still-roundtrip --dry-run
DATABASE_URL="$TARGET_DATABASE_URL" bun run import:knowledge -- --from ./exports/context-still-roundtrip --mode insert-only
DATABASE_URL="$TARGET_DATABASE_URL" bun run doctor
```

Final gate after implementation:

```bash
bun run verify
```

Integration tests が database に触れる場合:

```bash
bun run test:integration
```

## 避けること

- 最初の実装で provider secrets または runtime settings を export しない。
- portable format に vector embedding columns を含めない。
- queue rows、locks、LaunchAgent state を export しない。
- evidence を silent drop しない。Import は evidence を import するか skipped として報告する。
- IDs を silent remap しない。
- database providers 間で silent fallback しない。
- `db:seed` semantics を portability semantics で置き換えない。
- 最初の実装で MCP 経由の write import を expose しない。
- CLI import/export の prerequisite として Tauri を要求しない。
- database credentials または Docker container names を hard-code しない。
- raw agent logs を Knowledge portability の一部として扱わない。

## Existing Seed Export との関係

`db:seed:export` と `db:seed` は seed snapshot utilities である。参考にはなるが、portable backup/restore contract ではない。

新しい portability path は次の点で異なる。

- Docker container shelling ではなく `DATABASE_URL` を使う
- one large JSON document ではなく deterministic SQL を emit する
- counts と redaction policy を含む manifest を書く
- dry-run import を support する
- conflicts を deterministic に報告する
- 可能な範囲で Knowledge と一緒に evidence envelope を運ぶ
- runtime state を scope 外に置く

最初の実装中は両方の path を残す。Seed export は curated repo seed data に有用であり、portable export は user-owned local assets のためのものにする。
