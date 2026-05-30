# Knowledge Relations Overview 実装計画

更新日: 2026-05-30  
Status: implementation plan

## 1. 結論

Overview の `Knowledge Linkage` は、単一指標として広げず、用途別の関連指標へ分解する。

実装方針は次で固定する。

1. 既存の `Knowledge Linkage` は廃止しない。名称を `Source Evidence` または `Source Evidence Linkage` に改め、`knowledge_source_links` ベースの厳密な根拠リンク指標として残す。
2. `vibe_memory:` / `agent://candidate` / `landscape://` などは `knowledge_source_links` に混ぜない。新しい origin linkage として別管理する。
3. Overview では `Knowledge Linkage` という単一表示をやめ、`Knowledge Relations` または `Traceability` セクションとして複数指標を並べる。
4. community / attractor / landscape は総合 linkage 率にしない。`orphan`、`weak community`、`thin evidence community` など、次のアクションに結びつく health 指標として扱う。
5. 既存データへの関連付けは、後追い backfill script で補完する。ただし source evidence / origin / graph health は別定義を維持する。

## 2. 背景

現行 Overview は `knowledge_source_links` に 1 件以上つながる knowledge を `linkedKnowledge` として数え、UI では `Knowledge Linkage` と表示している。

現在の実装アンカー:

- `api/modules/overview/overview.repository.ts`
  - `knowledge_source_links` から distinct `knowledge_id` を集計し、`linkedKnowledge` / `unlinkedKnowledge` を返す。
- `src/shared/schemas/overview.schema.ts`
  - `linkedKnowledge` / `unlinkedKnowledge` を KPI schema に持つ。
- `web/src/modules/admin/components/overview/knowledge-assets-domain.tsx`
  - `Knowledge Linkage` ラベルで `linkedKnowledge / knowledgeTotal` を表示する。
- `src/cli/backfill-knowledge-source-links.ts`
  - 既存 knowledge の metadata references を `sources` / `source_fragments` に解決し、`knowledge_source_links` を補完する。

この設計は source evidence の監査には正しい。一方で、`vibe_memory` や `mcp register_candidate` 由来の knowledge は、作成元を追えるにもかかわらず `knowledge_source_links` には入らないため、Overview 上は未リンクに見える。

## 3. 現状ベースライン

2026-05-30 時点のローカル DB で確認した概算:

| 指標 | 件数 | 比率 |
|---|---:|---:|
| knowledge total | 1495 | 100.0% |
| source evidence linked | 594 | 39.7% |
| non-source origin linkable | 887 | 59.3% |
| source evidence OR non-source origin | 1481 | 99.1% |
| unresolved local-path source evidence | 14 | 0.9% |

origin family の内訳:

| family | 件数 |
|---|---:|
| `vibe_memory` | 687 |
| `agent_uri` | 198 |
| `landscape` | 2 |
| `local_path` | 607 |
| `other` | 1 |

この数字から分かること:

- `Source Evidence Linkage` は低いが、由来追跡不能な knowledge が大量にあるわけではない。
- `vibe_memory` / `agent://candidate` は source evidence ではなく origin なので、`knowledge_source_links` に混ぜると意味が崩れる。
- `local_path` の未リンク 14 件は origin ではなく、source corpus 側の未解決として扱う。

## 4. 指標定義

### 4.1 Source Evidence Linkage

目的:

- knowledge が wiki/source fragment に根拠として接続されているかを見る。
- 監査、再検証、Graph evidence view、ranking の source link boost に使う。

定義:

```text
sourceEvidenceLinkedKnowledge
= distinct knowledge_source_links.knowledge_id

sourceEvidenceUnlinkedKnowledge
= knowledgeTotal - sourceEvidenceLinkedKnowledge
```

実装方針:

- 既存 `linkedKnowledge` / `unlinkedKnowledge` と同じ意味。
- UI 表示名を `Knowledge Linkage` から `Source Evidence` に変える。
- API 互換のため、Phase 1 では `linkedKnowledge` / `unlinkedKnowledge` を残しつつ、新しい明示名を追加する。

### 4.2 Origin Traceability

目的:

- knowledge の作成元、登録元、抽出元を追跡できるかを見る。
- `vibe_memory`、MCP `register_candidate`、landscape review item 由来の知識を「根拠 source はないが由来はある」と区別する。

対象 origin:

- `vibe_memory:<memory_id>`
- `agent://candidate/<candidate_id>`
- `landscape://review-item/...`

初期スコープ外:

- `file://` や absolute local path は source evidence 側で扱う。
- web URL は source ingest が必要なため、Phase 1 の origin link には含めない。

定義:

```text
originLinkedKnowledge
= distinct knowledge_origin_links.knowledge_id

provenanceTraceableKnowledge
= distinct knowledge ids with source evidence link OR origin link

provenanceUntraceableKnowledge
= knowledgeTotal - provenanceTraceableKnowledge
```

見込み:

```text
source evidence OR non-source origin = 1481 / 1495 = 99.1%
```

### 4.3 Graph / Landscape Health

目的:

- knowledge が知識群の中でどう使われているか、どこが弱いかを見る。
- retrieval 多様性、重複統合、review 優先度、dead zone / attractor の判断に使う。

指標例:

- `orphanKnowledgeCount`
- `weakCommunityCount`
- `thinEvidenceCommunities`
- `highUseLowEvidenceCommunities`
- `deadZoneReachabilityCount`
- `overSelectedNotUsedCount`

実装方針:

- `Graph Connectedness: 100%` のような総合 linkage KPI は作らない。
- Graph / Landscape snapshot から、次のアクションに結びつく health 指標だけを Overview に出す。
- 既存 `sourceCoveredCommunities` / `sourceThinCommunities` / `sourceMissingCommunities` は維持し、必要に応じて文言を整理する。

## 5. データモデル

### 5.1 新テーブル `knowledge_origin_links`

`knowledge_source_links` とは別に、作成元を表す link table を追加する。

想定カラム:

| column | type | 内容 |
|---|---|---|
| `id` | uuid | primary key |
| `knowledge_id` | uuid | `knowledge_items.id` |
| `origin_kind` | text | `vibe_memory` / `agent_candidate` / `landscape_review_item` |
| `origin_uri` | text | 元の URI 全体 |
| `origin_key` | text | URI から抽出した安定 key |
| `confidence` | numeric | 初期値 `1.0` |
| `metadata` | jsonb | backfill source、解決詳細 |
| `created_at` | timestamptz | 作成時刻 |

制約:

- `unique(knowledge_id, origin_kind, origin_uri)`
- `knowledge_id` は `knowledge_items(id)` へ foreign key
- `origin_kind` は check constraint で初期 family を制限する

設計判断:

- origin link は source evidence ではないため `knowledge_source_links` には保存しない。
- `local_path` は origin link にしない。source corpus に存在すれば `knowledge_source_links`、存在しなければ unresolved source evidence として残す。
- `vibe_memory` など対象テーブルへの foreign key は Phase 1 では張らない。URI と key を保存し、後続で必要なら typed FK を追加する。

### 5.2 Seed / export

`knowledge_origin_links` を作る場合、seed/export も対象に入れる。

対象:

- `scripts/export-knowledge-seed.sh`
- `src/db/seed.ts`
- `src/db/seeds/knowledge-seed.json` の更新方針

Phase 1 では migration と runtime query を優先し、seed 更新は実装後に artifact policy を確認してから行う。

## 6. Backfill script

### 6.1 追加コマンド

`package.json` に追加する。

```json
{
  "backfill:knowledge-origin-links": "bun run src/cli/backfill-knowledge-origin-links.ts"
}
```

### 6.2 CLI 仕様

デフォルトは dry-run。

```bash
bun run backfill:knowledge-origin-links --dry-run --limit 5000 --json
bun run backfill:knowledge-origin-links --apply --limit 5000 --json
```

オプション:

| option | default | 内容 |
|---|---:|---|
| `--dry-run` | true | insert せず計画だけ出す |
| `--apply` | false | insert する |
| `--limit <n>` | all | 新しい順に scan する件数 |
| `--include-linked` | false | 既存 origin link ありの knowledge も再評価する |
| `--json` | false | JSON 出力 |

出力:

```json
{
  "ok": true,
  "dryRun": true,
  "scannedKnowledgeRows": 1495,
  "originCandidateKnowledgeRows": 887,
  "plannedLinkCount": 887,
  "insertedLinkCount": 0,
  "existingLinkedPairCount": 0,
  "originKindCounts": {
    "vibe_memory": 687,
    "agent_candidate": 198,
    "landscape_review_item": 2
  },
  "ignoredFamilyCounts": {
    "local_path": 607
  }
}
```

### 6.3 抽出ルール

対象 field:

- `metadata.sourceDocumentUri`
- `metadata.sourceUri`

初期対象:

| URI prefix | `origin_kind` | `origin_key` |
|---|---|---|
| `vibe_memory:` | `vibe_memory` | prefix 後の id |
| `agent://candidate/` | `agent_candidate` | path 後の id |
| `landscape://review-item/` | `landscape_review_item` | URI 全体、または review item id |

無視するもの:

- `cover-evidence-result://`
- `memory-router://`
- `search:`
- `file://`
- absolute local path
- http/https web URL

web URL は Phase 2 以降の `sources` ingest 対象であり、origin link にはしない。

### 6.4 Idempotency

- `knowledge_origin_links` の unique constraint で重複を防ぐ。
- CLI 側でも existing pair を先読みし、`plannedLinkCount` と `existingLinkedPairCount` を分けて出す。
- `--include-linked` は修復・再計測用であり、通常運用では不要。

## 7. Overview API / Schema

### 7.1 KPI 追加

`overviewDashboardKpisSchema` に追加する。

```ts
sourceEvidenceLinkedKnowledge: z.number().int().nonnegative()
sourceEvidenceUnlinkedKnowledge: z.number().int().nonnegative()
originLinkedKnowledge: z.number().int().nonnegative()
originUnlinkedKnowledge: z.number().int().nonnegative()
provenanceTraceableKnowledge: z.number().int().nonnegative()
provenanceUntraceableKnowledge: z.number().int().nonnegative()
originLinksByKind: z.record(z.string(), z.number().int().nonnegative())
```

互換:

- `linkedKnowledge` は `sourceEvidenceLinkedKnowledge` の legacy alias として Phase 1 では残す。
- `unlinkedKnowledge` は `sourceEvidenceUnlinkedKnowledge` の legacy alias として Phase 1 では残す。
- UI は新フィールドを使う。

### 7.2 Repository 集計

`fetchOverviewKnowledgeAssetsDomainForApi()` の knowledge summary CTE を拡張する。

必要な集合:

```sql
source_linked as (
  select distinct knowledge_id from knowledge_source_links
),
origin_linked as (
  select distinct knowledge_id from knowledge_origin_links
),
provenance_traceable as (
  select knowledge_id from source_linked
  union
  select knowledge_id from origin_linked
)
```

別途 `origin_kind` ごとの breakdown を集計する。

期待値:

- `sourceEvidenceLinkedKnowledge` は現行 `linkedKnowledge` と同じ。
- `provenanceTraceableKnowledge` は source evidence と origin の union。
- `originLinkedKnowledge` は origin link 単体。

## 8. Overview UI

### 8.1 セクション名

`Knowledge Linkage` 表示を `Knowledge Relations` または `Traceability` に変更する。

推奨表示:

```text
Knowledge Relations
Source Evidence      594/1495 (39.7%)
Provenance Traceable 1481/1495 (99.1%)
Origin Links         887 items
Unresolved Sources   14 items
```

表記ルール:

- `Linked` という単語だけで済ませない。何に linked しているかを明示する。
- `Source Evidence` は source/wiki fragment への根拠リンク。
- `Provenance Traceable` は source evidence または non-source origin で由来を追える状態。
- `Origin Links` は `vibe_memory` / `agent_candidate` / `landscape_review_item` の内訳を表示する。

### 8.2 Graph / Landscape 表示

Overview の同じカード内に、総合率ではなく warning-oriented な値だけを置く。

候補:

```text
Graph Health
Orphan: 459
Thin Evidence Communities: 86
No-Source Communities: N
```

`Graph Connectedness 100%` のような表示は採用しない。判別力が弱く、改善アクションに直結しないため。

### 8.3 テスト互換

`test/components/admin/overview-page.test.tsx` は次を変更する。

- `Knowledge Linkage` 文言の期待値を `Source Evidence` / `Knowledge Relations` に変更する。
- `All items successfully linked` は `All items have source evidence` のように意味を限定する。
- `sr-only` の互換文字列は新 KPI 名へ更新する。

## 9. Graph / Landscape 連携

Phase 1 では Graph の edge 生成は必須にしない。Overview の KPI と origin backfill を先に作る。

Phase 2 候補:

- Graph `evidence` view に origin node / origin edge を追加する。
- edge type は `linked_origin` とし、`linked_source` とは分ける。
- source node と origin node は visual group を分ける。
- `GraphRelationAxis` に origin を追加するかは、UI で使う目的が明確になってから判断する。

採用しないもの:

- community membership を `knowledge_source_links` に変換する。
- semantic neighbor を origin link として保存する。
- Graph connectedness を ranking boost に直結する。

## 10. 実装フェーズ

### Phase 0: Baseline 固定

実施:

1. 現在の Overview 指標を JSON で保存する。
2. `backfill:knowledge-source-links --dry-run` を実行し、source evidence 側の未解決を確認する。
3. origin family の件数を SQL で固定する。

完了条件:

- source evidence / origin / graph health の初期値が記録されている。
- `knowledge_source_links` に追加できる候補が残っていないか確認済み。

### Phase 1: Naming と schema の非破壊追加

実施:

1. `overviewDashboardKpisSchema` に新 KPI を追加する。
2. `fetchOverviewKnowledgeAssetsDomainForApi()` で source evidence の明示名を返す。
3. UI 表示を `Knowledge Linkage` から `Source Evidence` に変更する。
4. `linkedKnowledge` / `unlinkedKnowledge` は legacy alias として残す。

完了条件:

- 既存 API consumer が壊れない。
- Overview UI で source evidence と明示される。

### Phase 2: Origin link model と backfill

実施:

1. `knowledge_origin_links` migration と schema を追加する。
2. `src/cli/backfill-knowledge-origin-links.ts` を追加する。
3. `package.json` に script を追加する。
4. dry-run で `plannedLinkCount` を確認する。
5. `--apply` で既存 origin を補完する。

完了条件:

- dry-run / apply が idempotent。
- `vibe_memory` / `agent_candidate` / `landscape_review_item` が別 family として保存される。
- `local_path` が origin link に混ざらない。

### Phase 3: Provenance Traceability KPI

実施:

1. Overview repository で source evidence と origin の union を集計する。
2. `originLinksByKind` を返す。
3. UI に `Provenance Traceable` と `Origin Links` を追加する。
4. `Unresolved Source Evidence` を source evidence 側の未解決として表示する。

完了条件:

- `Source Evidence` と `Provenance Traceable` の値が別々に見える。
- source evidence が低くても origin traceable が高い状態を説明できる。

### Phase 4: Graph / Landscape health の整理

実施:

1. Graph connectedness の総合 KPI は追加しない。
2. 既存 `sourceCoveredCommunities` / `sourceThinCommunities` / `sourceMissingCommunities` のラベルを整理する。
3. 必要なら `orphanKnowledgeCount` を Overview に追加する。
4. Landscape domain の attractor / dead zone 指標と重複しないように配置を見直す。

完了条件:

- Overview が「次に何を見るべきか」を示す。
- 100% になりやすい vanity KPI を増やしていない。

### Phase 5: Graph origin edge（任意）

実施条件:

- Overview だけでは origin を辿る導線が足りない場合。
- Graph evidence view で source と origin を視覚的に区別する必要がある場合。

実施:

1. Graph repository で `knowledge_origin_links` を読み込む。
2. origin node / `linked_origin` edge を返す。
3. Graph UI で source node と origin node の styling を分ける。

完了条件:

- `linked_source` と `linked_origin` が混同されない。
- Evidence view の監査用途を壊さない。

## 11. 検証計画

### 11.1 CLI

```bash
bun run backfill:knowledge-source-links --dry-run --limit 5000 --include-linked --json
bun run backfill:knowledge-origin-links --dry-run --limit 5000 --json
bun run backfill:knowledge-origin-links --apply --limit 5000 --json
bun run backfill:knowledge-origin-links --dry-run --limit 5000 --include-linked --json
```

期待:

- source link backfill は `plannedLinkCount=0` または既知の未解決のみ。
- origin link apply 後、再 dry-run で重複 insert 予定が出ない。
- `originKindCounts` が `vibe_memory` / `agent_candidate` / `landscape_review_item` に分かれる。

### 11.2 API / schema tests

対象:

```bash
bunx vitest run test/schemas.test.ts
bunx vitest run test/api.routes.knowledge.test.ts test/api.routes.system.test.ts test/api.routes.test.ts
```

確認:

- Overview schema が新 KPI を parse できる。
- legacy `linkedKnowledge` / `unlinkedKnowledge` が残る。
- domain endpoint `/api/overview/domains/knowledge-assets` が contract-compatible。

### 11.3 UI tests

対象:

```bash
bunx vitest run test/components/admin/overview-page.test.tsx
```

確認:

- `Knowledge Linkage` の旧文言が消え、`Source Evidence` / `Provenance Traceable` が表示される。
- 0 件時の文言が source evidence に限定されている。
- origin breakdown が表示される。

### 11.4 Full verify

```bash
bun run verify
```

ただし Phase 2 で migration を追加する場合は、integration DB で次も確認する。

```bash
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/memory_router_test} bun run db:migrate
```

## 12. リスクとガードレール

| リスク | 対応 |
|---|---|
| `knowledge_source_links` に origin を混ぜて source evidence の意味が壊れる | `knowledge_origin_links` を別テーブルにする |
| `Origin Traceability` が source evidence と誤読される | UI 文言で `source evidence` と `origin` を分ける |
| `Graph Connectedness` が 100% 近くになり vanity KPI 化する | 総合率ではなく orphan / thin / weak の health 指標にする |
| legacy API consumer が壊れる | Phase 1 では `linkedKnowledge` / `unlinkedKnowledge` を残す |
| local path 未解決を origin として誤処理する | `local_path` は source evidence backlog として扱う |
| backfill が重複を作る | unique constraint と dry-run/apply の idempotency を必須にする |

## 13. 非目標

- `knowledge_source_links` の意味を広げる。
- `vibe_memory` や `agent://candidate` を source fragment とみなす。
- Graph community membership を root evidence として扱う。
- Graph connectedness を ranking boost に直結する。
- web URL ingest を Phase 1 に含める。
- Overview を大型 dashboard に作り替える。

## 14. 完了条件

この計画の完了条件:

1. Overview から `Knowledge Linkage` という曖昧な単一名称が消える。
2. `Source Evidence` は既存 `knowledge_source_links` の厳密な意味で残る。
3. `Origin Traceability` が別指標として表示される。
4. 既存 knowledge に対する origin link backfill が idempotent に実行できる。
5. source evidence / origin / graph health が Overview で混同されない。
6. schema / API / UI tests と `bun run verify` が通る。
