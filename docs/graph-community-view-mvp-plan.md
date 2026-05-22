# Graph Community View MVP 実装計画

## 1. 目的

Knowledge Graph に、knowledge community を read-time の派生 view として追加する。

初期目的は、1000-2000 件規模の knowledge corpus を個別ノードの集合として眺めるのではなく、どの領域に knowledge が集まっているか、どこが孤立しているかを Graph 上で確認できるようにすることである。

この計画は、`docs/knowledge-landscape-concept-design.md` のうち `Graph Community View` に限定した実装計画である。Knowledge Landscape 全体、attractor、trajectory playback、`context_compile` ranking 変更は含めない。

## 2. 現状整理

現在の Graph 実装は次の構造で動いている。

- API
  - `GET /api/graph`
  - `GET /api/graph/nodes/:id`
- backend
  - `api/modules/graph/graph.routes.ts`
  - `api/modules/graph/graph.repository.ts`
- frontend
  - `web/src/modules/admin/components/graph.page.tsx`
  - `web/src/modules/admin/repositories/admin.repository.ts`
- test
  - `test/repositories.integration.test.ts`
  - `test/admin/repositories.test.ts`
  - `test/components/admin/graph-page.test.tsx`

`GET /api/graph` はすでに `view=relation | semantic` を持つ。

relation view は `session`, `project`, `source` 軸から derived edge を作る。これらの edge は DB に永続化されず、Graph snapshot 生成時に合成される。

semantic view は pgvector の cosine similarity から `semantic_near` edge を作る。こちらも read-time の derived edge である。

このため community view も、まずは既存の snapshot 生成に乗せた read-time derived view として実装できる。

## 3. 方針

### 3.1 初期実装は read-time derived community に限定する

Community assignment は `knowledge_items` に保存しない。

理由:

- community 計算の妥当性を UI で確認する前に canonical data を汚したくない
- 既存 Graph edge がすでに read-time derived であり、同じ責務境界に置ける
- DB migration なしで実装できる
- 失敗しても `context_compile` や knowledge ranking に影響しない

### 3.2 最初は connected components を使う

初期アルゴリズムは Louvain / Leiden / HDBSCAN / UMAP ではなく、edge graph の connected components とする。

理由:

- パラメータが少ない
- LLM / 人間が結果を説明しやすい
- 既存の relation edge と相性がよい
- 1000-2000 件規模なら十分軽い
- 後で Louvain / Leiden へ置き換える場合も、API 型を大きく変えずに済む

### 3.3 最初の community edge は relation edge を主軸にする

`view=community` では、まず relation edge を使って community を作る。

初期 relation axes:

- `session`
- `project`
- `source`

semantic edge は初期 community には混ぜない。

理由:

- source / project / session は provenance に近く、人間が納得しやすい
- semantic edge を混ぜると、似ているだけの knowledge が大きく連結しすぎる可能性がある
- semantic 由来の community は後続ステップで比較対象として追加できる

## 4. 非目標

今回やらないこと:

- DB migration
- `knowledge_items` への `community_id` 保存
- Louvain / Leiden community detection
- UMAP / HDBSCAN
- community label の LLM 自動生成
- community supernode 表示
- `context_compile` ranking への反映
- candidate promotion / suppression への反映
- dead zone penalty
- attractor score
- compile trajectory playback

## 5. API 変更

### 5.1 `GraphViewMode`

`GraphViewMode` に `community` を追加する。

```ts
type GraphViewMode = "relation" | "semantic" | "community";
```

対象:

- `api/modules/graph/graph.repository.ts`
- `api/modules/graph/graph.routes.ts`
- `web/src/modules/admin/repositories/admin.repository.ts`

### 5.2 `GraphNode`

`GraphNode` に community 情報を追加する。

```ts
type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge";
  group: string;
  weight: number;
  status: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
};
```

`group` は引き続き `rule` / `procedure` などの knowledge type を表す。community は別軸である。

### 5.3 `GraphNodeDetail`

Node detail にも community 情報を載せる。

```ts
type GraphNodeDetail = {
  ...
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
};
```

注意: 現在の node detail は `GET /api/graph/nodes/:id` で個別取得している。この endpoint 単体では snapshot 内の community assignment を再現しにくい。初期実装では、detail panel の community 表示は `selectedNode` 側の Graph snapshot data を優先し、detail API 型の拡張は後続でもよい。

### 5.4 `GraphSnapshot.stats`

`stats` に community summary を追加する。

```ts
type GraphSnapshotStats = {
  visibleKnowledgeCount: number;
  totalKnowledgeCount: number;
  embeddedKnowledgeCount: number;
  semanticEdgeCount: number;
  sessionEdgeCount: number;
  projectEdgeCount: number;
  sourceEdgeCount: number;
  relationEdgeCount: number;
  sourceRefCount: number;
  communityCount: number;
  largestCommunitySize: number;
  orphanNodeCount: number;
};
```

`orphanNodeCount` は `communitySize = 1` の node 数とする。

## 6. Community 計算

### 6.1 入力

入力は `nodes` と `edges`。

`view=community` では次の edge を使う。

1. `buildRelationEdges(...)` で作った relation edge
2. `edge.weight >= communityMinEdgeWeight` を満たす edge

初期値:

```txt
communityMinEdgeWeight = 0.7
```

現在の relation edge weight は概ね次である。

- session: `0.85`
- source: `0.75`
- project: `0.7`

したがって初期値 `0.7` では、session / source / project をすべて含める。

### 6.2 アルゴリズム

Union-Find または DFS/BFS で connected components を作る。

処理:

```txt
nodes
edges
↓
threshold 未満の edge を除外
↓
edge source/target を union
↓
component ごとに node を集計
↓
size desc, max node weight desc, id asc で rank を振る
↓
node に communityId / communityRank / communitySize を付与
```

`communityId` は永続 ID ではない。初期実装では snapshot 内だけで安定すればよい。

推奨形式:

```txt
community:<rank>
```

例:

```txt
community:1
community:2
community:3
```

rank は大きい community ほど小さい番号にする。

### 6.3 孤立 node

edge を持たない node も community として扱う。

```txt
communitySize = 1
orphanNodeCount += 1
```

孤立 node は削除候補ではない。初期 UI では「到達性・分類・source evidence を確認する対象」として表示する。

## 7. Backend 実装順

### 7.1 `graph.routes.ts`

- `view` schema に `community` を追加する
- `relationAxes` は `view=community` でも受け取る
- 初期は `communityMinEdgeWeight` query parameter は出さない

将来的に必要になったら、次を追加できる。

```txt
communityMinEdgeWeight=0.7
```

ただし MVP では固定値でよい。

### 7.2 `graph.repository.ts`

追加する helper:

- `buildCommunityAssignments(nodes, edges)`
- `withCommunityMetadata(nodes, assignments)`
- `buildCommunityStats(assignments)`

`buildGraphSnapshot(...)` の分岐:

```txt
view=relation
  -> existing relation edges

view=semantic
  -> existing semantic edges

view=community
  -> relation edges
  -> connected components
  -> nodes with community metadata
  -> edges are relation edges
```

Community view では edge 表示を残す。node coloring が community、edge coloring が relation kind という見方にする。

## 8. Frontend 実装順

### 8.1 repository type

`web/src/modules/admin/repositories/admin.repository.ts` の型を更新する。

- `GraphViewMode`
- `GraphNode`
- `GraphSnapshot.stats`

### 8.2 Graph view selector

`web/src/modules/admin/components/graph.page.tsx` の view selector に `Community` を追加する。

```tsx
<option value="community">Community</option>
```

`relationAxes` は `relation` と `community` で表示する。

```txt
viewMode === "relation" || viewMode === "community"
```

### 8.3 query

`fetchGraphSnapshot(...)` 呼び出しでは、`community` でも `relationAxes` を渡す。

```ts
relationAxes:
  viewMode === "relation" || viewMode === "community"
    ? relationAxes
    : undefined
```

### 8.4 node color

`viewMode === "community"` の場合、node color は `communityRank` から決める。

既存の `group` 色は relation / semantic view で維持する。

初期 palette は CSS class または deterministic HSL のどちらでもよい。

推奨:

- rank 1-10 は CSS palette
- 11 以降は fallback 色
- orphan は muted / dashed border / lower opacity のいずれか

### 8.5 stats

Community view では stats に次を表示する。

- Communities
- Largest
- Orphans

既存の Nodes / Edges / Embedded は残す。

### 8.6 detail panel

選択 node の detail panel に次を追加する。

- Community
- Size
- Rank

初期実装では `selectedNode.community*` から表示する。

## 9. テスト計画

### 9.1 API route test

対象:

- `test/admin/repositories.test.ts`

確認:

- `fetchGraphSnapshot({ view: "community" })` が `/api/graph?...view=community...` を呼ぶ
- `relationAxes` が community view でも query に含まれる

### 9.2 repository integration test

対象:

- `test/repositories.integration.test.ts`

追加ケース:

1. 同じ `source` を持つ knowledge が同一 community になる
2. 別 source の knowledge は別 community になる
3. edge がない knowledge は `communitySize = 1` になり、`orphanNodeCount` に入る
4. `communityCount` と `largestCommunitySize` が期待どおりになる

既存の graph relation test data を使い回せる可能性がある。

### 9.3 frontend component test

対象:

- `test/components/admin/graph-page.test.tsx`

確認:

- view selector に `Community` が表示される
- Community を選ぶと `fetchGraphSnapshot({ view: "community", ... })` が呼ばれる
- stats に `Communities`, `Largest`, `Orphans` が表示される
- selected node detail に community 情報が表示される

## 10. 完了条件

完了条件:

- Graph 画面で `Community` view を選べる
- `view=community` で community metadata 付き node が返る
- community は connected components で計算される
- `communityCount`, `largestCommunitySize`, `orphanNodeCount` が返る
- node が community 単位で色分けされる
- relation / semantic view の既存挙動が壊れない
- DB migration がない
- `context_compile` の retrieval / ranking に影響しない
- 対象テストが通る

推奨確認コマンド:

```bash
bunx vitest run test/admin/repositories.test.ts test/components/admin/graph-page.test.tsx test/repositories.integration.test.ts
```

必要に応じて:

```bash
bun run verify
```

## 11. レビュー観点

2026-05-23 の実装前レビューで、次の方針を採用する。

| 観点 | 決定 |
| --- | --- |
| `view=community` を relation view の派生として扱う | Yes |
| 初期 community edge に semantic edge を混ぜない | Yes |
| `communityMinEdgeWeight` を初期 query parameter にしない | Yes |
| `communityId` は snapshot-local ID とする | Yes |
| orphan は `communitySize = 1` として扱う | Yes |
| Graph UI は node coloring から始め、supernode は後続に回す | Yes |
| detail API ではなく snapshot node 側の community metadata を表示元にする | Yes |

このレビュー結果により、MVP の実装方針は確定とする。後続実装では、この表の決定を前提にする。

## 12. 後続候補

MVP で community の見え方が有用だった場合、次の順で拡張する。

1. semantic edge を混ぜた community と relation-only community の比較
2. community summary panel
3. representative knowledge 抽出
4. community label の人間編集
5. dead zone / stale zone / thin evidence zone の表示
6. community supernode view
7. `context_compile` run との overlay
8. replay corpus を使った ranking 影響評価
9. `context_compile` の diversity / exploration 反映

この順序を守る。MVP で直接 ranking に入れない。
