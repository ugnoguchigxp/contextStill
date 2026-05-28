# Knowledge Landscape Health 回収計画

更新日: 2026-05-28  
Status: implementation plan

## 1. 目的

Overview の `Knowledge Landscape Health` で発生している次の 2 点を、運用とデータ整備で回収する。

1. `Gate: review required` を `normal` に戻す。
2. `Dead zones`（特に `dead_zone_reachability_risk`）を段階的に圧縮する。

この計画は「ranking ロジック変更」ではなく、「既存ワークフロー（observe/explain/replay + review items）」を使った回収に限定する。

## 2. 現状ベースライン（2026-05-28 18:18 JST）

### 2.1 Overview 指標（windowDays=30）

| 指標 | 値 |
|---|---:|
| Total communities | 357 |
| Strong attractor | 18 |
| Useful attractor | 52 |
| Over-selected | 25 |
| Dead zone reachability | 176 |
| Dead zone stale | 0 |
| Replay runs（UI既定） | 20 |
| Replay overlap | 86.7% |
| Used lost | 6 |
| Churn | 19 |
| Gate | review_required |

### 2.2 Replay compare（UI既定相当: `limit=20`, `currentLimit=12`）

| 指標 | 値 |
|---|---:|
| comparedRunCount | 20 |
| averageOverlapRate | 0.8667 |
| usedBaselineLostItemCount | 6 |
| promotionGateSummary.affectedRunCount | 4 |
| promotionGateSummary.riskyNewKnowledgeCount | 28 |
| promotionGateSummary.gateMode | review_required |

補足: `review_required` は overlap 単体ではなく、`usedBaselineLost` 等の gate 条件で発火している。

## 3. 原因整理

### 3.1 Gate が review required の理由

- promotion gate は replay 比較で `affectedRuns.length > 0` のとき `review_required` になる。
- 現在は 20 run 中 4 run が該当し、`usedBaselineLostItemCount=6`。
- 該当 run の baseline で `used` だった知識が current retrieval で落ちている。

該当 run:

- `097f20be-844d-4d53-99ee-03c42e306354`
- `7df14b5b-d197-4aa5-ab36-32bf56d4aea6`
- `d6b8a30a-01c5-4cef-83c0-5aaf68eac4e8`
- `4960ba21-8af2-4ee4-bf0e-58cdc4f0e6fd`

lost knowledge（6件）:

- `0ddf7a98-c99f-4ee4-a2f1-017c98567591`
- `67deb118-4818-43b9-a944-d7e144931f0f`
- `7660fbc1-75ba-4785-be01-6d717aedb163`
- `9526d186-56d3-4838-999e-7403cb8ceab2`
- `95852716-d721-44f6-beee-cc1fe1b2f58c`
- `c71aa40b-d040-4cc6-897a-541662099729`

### 3.2 Dead zones が大きい理由

- `dead_zone_stale` は 0 件で、問題の中心は `dead_zone_reachability_risk`（176件）。
- 判定上は「active だが 30 日未選出」群が多数を占める。
- `sourceRefDensity` や鮮度より、到達性（selection される導線）の弱さが主因。

### 3.3 併発シグナル（Over-selected）

- `over_selected_not_used=25`。
- top community では `not_usedRate >= 0.6` が連続している。
- 過選択コミュニティへの露出が高く、dead zone 側に retrieval が回りにくい。

## 4. 回収方針

1. Gate 回収を最優先する（`usedBaselineLost=0` へ）。
2. 次に dead zone を「修復対象」と「棚卸し対象」に分離する。
3. over-selected は dead zone 圧縮の前提として並行是正する。
4. `knowledge_review_queue` ではなく landscape review items フローで管理する。
5. ranking の本番挙動は変更しない（observe-only 原則を維持）。

## 5. 実行フェーズ

### Phase 0: ベースライン固定（当日）

実施:

- 指標スナップショットを JSON で保存する。
- 対象 run / knowledge の一覧を固定する。

完了条件:

- ベースライン JSON 2 つ（snapshot / replay-compare）を保存済み。

### Phase 1: Gate 回収（D0-D1）

実施:

1. 4 run で落ちた 6 knowledge の `title/body/applies_to` をレビューし、facet 適合性を修正する。  
   特に `applies_to={}` の項目を優先修正する。
2. 修正後、`replay-compare (limit=20,currentLimit=12)` を再実行する。
3. `used_baseline_lost` が残る場合は、同 run の top facet（technologies / changeTypes / domains）と candidate trace を突合して再修正する。

完了条件:

- `promotionGateSummary.gateMode=normal`
- `promotionGateSummary.affectedRunCount=0`
- `usedBaselineLostItemCount=0`

### Phase 2: Dead zone 圧縮（D1-D4）

実施:

1. rank 上位の dead zone community（例: rank 14, 26, 33, 50, 51, 58, 60, 61, 63, 64, 73, 76）を優先対象にする。
2. 各 community を次のどちらかに分類する。
   - Reachability repair: 使うべき知識。`applies_to` と表現を修正して到達性を上げる。
   - Lifecycle cleanup: 実質不要。`draft/deprecated` へ移す候補として整理する。
3. 1 日単位で再計測し、dead zone 件数の減少を追う。

完了条件:

- `deadZoneReachabilityCount` が 176 から段階的に減少（第1目標: 140 未満）
- `dead_zone_stale` を増やさずに圧縮できている

### Phase 3: Over-selected 是正（D2-D5）

実施:

1. over-selected 上位（rank 3, 5, 44, 286, 71, 296 など）を対象に、未使用理由を分析する。
2. 適用範囲が広すぎる知識を分割または facet 絞り込みする。
3. `notUsedRate` の高止まりを抑え、dead zone 側に露出を戻す。

完了条件:

- `overSelectedNotUsedCount` が 25 から減少
- top over-selected の `notUsedRate` が 0.6 未満へ低下する項目が増える

## 6. KPI と判定基準

| KPI | Baseline | Target |
|---|---:|---:|
| promotionGateMode | review_required | normal |
| affectedRunCount（limit=20） | 4 | 0 |
| usedBaselineLostItemCount（limit=20） | 6 | 0 |
| deadZoneReachabilityCount | 176 | < 140（第1段階） |
| overSelectedNotUsedCount | 25 | < 20（第1段階） |

## 7. 実行コマンド（再計測用）

```bash
# snapshot（overview 相当）
bun run landscape --json

# replay compare（overview UI 既定に合わせる）
bun run landscape --replay-compare --window-days 30 --limit 20 --run-status all --current-limit 12 --json

# promotion gate review 候補確認（dry-run）
bun run landscape --queue-dry-run --queue-source promotion_gate --window-days 30 --limit 20 --current-limit 12 --json

# landscape review items 一覧
bun run landscape --queue-list --queue-status pending --json
```

## 8. リスクとガードレール

- リスク: Gate 解除を急いで facet を広げすぎると、over-selected が再悪化する。
  - 対応: facet 追加は run ごとに最小差分で行い、毎回 replay compare を確認する。
- リスク: dead zone 圧縮を deprecate 偏重で進めると recall が落ちる。
  - 対応: `repair` と `cleanup` を分離し、先に repair 候補を処理する。
- リスク: queue を誤って wrong verdict レビューと混在させる。
  - 対応: landscape 起因の項目のみを対象に扱う。

## 9. 完了定義

以下を満たした時点で本回収計画は完了とする。

1. Overview の Gate が `review required` から解除される。
2. `dead_zone_reachability_risk` が基準値（第1段階 < 140）まで低下する。
3. 再計測コマンド結果を添えて、改善前後の差分を説明できる。
