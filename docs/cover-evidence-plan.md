# coverEvidence 実装計画（候補単位の知識成立判定）

## 1. 目的
- `findCandidate` で選ばれた候補1件ごとに、知識として成立可能かを段階的に判定する。
- 成立した候補は、必要な補強（title/content/type/importance/confidence）を行い、`knowledge` の `draft` として登録する。
- 成立しなかった候補は、どの段階で失敗したかを記録して終了する。

## 2. 前提（責務境界）
- `findCandidate`:
  - 候補を抽出するまで（評価しない）
- `coverEvidence`:
  - 候補を検証・補強・重複判定し、draft登録可否を決める
- `finalizeDistille`:
  - draft の最終確定/昇格（本計画の外）

## 3. 実行単位
- 実行単位は **findCandidate候補1件**（`find_candidate_results.id`）
- 1実行で複数候補を混ぜない

## 4. ステージングフロー（終了条件つき）
順番に実行し、成立した時点で終了する。

### Stage 0: LLM単独で成立できるか
- 入力: 候補の `title/content` + 元ソース読取（`read_file` or `memory_reader`）
- 判定:
  - 1知識として自己完結している
  - 曖昧語が少なく、手順/ルールとして実行可能
- 成立なら終了（draft登録へ）

### Stage 1: knowledge参照で重複/近傍衝突チェック
- `search_knowledge`（または同等の既存知識参照）で類似候補を取得
- 判定:
  - 完全重複（文意同一）なら不成立終了（`duplicate`）
  - vector的近傍が高すぎる場合は不成立終了（`near_duplicate`）
  - 近傍だが差分価値ありなら継続

### Stage 2: web検索 + fetch で補完して成立できるか
- `search_web` -> `fetch_content` で外部根拠を追加
- Web検索プロバイダ順は `brave` をデフォルト、失敗時 `exa` をフォールバック
- 補完後に再判定:
  - 成立なら終了（draft登録へ）
  - 不成立なら次ステージ

### Stage 3: context7 / deepwiki MCP で補完して成立できるか
- `context7` / `deepwiki` が利用可能なら参照
- 補完後に再判定:
  - 成立なら終了（draft登録へ）
  - 不成立なら次ステージ

### Stage 4: 不成立終了
- ここまでで成立しなければ `insufficient` として終了
- 失敗理由と試行履歴を保存

## 5. coverEvidence の出力契約（JSON固定）
```json
{
  "status": "knowledge_ready | duplicate | near_duplicate | insufficient",
  "type": "rule | procedure",
  "title": "refined title",
  "content": "refined content",
  "importance": 0,
  "confidence": 0,
  "references": [
    {
      "kind": "source | web | context7 | deepwiki | knowledge",
      "uri": "string",
      "note": "short reason"
    }
  ],
  "stage": "llm_only | dedupe | web | mcp | failed",
  "reason": "optional short reason"
}
```

## 6. 保存要件
### 6.1 coverEvidence実行結果テーブル（新規）
- `cover_evidence_results`
  - `id`
  - `find_candidate_result_id` (unique)
  - `status`
  - `type`
  - `title`
  - `content`
  - `importance`
  - `confidence`
  - `stage`
  - `reason`
  - `references` (jsonb)
  - `raw_output`
  - `provider`
  - `model`
  - `metadata`（readRanges, duplicateScore, triedStages）
  - `created_at/updated_at`

### 6.2 knowledge draft登録
- `status=knowledge_ready` の時のみ `knowledge` に `draft` 登録
- `sourceUri` 相当には候補起点 + 参考URLを入れる
- UI表示対象に乗ること（既存の draft 一覧導線）

## 7. 採点と変換ルール
- `type`: `rule` / `procedure` を必須選定
- `importance`: 実務インパクト（0-100）
- `confidence`: 根拠確からしさ（0-100）
- `title/content` は coverEvidence 時点で更新可
  - ただし「新情報の創作」は禁止
  - 参考元の裏付け範囲内でのみ重厚化

## 8. ツール利用ポリシー
- Stage 0:
  - `read_file` / `memory_reader` のみ
- Stage 1:
  - `search_knowledge`（または等価）
- Stage 2:
  - `search_web` + `fetch_content`
- Stage 3:
  - `context7` / `deepwiki`（利用可能な場合のみ）
- すべての参照結果は `references[]` に保存する

## 9. Provider戦略（コスト最適）
- デフォルト:
  - `wiki_file` 候補: `azure-openai`
  - `vibe_memory` 候補: `local-llm`
- `coverEvidence` は原則 `local-llm`
  - `insufficient` / `parse_failed` / `near_duplicate判定が不安定` の時だけ `azure-openai` 再試行

## 10. CLI計画
- `bun run cover-evidence -- --find-candidate-result-id <id> --text|--write`
- `--text`:
  - DB保存前の同一JSONを表示（デバッグ）
- `--write`:
  - 同一JSONを保存 + `knowledge draft` まで実行
- 重要:
  - CLIと本番保存で **同一system context / 同一抽出ロジック**
  - 表示形式だけ変える

## 11. ドメイン分割案（推奨）
`coverEvidence` は複雑なので、内部を以下に分割するのを推奨。

1. `evaluateKnowledgeReadiness`  
   - Stage 0〜4 のオーケストレーション
2. `dedupeKnowledgeCandidate`  
   - 既存knowledgeとの重複/近傍判定
3. `enrichCandidateEvidence`  
   - web/context7/deepwiki 補完
4. `registerKnowledgeDraft`  
   - draft 登録 + UI露出に必要な保存処理

外部公開ドメイン名は `coverEvidence` のまま維持し、内部サービス分割で複雑性を下げる。

## 12. 段階実装
1. スキーマ追加（`cover_evidence_results`）+ repository
2. Stage 0 実装（LLM単独成立判定）
3. Stage 1 実装（dedupe/near-duplicate）
4. Stage 2 実装（web補完）
5. Stage 3 実装（context7/deepwiki補完）
6. draft登録実装
7. CLI + audit log

## 13. 受け入れ基準
- 候補1件ごとに、終了ステージが必ず保存される
- `knowledge_ready` は必ず `type/importance/confidence/references` が埋まる
- `--text` と `--write` で判定内容が一致する
- `insufficient` の場合、失敗理由と試行済みステージが追跡可能
