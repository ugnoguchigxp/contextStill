# WebUI コンポーネント DRY リファクタリング計画（高優先 + 中優先）

## 1. 目的

`web/src/modules/admin/components` および `web/src/modules/context-compiler/components` の重複 UI 実装を、保守性を落とさず段階的に共通コンポーネント化する。  
本計画は「すぐ着手できる実装チェックリスト」として使う。

## 2. スコープ

### 対象（今回やる）

- 高優先
  - `Overview` / `Doctor` のメトリクスカード共通化
  - `Overview` / `Doctor` のページヘッダー（checkedAt + Refresh + status badge）共通化
  - TanStack Table の sortable header セル共通化
  - `Audit` のページャを `AdminPaginationFooter` に統一
  - モーダル外枠（overlay / panel / close）共通化
- 中優先
  - フィルタチップ + Select 共通化
  - チャートカード枠（Card/Header/Title/Frame）共通化
  - 軽量ユーティリティ（`formatCheckedAt`, `formatDate`, `asRecord`, `parseCsv` など）共通化

### 非対象（今回やらない）

- `GraphPage` の描画/レイアウト計算ロジックの抽象化
- `SourcesPage` / `VibeMemoryPage` のドメイン固有 UI の大規模再設計
- API 契約変更

## 3. 実装方針

- 既存 UI 振る舞いを先に固定し、見た目や UX を変えない共通化を優先する。
- 1タスク = 1論理コミット相当で小さく進める（差分の原因追跡を容易にする）。
- 既存の `web/src/components/ui/*` は「低レイヤ primitive」。今回の共通化は主に `web/src/modules/admin/components/*` 配下に置く。
- 既存ワークツリーは進行中変更があるため、編集対象は明示ファイルに限定する。

## 4. 実行順チェックリスト（着手順）

## Phase 0: ガードレール準備

- [x] 現在の基準を固定する（既存テスト通過確認）
  - `bun run typecheck`
  - `bunx vitest run test/components/admin/*.test.tsx`
  - `bun run build:web`
- [x] 変更対象の明示（この計画にあるファイル以外を編集しない）

完了条件:

- 以降の差分で壊れた箇所を特定できる状態になっている

---

## Phase 1（高優先）: Overview/Doctor の重複解消

### 1-1. Metric カード共通化

- [x] `AdminMetricCard`（仮名）を新規作成
  - 想定配置: `web/src/modules/admin/components/admin-metric-card.tsx`
  - props: `label`, `value`, `hint?`, `className?`
- [x] `overview.page.tsx` の `Metric` ローカル関数を置換
- [x] `doctor.page.tsx` の `Metric` ローカル関数を置換

対象ファイル:

- `web/src/modules/admin/components/overview.page.tsx`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/modules/admin/components/admin-metric-card.tsx`（新規）

完了条件:

- `overview.page.tsx` と `doctor.page.tsx` から `Metric` ローカル実装が消える
- 表示崩れがない

### 1-2. ページヘッダー共通化

- [x] `AdminPageHeader`（仮名）を新規作成
  - 想定配置: `web/src/modules/admin/components/admin-page-header.tsx`
  - 要素: title, checkedAt, refresh button, status badge, optional right actions
- [x] `overview.page.tsx` の header section を置換
- [x] `doctor.page.tsx` の header section を置換

対象ファイル:

- `web/src/modules/admin/components/overview.page.tsx`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/modules/admin/components/admin-page-header.tsx`（新規）

完了条件:

- 見た目/文言/ボタン挙動（refetch）が既存一致
- status badge の variant 判定が既存一致

---

## Phase 2（高優先）: テーブル共通部品の統一

### 2-1. Sortable Table Header Cell 共通化

- [x] `AdminSortableTableHead`（仮名）を新規作成
  - 想定配置: `web/src/modules/admin/components/admin-sortable-table-head.tsx`
  - `ArrowUp/ArrowDown/ArrowUpDown` を内包
- [x] `audit.page.tsx` へ適用
- [x] `candidates.page.tsx` へ適用
- [x] `knowledge.page.tsx` へ適用

対象ファイル:

- `web/src/modules/admin/components/audit.page.tsx`
- `web/src/modules/admin/components/candidates.page.tsx`
- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/admin/components/admin-sortable-table-head.tsx`（新規）

完了条件:

- 3画面の sortable ヘッダ挙動が一致
- ソートアイコン表示ロジックが共通化されている

### 2-2. Audit ページャ統一

- [x] `audit.page.tsx` の `visiblePageNumbers` ローカル実装を削除
- [x] `AdminPaginationFooter` を利用するよう置換
- [x] 文言差分（`Previous` / `Prev` 等）を UI 方針に合わせて統一

対象ファイル:

- `web/src/modules/admin/components/audit.page.tsx`
- `web/src/modules/admin/components/admin-pagination-footer.tsx`（必要なら拡張）

完了条件:

- `knowledge` / `candidates` / `audit` のページャ見た目・挙動が同系統
- `audit.page.tsx` にページ番号計算ロジックが残っていない

---

## Phase 3（高優先）: モーダル外枠共通化

### 3-1. Admin Modal Shell 作成

- [x] `AdminModalShell`（仮名）を新規作成
  - 想定配置: `web/src/modules/admin/components/admin-modal-shell.tsx`
  - overlay, panel, header, close, body slot, footer slot を提供
- [x] `knowledge.page.tsx` の modal を置換
- [x] `audit.page.tsx` の detail modal を置換

対象ファイル:

- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/admin/components/audit.page.tsx`
- `web/src/modules/admin/components/admin-modal-shell.tsx`（新規）

完了条件:

- 閉じる操作（背景クリック、Close ボタン）が既存一致
- スクロール挙動・最大高さ・フォーカス破綻なし

注記:

- `sources.page.tsx` の全画面プレビューは modal というより full-screen preview のため、初回共通化対象からは外す（必要なら別コンポーネント）。

---

## Phase 4（中優先）: フィルタ UI 共通化

### 4-1. フィルタチップ + Select 共通化

- [x] `AdminFilterChipSelect`（仮名）を新規作成
  - label + select の一体 UI
  - サイズ/幅を props 化
- [x] `audit.page.tsx` の `Event Type` / `Actor` を置換
- [x] `knowledge.page.tsx` の `Filter` / `Quality` を置換

対象ファイル:

- `web/src/modules/admin/components/audit.page.tsx`
- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/admin/components/admin-filter-chip-select.tsx`（新規）

完了条件:

- 見た目は同等、既存フィルタロジックはそのまま
- 変更時の `resetToFirstPage()` など副作用が欠落しない

---

## Phase 5（中優先）: チャートカード共通化

### 5-1. チャートカード枠共通化

- [x] `AdminChartCard`（仮名）を新規作成
  - title + content frame + empty state の共通枠
- [x] `overview-charts.tsx` を置換
- [x] `doctor-charts.tsx` を置換

対象ファイル:

- `web/src/modules/admin/components/overview-charts.tsx`
- `web/src/modules/admin/components/doctor-charts.tsx`
- `web/src/modules/admin/components/admin-chart-card.tsx`（新規）

完了条件:

- チャート本体設定は不変、枠コードのみ共通化
- `No latency data` 等の empty state 表示が維持される

---

## Phase 6（中優先）: 軽量ユーティリティ統一

### 6-1. shared utils への切り出し

- [x] `admin-ui-formatters.ts`（仮名）新規作成
  - `formatCheckedAt`, `formatDate(系)`, `formatPercent(系)` を整理
- [x] `admin-ui-parsers.ts`（仮名）新規作成
  - `asRecord`, `parseCsv` の共通化（戻り値差異に注意）
- [x] `overview.page.tsx` / `doctor.page.tsx` / `knowledge.page.tsx` / `context-compiler.page.tsx` 適用

対象ファイル:

- `web/src/modules/admin/components/overview.page.tsx`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/context-compiler/components/context-compiler.page.tsx`
- `web/src/lib/admin-formatters.ts`（新規）
- `web/src/lib/data-utils.ts`（新規）

完了条件:

- 同名/同等関数のローカル重複が減っている
- 型互換性を崩さない（特に `parseCsv: string[]` と `string[] | undefined`）

## 5. 検証チェックリスト（各 Phase 共通）

- [x] `bun run typecheck`
- [x] `bunx biome lint <変更ファイル>`
- [x] `bunx biome format <変更ファイル>`
- [x] `bunx vitest run test/components/admin/knowledge-page.test.tsx test/components/admin/knowledge-candidates-page.test.tsx test/components/admin/graph-page.test.tsx`
- [x] 必要時 `bun run build:web`

追加検証（UI変更を含む Phase）:

- [ ] `overview` / `doctor` / `audit` / `knowledge` / `candidates` 画面で目視確認
- [ ] テーブル列幅、折り返し、ページネーション、ソートが既存通り
- [ ] モーダルの開閉・スクロールが既存通り

## 6. 進行管理テンプレート（実作業用）

以下を Phase ごとに更新して運用する。

- [x] Phase 0 完了
- [x] Phase 1 完了
- [x] Phase 2 完了
- [x] Phase 3 完了
- [x] Phase 4 完了
- [x] Phase 5 完了
- [x] Phase 6 完了

進捗メモ:

- owner:
- branch:
- startedAt:
- updatedAt:
- blockedBy:
- notes:

## 7. リスクと回避策

- props 過剰抽象化で可読性低下
  - 回避: まず 2-3 画面の重複だけを対象にし、汎用化しすぎない
- 挙動差分の混入（ソート・フィルタ副作用）
  - 回避: 各置換前後で handler の呼び出し点を比較
- 既存進行中差分との競合
  - 回避: 変更対象ファイルをこの計画に限定し、小さくコミットする

## 8. 完了定義（Definition of Done）

- 高優先 + 中優先の全チェックが完了
- UI挙動の後方互換が担保される
- 共通コンポーネント導入により、同型 UI 修正時の編集箇所が減っている
- `typecheck` / 主要テスト / `build:web` が通過している
