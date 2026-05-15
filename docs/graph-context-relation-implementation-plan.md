# Graph Context Relation 実装計画（project/session 軸）

## 1. 目的

- Graph に semantic edge だけでなく、以下の **文脈 relation 軸**を追加する。
  - `same_session`
  - `same_project`
- その上で、Graph 描画を **2種類のみ** にする。
  - `Relation`（Project/Session）
  - `Semantic`
- 非 embedding knowledge も relation 軸で可視化できる状態を作る。

## 2. 現状整理（2026-05-15）

- Graph relation は `api/modules/graph/graph.repository.ts` で動的に合成している。
- 旧 `relations` テーブルは Graph から参照されておらず、永続化方針も採用しないため削除対象。
- semantic edge は `knowledge_items.embedding` の cosine 類似度で生成済み。
- knowledge metadata は `sourceSessionId` を持つものが多いが、`repoKey/repoPath` は欠損が残る。
- `vibe_memories.metadata` には `projectRoot/projectName` がほぼ入っているため、project 軸補完に使える。

## 3. 方針（推奨）

### 3.1 「動的 relation 生成」（DB永続化なし）を採用する

- `same_session` / `same_project` は `GET /api/graph` 内で合成する。
- 永続 relation テーブルは持たない。
- 理由:
  - migration と運用コストを増やさずに UX 検証できる。
  - relation 生成ルールを後から調整しやすい。

### 3.2 明示的な根拠リンクは `knowledge_source_links` に集約する

- source provenance は `knowledge_source_links` と pack の `sourceRefs` を使う。
- session/project relation は表示用の派生 edge として扱い、レビュー対象の永続データにはしない。

## 4. 実装スコープ

## 4.1 API（Graph）

対象:
- `api/modules/graph/graph.routes.ts`
- `api/modules/graph/graph.repository.ts`

変更:
1. Query パラメータ拡張
   - `view`: `relation|semantic`（既定 `relation`）
   - `relationAxes`: `session|project` の配列（CSV可, `view=relation` 時のみ有効）
   - 既定: `["session", "project"]`
   - Semantic の既定閾値は **現状維持**（`minSimilarity=0.72`, `semanticTopK=3`）
2. Edge 型拡張（レスポンス）
   - `relationAxis: "semantic" | "session" | "project"`
   - `derived: boolean`（合成 edge かどうか）
3. `same_session` edge 合成
   - キー: `knowledge.metadata.sourceSessionId`
   - 同一キー内で sparse 接続（全結合禁止）
4. `same_project` edge 合成
   - キー優先順位:
     1. `knowledge.appliesTo.repoKey`
     2. `knowledge.metadata.repoKey`
     3. （欠損時）`knowledge.metadata.sourceSessionId` -> `vibe_memories.session_id` 経由で `projectRoot` 取得して正規化
5. エッジ爆発抑制
   - bucket 内の接続戦略は `hub + chain`（`O(n)`）
   - `maxContextEdgesPerNode` を導入（例: 3）
   - edge の重み:
     - `same_session`: 0.85
     - `same_project`: 0.7
6. stats 拡張
   - `sessionEdgeCount`
   - `projectEdgeCount`
   - `semanticEdgeCount`（既存値を継続利用）

## 4.2 UI（Graph 画面）

対象:
- `web/src/modules/admin/repositories/admin.repository.ts`
- `web/src/modules/admin/components/graph.page.tsx`
- `web/src/styles.css`

変更:
1. フィルタ UI
   - View 切替: `Relation / Semantic` の2択のみ
   - Relation 軸: `session / project` を複数選択
2. 表示色の区別
   - project edge: **青線**
   - session edge: **緑線**
   - semantic edge: **オレンジ線**
3. レイアウト切替
   - 既存 force レイアウトに対して、対象 edge 集合を切り替える。
   - `semantic` 表示時は semantic edge のみで座標計算
   - `relation` 表示時は session/project edge のみで座標計算
4. stats 表示
   - View に応じた edge count を表示

## 4.3 データ補完（project 軸精度の底上げ）

対象:
- 新規 CLI: `src/cli/backfill-knowledge-project-context.ts`（追加）
- `package.json` script 追加: `backfill:knowledge-project-context`

内容:
1. `knowledge_items` の `repoKey/repoPath` 欠損行を抽出
2. `sourceSessionId` から `vibe_memories` を逆引きし `projectRoot` を推定
3. `applies_to.repoPath/repoKey` と `metadata.repoPath/repoKey` を backfill

注意:
- 既存値は上書きしない（欠損補完のみ）
- dry-run オプションを実装する

## 4.4 Distillation metadata の精度改善（同時実施推奨）

対象:
- `src/modules/vibe-memory/distillation.service.ts`

現状課題:
- `repoPath/repoKey` を `process.cwd()` ベースで付与しており、multi-project ingest 時にズレる余地がある。

改善:
- memory 単位で `memory.metadata.projectRoot` を優先して `repoPath/repoKey` を決定。
- `process.cwd()` は fallback のみ。

## 5. 具体的な実装順

1. Graph API の relationAxes 拡張（動的 relation 生成）
2. Graph UI の2ビュー切替 UI と色分け
3. Graph stats 拡張
4. Distillation metadata の repo 解決精度改善
5. backfill CLI で既存 knowledge 補完
6. 最終確認（typecheck/lint/test + 画面確認）

## 6. テスト計画

### 6.1 API/Repository テスト

- 新規/拡張候補:
  - `test/graph.repository.integration.test.ts`（追加）
  - 既存 integration suite へ追加でも可

確認項目:
1. `same_session` edge が生成される
2. `same_project` edge が生成される
3. `relationAxes` フィルタで期待軸のみ返る
4. edge 数が `maxContextEdgesPerNode` 制約内に収まる
5. semantic edge（`minSimilarity=0.72`, `semanticTopK=3`）が現状値維持で動く

### 6.2 UI テスト

- `web/src/smoke.test.ts` 拡張
- Graph 画面でフィルタ変更時に API query が変わることを確認

### 6.3 品質ゲート

- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run test:unit`
- `DATABASE_URL=... bun run test:integration`
- `bun run build:web`

## 7. 受け入れ基準

1. Graph の View は `Relation / Semantic` の2種類のみである
2. Relation View で `session / project` 軸を切替できる
3. 非 embedding ノードでも relation モードで位置が安定して可視化される
4. 線色が仕様どおりである（Project=青、Session=緑、Semantic=オレンジ）
5. Semantic View の閾値挙動（`minSimilarity=0.72`, `semanticTopK=3`）を維持する

## 8. リスクと対策

1. **同一セッションの密結合で画面が煩雑**
   - 対策: `hub + chain` + per-node cap
2. **project キー欠損で relation が弱い**
   - 対策: backfill CLI + distillation metadata 改善
3. **表示切替でレイアウトが大きく揺れる**
   - 対策: モード切替時のみオートフィット、以降は手動位置維持

## 9. 将来拡張

- relation 生成ルールの調整 UI
- source provenance 表示の強化
- `knowledge_source_links` を使った根拠別フィルタ
