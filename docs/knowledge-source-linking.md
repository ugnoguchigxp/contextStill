# Knowledge Source Linking / Evidence Graph 実装計画

## 1. 目的

Overview の `Knowledge Graph Status` で見えている `Linked / Unlinked` の状態を、Graph 画面上でも直接追跡できるようにする。

具体的には、既存の knowledge-to-knowledge の relation 表示に加えて、`knowledge_source_links` に基づく **knowledge -> source の直接リンク** を可視化する `evidence` view を追加する。

この計画は実装着手用の仕様であり、運用手順（import/finalize/check）も実装後の検証に使える形で含める。

## 2. スコープ

### 2.1 今回やること

1. `GET /api/graph` に `view=evidence` を追加する。
2. Graph snapshot に source ノード（`sources` テーブル由来）を含める。
3. Graph UI に `Evidence` view を追加し、knowledge-source の直接リンクを描画する。
4. 既存 `relation / semantic / community` view を壊さない。
5. 実装後の確認 SQL と運用チェック観点を明示する。

### 2.2 今回やらないこと（非目標）

1. DB migration（既存テーブルのみ利用）
2. `knowledge_source_links` の自動修復ロジック追加
3. LLM による source label 自動生成
4. `context_compile` ranking への反映
5. Graph 以外の新画面追加

### 2.3 実装時の重要制約

1. `relation / semantic / community` のレスポンス形状は後方互換を維持する。
2. `visibleKnowledgeCount` は evidence view でも knowledge ノード数だけを表す。source ノードは `sourceNodeCount` で別管理する。
3. source ノードの切り詰めは表示上の制約であり、`Linked / Unlinked` の集計には影響させない。

## 3. 現状整理

### 3.1 現在の実装境界

1. Graph API
   - `api/modules/graph/graph.routes.ts`
   - `api/modules/graph/graph.repository.ts`
2. Graph UI
   - `web/src/modules/admin/components/graph.page.tsx`
   - `web/src/modules/admin/repositories/admin.repository.ts`
3. Overview 集計
   - `api/modules/overview/overview.repository.ts`
4. リンク元データ
   - `knowledge_source_links`
   - `source_fragments`
   - `sources`

### 3.2 現在の制約

1. Graph のノード型は `kind: "knowledge"` 前提で source ノードを持てない。
2. Graph の edge 種別は `semantic | session | project | source` のみで、evidence edge がない。
3. `source` 軸は「同じ source を共有する knowledge 同士」の派生 edge であり、source 自体は描画されない。

## 4. 課題定義

1. Overview で `Unlinked` が多くても、Graph では「どの knowledge がどの source と未接続か」を直接見られない。
2. 調査時に Overview / Graph / SQL の読み合わせが必要で、現場の切り分けコストが高い。
3. `source` 軸の relation edge だけでは、実際のエビデンス経路（knowledge -> source）を説明しにくい。

## 5. 目標状態

1. Graph の view selector で `Evidence` を選べる。
2. Graph 上で `knowledge` ノードと `source` ノードが同時に表示される。
3. `knowledge_source_links` 由来の edge が表示される。
4. source ノード選択時に URI / kind / linked knowledge 数が確認できる。
5. `Linked/Unlinked` 調査が Graph 単体で開始できる。

## 6. API/型変更仕様

### 6.1 GraphViewMode

`GraphViewMode` に `evidence` を追加する。

```ts
type GraphViewMode = "relation" | "semantic" | "community" | "evidence";
```

対象:

- `api/modules/graph/graph.routes.ts`
- `api/modules/graph/graph.repository.ts`
- `web/src/modules/admin/repositories/admin.repository.ts`

`GET /api/graph` の query schema には `sourceNodeLimit` を追加する。

```ts
sourceNodeLimit: z.coerce.number().int().min(1).max(2000).default(800)
```

`GraphSnapshotParams` と `fetchGraphSnapshot(...)` の入力にも同じ optional field を追加する。

```ts
type GraphSnapshotParams = {
  limit: number;
  status?: GraphStatusFilter;
  view?: GraphViewMode;
  sourceNodeLimit?: number;
  ...
};
```

`sourceNodeLimit` は evidence view でだけ使う。既存 view では受け取っても無視する。

### 6.2 GraphNode（識別可能な union）

既存の knowledge ノードに加えて source ノードを表現できるようにする。

```ts
type GraphKnowledgeNode = {
  id: string; // knowledge:<uuid>
  kind: "knowledge";
  label: string;
  group: string;
  weight: number;
  status: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
  communityKey?: string;
  communityLabel?: string;
};

type GraphSourceNode = {
  id: string; // source:<sources.id>
  kind: "source";
  label: string; // sources.title ?? sources.uri
  group: "source";
  weight: number;
  status: "active";
  embedded: true;
  sourceId: string;
  sourceKind: string;
  sourceUri: string;
  sourceTitle: string | null;
  linkedKnowledgeCount: number;
};

type GraphNode = GraphKnowledgeNode | GraphSourceNode;
```

方針:

1. 既存 UI の `group/status/weight` 互換を維持する。
2. source ノードは `source:<uuid>` で knowledge ID と衝突しないようにする。
3. source ノードの `embedded` は描画互換用の値であり、`embeddedKnowledgeCount` には含めない。

### 6.3 GraphEdge

`edgeKind` と `relationAxis` に `evidence` を追加する。

```ts
type GraphEdgeKind = "semantic" | "session" | "project" | "source" | "evidence";
```

`GraphEdge.relationAxis` には `evidence` を追加する。一方で、UI toggle 用の `GraphRelationAxis` は `session | project | source` のまま維持する。

evidence edge の仕様:

1. `source` は `knowledge:<uuid>`
2. `target` は `source:<uuid>`
3. `relationType` は `linked_source`
4. `weight` は `knowledge-source` 間の link 数を正規化（`Math.min(1, 0.35 + Math.log2(count + 1) * 0.2)`）

### 6.4 GraphSnapshot.stats の追加項目

既存項目は維持し、evidence 表示向けの項目を追加する。

```ts
{
  sourceNodeCount: number;
  evidenceEdgeCount: number;
  evidenceLinkedKnowledgeCount: number;
  evidenceUnlinkedKnowledgeCount: number;
  truncatedSourceNodeCount: number;
}
```

既存 test 互換のため、既存フィールドは削除しない。

定義:

1. `sourceNodeCount`: 実際に snapshot に含めた source ノード数
2. `evidenceEdgeCount`: 実際に snapshot に含めた evidence edge 数
3. `evidenceLinkedKnowledgeCount`: 表示対象 knowledge のうち、少なくとも1件の `knowledge_source_links` を持つ件数
4. `evidenceUnlinkedKnowledgeCount`: 表示対象 knowledge のうち、`knowledge_source_links` を持たない件数
5. `truncatedSourceNodeCount`: `sourceNodeLimit` により返却しなかった source ノード数

## 7. バックエンド実装詳細

### 7.1 `buildGraphSnapshot` の分岐

`view === "evidence"` の場合:

1. knowledge ノードは既存ロジック（status filter + limit）で取得
2. `knowledge_source_links -> source_fragments -> sources` を join してリンクを取得
3. source ノードを生成
4. evidence edge を生成
5. source 上限（`sourceNodeLimit`, 初期 800）を超える場合は `linkedKnowledgeCount desc, sourceId asc` で切り詰め
6. 切り詰めた source に接続する edge だけ残す

集約 query の形:

```sql
select
  ksl.knowledge_id,
  s.id as source_id,
  s.source_kind,
  s.uri,
  s.title,
  count(*)::int as link_count
from knowledge_source_links ksl
join source_fragments sf on sf.id = ksl.source_fragment_id
join sources s on s.id = sf.source_id
where ksl.knowledge_id in (...)
group by ksl.knowledge_id, s.id, s.source_kind, s.uri, s.title;
```

補足:

1. `relationAxes` は evidence view では無視（受け取っても動作は不変）。
2. `community` 系メタデータは evidence view では空でよい。
3. `sources` を `src/db/schema.ts` から import する必要がある。
4. unlinked knowledge も孤立 knowledge ノードとして返す。

### 7.2 ID/ラベル規約

1. knowledge node id: `knowledge:${knowledgeId}`
2. source node id: `source:${sourceId}`
3. source label: `title` 優先、空なら `uri`

### 7.3 既存 view への影響防止

1. `relation`, `semantic`, `community` の既存分岐はそのまま維持
2. 既存 stats の計算式は変更しない
3. evidence view でのみ source ノードを返す
4. evidence view でも `visibleKnowledgeCount` は source を含めない

## 8. フロントエンド実装詳細

### 8.1 View selector

`GraphPage` の view selector に `Evidence` を追加する。

```tsx
<option value="evidence">Evidence</option>
```

### 8.2 描画ルール

1. knowledge ノード: 既存の円形
2. source ノード: 矩形（または角丸矩形）で識別
3. evidence edge: 専用スタイル（例: 明るいシアン）
4. source ノードの色は knowledge type と混ざらない固定色にする
5. `nodeColorForView` と SVG node renderer は `node.kind` で分岐する

### 8.3 Detail panel

1. knowledge 選択時: 既存 detail を維持
2. source 選択時: API detail fetch は呼ばず、snapshot node 情報を表示
   - `sourceUri`
   - `sourceKind`
   - `linkedKnowledgeCount`

実装上の注意:

1. `selectedRawId` は `knowledge:` の場合だけ作る。
2. `source:` 選択時は `fetchGraphNodeDetail` を呼ばない。
3. `DisplayNode` 型に `kind`, `sourceUri`, `sourceKind`, `linkedKnowledgeCount` を保持する。

### 8.4 Legend / Stats

1. Legend に `Evidence Link` を追加
2. Stats に evidence 専用行を表示
   - `Source Nodes`
   - `Evidence Edges`
   - `Unlinked Knowledge`
3. evidence view の `Nodes` 表示は `visibleKnowledgeCount + sourceNodeCount` を使う
4. `truncatedSourceNodeCount > 0` の場合は stats 内に `Truncated Sources` を表示する

## 9. テスト計画

### 9.1 Backend

対象:

- `test/repositories.integration.test.ts`
- `test/api.routes.test.ts`

追加観点:

1. `view=evidence` が source ノードを返す
2. evidence edge が `knowledge -> source` を満たす
3. `sourceNodeLimit` 超過時に `truncatedSourceNodeCount > 0`
4. `relation/semantic/community` の既存期待値が変わらない
5. unlinked knowledge が evidence view で孤立ノードとして残る
6. `evidenceLinkedKnowledgeCount / evidenceUnlinkedKnowledgeCount` が source truncation の影響を受けない

### 9.2 Frontend

対象:

- `test/admin/repositories.test.ts`
- `test/components/admin/graph-page.test.tsx`

追加観点:

1. `fetchGraphSnapshot({ view: "evidence" })` で query が正しく組み立つ
2. `Evidence` 選択で `view=evidence` が呼ばれる
3. source ノード選択時に source detail が表示される
4. 既存 view の描画テストが回帰しない
5. source ノード選択時に `fetchGraphNodeDetail` が呼ばれない
6. evidence view の stats が source/evidence/unlinked を表示する

## 10. 実装順序（チェックリスト）

### Phase 1: API/型

1. `GraphViewMode` / `GraphNode` / `GraphEdge` / `stats` 型拡張
2. route schema に `evidence` と `sourceNodeLimit` を追加
3. admin repository の `fetchGraphSnapshot` 入力に `sourceNodeLimit` を追加
4. `buildGraphSnapshot(view=evidence)` 実装
5. backend unit/integration test 追加

### Phase 2: UI

1. repository 型反映
2. Graph view selector に `Evidence` 追加
3. source ノード描画と detail panel 実装
4. legend/stats 表示追加
5. frontend test 追加
6. CSS に `.graph-edge.evidence` と source node 表示スタイルを追加

### Phase 3: 検証・文書

1. `bun run typecheck`
2. `bun run test:unit`（少なくとも Graph 関連 test）
3. `bun run build:web`
4. 本ドキュメントの「運用確認 SQL」で実データ確認

## 11. ロールアウト / ロールバック

### 11.1 ロールアウト

1. まず backend + test を先行マージ
2. 次に UI を追加
3. 最後に運用確認（Overview と Graph を同時確認）

### 11.2 ロールバック

1. 不具合時は `view=evidence` を selector から一時的に外す
2. backend は `evidence` 分岐だけ revert すれば既存 view に影響しない設計にする

## 12. 完了条件（DoD）

1. `view=evidence` で knowledge-source 直接リンクが表示される
2. source ノード選択で URI/kind/link数が見える
3. `Linked/Unlinked` 調査を Graph だけで開始できる
4. Graph 既存 view の test が全て通る
5. Overview の数値と SQL 集計の整合を確認できる
6. source truncation が発生しても `Linked/Unlinked` stats は正しい

## 13. 運用確認 SQL（実装後）

```sql
-- knowledge 全体と linked 数
with linked as (
  select distinct knowledge_id
  from knowledge_source_links
)
select
  (select count(*) from knowledge_items) as knowledge_total,
  (select count(*) from linked) as linked_knowledge,
  (select count(*) from knowledge_source_links) as source_links;
```

```sql
-- source ごとのリンク状況
select
  sf.source_id,
  count(*)::int as link_count
from knowledge_source_links ksl
join source_fragments sf on sf.id = ksl.source_fragment_id
group by sf.source_id
order by link_count desc
limit 20;
```

```sql
-- unlinked knowledge の実数
select count(*)::int as unlinked_knowledge
from knowledge_items ki
where not exists (
  select 1
  from knowledge_source_links ksl
  where ksl.knowledge_id = ki.id
);
```
