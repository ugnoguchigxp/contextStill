# 知識価値ライフサイクル設計書

> **ステータス**: Draft  
> **作成日**: 2026-05-15  
> **対象バージョン**: v0.2（予定）

---

## 1. 概要

現在の `knowledge_items` は静的なスコア（`confidence` / `importance`）を持つが、知識の「価値」は時間と使われ方によって動的に変化する。本計画では以下の 2 つの軸でスコアを動的化する。

| 軸 | 方向性 | 主なシグナル |
|---|---|---|
| **参照による価値増幅** | 使われるほど価値が上がる | `context_compile` での選択回数、エージェントの明示的フィードバック |
| **時間経過による陳腐化** | 使われないほど価値が下がる | `lastVerifiedAt`・`updatedAt` からの経過日数、技術スタックのバージョン変化 |

目標は「**エージェントが実際に有用と判断した知識が自動的に浮き上がり、陳腐化した知識が自動的に沈む**」ナレッジエコシステムの実現。

---

## 2. 参照による価値付与（Reference Amplification）

### 2.1 コンセプト

```
compile_run で item が選択される
        ↓
context_pack_items に記録される
        ↓
使用回数・最終使用日を集計
        ↓
dynamic_score に加算
```

### 2.2 計測シグナル

| シグナル | 説明 | 重み（案） |
|---|---|---|
| `compile_select_count` | `context_pack_items` に登場した回数 | +0.02/回（最大 +0.4） |
| `recent_select_count_30d` | 直近 30 日の選択回数 | 鮮度係数: ×1.5 |
| `agentic_accepted` | `agenticRefine` で保持された回数 | +0.05/回（最大 +0.2） |
| `explicit_upvote` | ユーザー/エージェントからの明示的フィードバック | +0.15/回 |
| `explicit_downvote` | ネガティブフィードバック | −0.20/回 |

### 2.3 スキーマ拡張案

```sql
-- knowledge_items に追加するカラム
compile_select_count    INTEGER    DEFAULT 0 NOT NULL,
last_compiled_at        TIMESTAMP,
agentic_accept_count    INTEGER    DEFAULT 0 NOT NULL,
dynamic_score           REAL       DEFAULT 0 NOT NULL,
```

### 2.4 集計タイミング

- `insertContextPackItems` 実行後、バックグラウンドで `UPDATE knowledge_items` を発行
- `dynamic_score` は `importance` / `confidence` の基礎スコアに加算した **合成スコア** として `ranking.service.ts` に注入
- 集計は非同期・非ブロッキング（`recordAuditLogSafe` と同様のパターン）

### 2.5 ランキングへの統合

```typescript
// ranking.service.ts の rankAndDedupe への入力に dynamicScore を追加
const compositeScore =
  base.importance * 0.35 +
  base.confidence * 0.25 +
  base.dynamicScore * 0.25 +   // ← NEW
  base.sourceRefCount * 0.15;
```

---

## 3. 時間経過による陳腐化（Temporal Decay）

### 3.1 コンセプト

知識は時間が経つほど陳腐化リスクが高まる。特に：
- ライブラリのバージョンを含む手順（`procedure`）
- 特定のフレームワーク制約に依存するルール

```
lastVerifiedAt（または updatedAt）からの経過日数
        ↓
decay_factor の計算（指数減衰）
        ↓
dynamic_score からの減算
```

### 3.2 減衰モデル

**指数減衰関数：**

```
decay_factor(t) = exp(-λ × t)

t  = 最終検証日からの経過日数
λ  = 知識タイプ別の減衰定数
```

| 知識タイプ | λ（減衰定数） | half-life（半減期） |
|---|---|---|
| `procedure`（手順） | 0.004 | 約 180 日 |
| `rule`（ルール） | 0.001 | 約 700 日 |
| `global` scope | λ × 0.5 | 2 倍長持ち |

> **根拠**: 手順は技術スタックの変化に敏感（6 ヶ月で別物になりやすい）。ルールは原則に近いため減衰が遅い。

### 3.3 実装アプローチ

陳腐化スコアの計算は **ランキング時にリアルタイム計算**（DBに保存しない）を基本とする：

```typescript
function computeDecayFactor(item: {
  type: KnowledgeItem["type"];
  scope: KnowledgeItem["scope"];
  lastVerifiedAt: Date | null;
  updatedAt: Date;
}): number {
  const referenceDate = item.lastVerifiedAt ?? item.updatedAt;
  const daysSince = (Date.now() - referenceDate.getTime()) / (1000 * 60 * 60 * 24);
  const lambda = item.type === "procedure" ? 0.004 : 0.001;
  const scopeFactor = item.scope === "global" ? 0.5 : 1.0;
  return Math.exp(-lambda * scopeFactor * daysSince);
}
```

### 3.4 陳腐化アラート

`doctor` コマンドに陳腐化チェックを追加：

```
⚠️  STALE KNOWLEDGE DETECTED
   15 items have decay_factor < 0.5 (last verified > 6 months ago)
   Recommended: bun run distill:sources --apply --stale-only
```

### 3.5 `lastVerifiedAt` の更新トリガー

| トリガー | アクション |
|---|---|
| エージェントが `register_knowledge` で同内容を再登録 | `lastVerifiedAt = NOW()` にリセット |
| `agentic_accept_count` が増加 | `lastVerifiedAt = NOW()` にリセット |
| 再蒸留で同一 contentHash のアイテムがヒット | `lastVerifiedAt = NOW()` にリセット |
| ユーザーが管理 UI でステータスを変更 | `lastVerifiedAt = NOW()` にリセット |

---

## 4. 名寄せ・重複消込（Deduplication & Canonicalization）

> **Note**: 別ドキュメント `knowledge-deduplication-plan.md` で詳述予定。本書ではライフサイクルとの関係のみ記載。

重複知識は以下の手順でライフサイクル価値を統合する：

1. **名寄せ判定**: bigram 類似度 + ベクトルコサイン類似度でクラスタリング
2. **正規形の選択**: `compile_select_count` が最大のアイテムを canonical として保持
3. **価値の継承**: 非 canonical アイテムの `compile_select_count` / `dynamic_score` を canonical に加算してから `deprecated` 化

---

## 5. 合成スコアの最終形

```
final_score =
  importance  × 0.30  (基礎品質)
  + confidence × 0.20  (信頼度)
  + dynamic    × 0.25  (使用実績)
  + decay      × 0.15  (陳腐化係数: 0.0〜1.0)
  + source_ref × 0.10  (証拠充実度)
```

> **実装上の注意**: `context-compiler.service.ts` の `applySectionTokenBudget` 前のランキングにのみ反映し、DB 側のカラムとは分離を保つこと（計算モデルの変更が容易になる）。

---

## 6. 実装ロードマップ

### Phase 1: 参照カウント基盤（優先度: 高）

- [ ] `knowledge_items` に `compile_select_count`, `last_compiled_at`, `agentic_accept_count`, `dynamic_score` を追加（マイグレーション）
- [ ] `insertContextPackItems` 後に非同期でカウンタをインクリメント
- [ ] `ranking.service.ts` に `dynamicScore` 入力を追加
- [ ] `doctor` に参照ゼロのアイテム一覧を追加

### Phase 2: 陳腐化計算（優先度: 中）

- [ ] `computeDecayFactor` をランキングサービスに組み込み
- [ ] `doctor` に陳腐化アラートを追加
- [ ] 管理 UI の Knowledge ページに decay_factor インジケータ表示
- [ ] `distill:sources --stale-only` フラグの追加

### Phase 3: フィードバックループ（優先度: 中）

- [ ] `explicit_upvote` / `explicit_downvote` エンドポイント（`PUT /api/knowledge/:id/feedback`）
- [ ] エージェントからのフィードバックを MCP ツール経由で受け付け
- [ ] フィードバック履歴を `audit_logs` に記録

### Phase 4: 名寄せ統合（優先度: 低→中）

- [ ] 重複判定バッチ（`bun run dedup:knowledge`）の実装
- [ ] 管理 UI に重複候補テーブルの表示
- [ ] 自動名寄せ（confidence > 0.98 の場合のみ自動実行）

---

## 7. リスクと緩和策

| リスク | 緩和策 |
|---|---|
| 人気があるだけで不正確な知識が高スコアに | `confidence` を別軸で保持し、フィードバックで下げられる設計 |
| 陳腐化係数が強すぎて有用な知識が埋もれる | λ を設定可能にし、デフォルトは保守的な値に設定 |
| 参照カウントのパフォーマンス影響 | 非同期・バッファード更新（10 件ごとにバッチ UPDATE） |
| 名寄せの誤判定 | 自動消込は confidence > 0.98 以上に限定し、それ以下は UI でレビュー |

---

## 8. 参考

- [Context Compile MCP Improvement Plan](./context-compile-mcp-improvement-plan.md)
- [Improvement Plan](./improvement-plan.md)
- `src/modules/context-compiler/ranking.service.ts` — 現在のランキングロジック
- `src/modules/context-compiler/context-compiler.service.ts` — コンパイル本体
- `src/db/schema.ts` — `knowledge_items` スキーマ定義
