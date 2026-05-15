# Knowledge Scoring Unification 実装計画（実装着手版）

## 1. 結論（このまま実装に移れるか）

現行版のままでは **実装に着手しない方が安全**。  
理由は、以下が未確定だったためです。

1. `score`（検索/類似度）まで 0-100 化するかが曖昧  
2. `importance/confidence` を 100 化した時のランキング計算・Graph weight の扱いが未定義  
3. 移行 SQL が再実行に弱い（単純 `* 100` だと二重変換リスク）

この文書は、上記を解消した **実装可能な最終方針** です。

## 2. 適用スコープ（確定）

### 2.1 0-100 に統一する値

- `knowledge_items.importance`
- `knowledge_items.confidence`
- 管理 UI（Knowledge 一覧/編集）での表示・入力
- Distillation で生成する `importance/confidence`

### 2.2 0-1 を維持する値（今回の対象外）

- 検索・類似度の `score`（`ts_rank_cd`, vector similarity）
- Distillation の候補 `score` と score gate 閾値（`MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE`）
- Graph semantic の `minSimilarity`（`0..1`）

`score` は「検索/類似度」であり、`importance/confidence` は「知識品質」。  
意味が違うため、同一スケールに無理に統合しません。

## 3. スコア正規化ルール

実装で一貫して使う変換を共通化します（新規: `src/lib/score-scale.ts` を想定）。

1. `normalizePercent(value)`  
   - 入力が `0 < value < 1` なら旧データ互換として `*100`
   - `1` は新スケールの「1%」として扱う（誤って `100` にしない）
   - 入力が `1..100` ならそのまま
   - 最終的に `0..100` へ clamp
2. `toUnit(value)`  
   - `normalizePercent(value) / 100`
   - ランキング・Graph weight など 0..1 前提計算で使用

これにより、移行途中の混在データでも挙動を壊しにくくします。

## 4. 実装対象ファイル

## 4.1 Schema / DB / API

対象:
- `src/shared/schemas/knowledge.schema.ts`
- `src/db/schema.ts`
- `api/modules/knowledge/knowledge.routes.ts`
- `api/modules/knowledge/knowledge.repository.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/db/seed.ts`

変更:
1. `knowledge.schema.ts` の `importance/confidence` を `0..100` バリデーションへ変更
2. API 書き込みバリデーションを `0..100` に変更（既定値 `70`）
3. Repository のデフォルト値を `0.5/0.7` 系から `50/70` 系に更新
4. seed の値を `0.95/0.9` から `95/90` へ更新

## 4.2 Distillation（knowledge quality 軸のみ 100 化）

対象:
- `src/modules/distillation/distillation-candidates.ts`
- `src/modules/distillation/distillation-prompts.ts`
- `src/modules/vibe-memory/distillation.service.ts`
- `src/modules/sources/distillation.service.ts`

変更:
1. `confidence/importance` の parser を `normalizePercent` 化
2. parser の fallback を `0.65/0.55` から `65/55` に更新
3. JSON shape の例示を `confidence:70, importance:70` 形式に更新
4. `score`（候補保存価値）は **0..1 のまま維持**

## 4.3 Ranking / Compile

対象:
- `src/modules/context-compiler/ranking.service.ts`

変更:
1. `weightedScore` は次を採用  
   `base = item.score + toUnit(item.importance)*0.2 + toUnit(item.confidence)*0.1`
2. 既存の penalty/boost（deprecated, stale, sourceRef）は現状維持

これで、知識品質スケールだけを 100 化しても既存ランキング特性を維持できます。

## 4.4 Graph（視覚崩れ防止）

対象:
- `api/modules/graph/graph.repository.ts`
- `web/src/modules/admin/components/graph.page.tsx`（必要なら表示文言のみ）

変更:
1. ノード weight 計算に `toUnit(importance)` を使用
2. `GraphNode.importance/confidence` の表示値は 0-100 のまま返却
3. レイアウト用の内部 weight と表示値を分離

## 4.5 Admin UI（Knowledge）

対象:
- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/admin/repositories/admin.repository.ts`

変更:
1. 編集フォーム: `Importance (0-100)` / `Confidence (0-100)` 入力へ変更
2. フィルター: `0.3+` 等を `30+` へ変更
3. テーブル:
   - 主表示: `Quality Score`（例: `round(importance*0.6 + confidence*0.4)`）
   - 副表示: `I:xx / C:xx`

## 4.6 関連ドキュメント追随

対象:
- `docs/source-graph-flow.md`
- `docs/distillation-runtime-plan.md`

変更:
1. `confidence/importance` の説明を `0..1` から `0..100` に更新
2. `score`（検索/候補評価）は `0..1` 維持であることを明記

## 5. Migration 方針（再実行耐性あり）

新規 migration を追加（例: `drizzle/0010_knowledge_score_100_scale.sql`）。

```sql
-- 旧 0..1 データのみ変換
UPDATE knowledge_items
SET importance = ROUND(importance * 100)
WHERE importance >= 0 AND importance <= 1;

UPDATE knowledge_items
SET confidence = ROUND(confidence * 100)
WHERE confidence >= 0 AND confidence <= 1;

ALTER TABLE knowledge_items
  ALTER COLUMN importance SET DEFAULT 70;

ALTER TABLE knowledge_items
  ALTER COLUMN confidence SET DEFAULT 70;
```

補足:
- 型は `real` のまま維持（今回の変更範囲外）
- `knowledge_source_links.confidence` は対象外（意味が別）

## 6. テスト更新範囲

対象:
- `test/context-compiler.test.ts`
- `test/vibe-memory-distillation.test.ts`
- `test/source-distillation.integration.test.ts`
- `test/vibe-memory-distillation.integration.test.ts`
- 必要に応じて `test/repositories.integration.test.ts`

更新内容:
1. `confidence/importance` の期待値を 0-100 へ変更
2. legacy 互換（0..1 入力を受けて 0-100 化）テストを追加
3. ranking の順序が旧実装相当で維持されることを確認

## 7. 実装順（推奨）

1. 共通スケール変換ヘルパー追加（`src/lib/score-scale.ts`）
2. Schema/API/Repository の 0-100 対応
3. migration 追加・適用
4. ranking / graph の内部正規化対応
5. Distillation parser/prompt 更新
6. Admin UI 更新
7. テスト更新と品質ゲート実行

## 8. 受け入れ基準

1. Knowledge API は `importance/confidence` を 0-100 で受け取り、DB も 0-100 で保持する
2. Context Compile のランキング順が、同一データに対して旧挙動から大きく崩れない
3. Graph のノードサイズが破綻しない（importance=100 でも UI 崩れなし）
4. Distillation で生成された knowledge の `importance/confidence` が 0-100 で保存される
5. `bun run verify` が通る

## 9. 実行コマンド

1. `bun run db:generate`
2. `bun run db:migrate`
3. `bun run verify`
4. （必要時）`DATABASE_URL=... bun run test:integration`
