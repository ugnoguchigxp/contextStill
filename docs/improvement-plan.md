# memory-router 改善計画

最終更新: 2026-05-14

## 1. 優先度A（次スプリント）

### A-1. Source API の自動テスト追加

- 目的: `folders/pages/history/diff` の回帰防止
- 実装:
  - `api/modules/sources/sources.routes.ts` 向け API テスト追加
  - 一時 content root + 一時 git repo を使う
  - create/update/delete/rename/history/diff を通し確認
- 完了条件:
  - 正常系と 400/404/409 を網羅
  - `bun run verify` に組み込み

### A-2. Graph の Source 連動強化

- 目的: Source 更新が Graph に即反映される運用にする
- 実装:
  - page 保存/削除時に graph 更新トリガーを統一
  - stale ノードのクリーンアップ処理追加
- 完了条件:
  - Source CRUD 後の `GET /api/graph` で不整合なし

### A-3. UI の運用導線改善

- 目的: 管理UIを日常運用しやすくする
- 実装:
  - Sources Explorer の検索・フィルタ
  - 履歴のコミット選択UI（クリックで diff from/to 自動入力）
  - 保存時のエラー表示を API メッセージ連動に統一
- 完了条件:
  - ページ数が多い状態でも操作手数が増えない

## 2. 優先度B（短中期）

### B-1. Embedding 運用の切替容易化

- 目的: `../local-llm` 側モデル変更時の反映コストを下げる
- 実装:
  - `MEMORY_ROUTER_LOCAL_LLM_EMBEDDING_MODEL_DIR` の設定チェックを doctor に追加
  - モデル次元不一致時の警告を doctor に追加
- 完了条件:
  - doctor だけで設定不備を特定可能

### B-2. Source Import の増分化

- 目的: 大規模 wiki の再取り込み時間削減
- 実装:
  - contentHash 比較で未変更ファイルを skip
  - import 結果に create/update/skip 件数を追加
- 完了条件:
  - 2回目取り込みで大半が skip になる

## 3. 優先度C（中期）

### C-1. 権限・監査の最小実装

- 目的: 複数運用者での誤操作リスク軽減
- 実装:
  - API key ベースの簡易認証（ローカル運用前提）
  - CRUD 監査ログ（誰が何を保存・削除したか）
- 完了条件:
  - 主要変更操作が追跡可能

### C-2. Context Compile の評価基盤

- 目的: compile 品質の継続改善
- 実装:
  - 固定入力に対する期待 pack スナップショットテスト
  - degraded 率と retrieval 失敗率の定点観測
- 完了条件:
  - リグレッションを CI で検知可能

