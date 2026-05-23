# MCP Tools

`memory-router` の公開 MCP surface は次の 7 ツールです。

1. `initial_instructions`
2. `context_compile`
3. `search_knowledge`
4. `register_candidate`
5. `search_memory`
6. `fetch_memory`
7. `doctor`

## 推奨フロー

1. `initial_instructions`
2. `context_compile`
3. 必要時のみ `search_knowledge` / `search_memory` / `fetch_memory`
4. 実装・検証
5. `doctor`

## 命名ポリシー

- `search_*`: 候補探索
- `fetch_*`: 詳細取得

`search_knowledge` に `fetch_knowledge` は追加しない。knowledge は 1 件あたりの情報が軽量で、`search_knowledge` 結果だけで十分に精査できるため。

## Deprecated Alias

互換のため、次の旧名は呼び出し可能な期間を残す（ListTools には表示しない）。

- `memory_search` -> `search_memory`
- `memory_fetch` -> `fetch_memory`

## Tool Contract

### `initial_instructions`

- 入力: なし
- 出力: `## 常用ルール` と `## MCPツール種別` の短いガイド

### `context_compile`

- 入力: `goal`（必須）, `changeTypes`, `technologies`, `domains`
- 役割: 作業前コンテキスト pack 生成（主導線）
- 挙動:
  - `goal` は設計書パス（例: `docs/*.md`, `design.md`, `spec.md`）ではなく、実装したいマイルストーンを自然文で渡す
  - `changeTypes` から retrieval mode を自動導出
  - unknown facet は diagnostics に残しつつ query text には保持
  - MCP レスポンスは LLM向け Markdown 1件のみを返す（JSON pack は DB/UI 側で保持）
  - 出力は knowledge 列挙ではなく、`実装フォーカス` / `実装手順` / `検証観点` を中心とした自然言語コンテキストに整形する
  - 有効な rule/procedure が選べない場合や compile が失敗した場合、Markdown は `No Content` のみ返す

### `search_knowledge`

- 入力: `query`（必須）, `repoPath`, `changeTypes`, `technologies`, `domains`, `types`, `statuses`, `limit`, `includeDraft`
- 役割: raw knowledge 候補確認
- 出力:
  - 候補配列（`score`, `status`, `scope`, `sourceRefs`, `metadata`）
  - `diagnostics.degradedReasons`
  - `diagnostics.stats`（text/vector hit 数、repo scope fallback など）

### `register_candidate`

- 入力: `title` + `body`, または `text`（自由文/JSON風メモ）, `type`（rule/procedure）, `confidence`, `importance`, `appliesTo`, `technologies`, `changeTypes`, `domains`, `repoPath`, `repoKey`, `metadata`
- 役割: 新しいルールや手順（スキル）の候補を即時登録する。登録時点では `knowledge_items` に保存せず、Embedding も生成しない。
- 挙動:
  - `distillation_target_states.target_kind = knowledge_candidate` と `find_candidate_results` に候補を保存して即返す
  - その後の draft 化、Embedding 生成、重複判定、品質判定は蒸留パイプラインが行う
  - `text` だけ渡された場合は、サーバー側で最初の candidate JSON / `TYPE:` `TITLE:` `CONTENT:` 風テキストを `title` / `body` / `type` へ正規化する

### `search_memory`

- 入力: `query`（必須）, `sessionId`, `limit`, `includeContent`, `previewChars`
- 役割: 過去会話・差分の候補探索
- 既定:
  - `includeContent=false`（本文は返さない）
  - `includeContent=true` 時は `contentPreview` のみ返す（全文は返さない）

### `fetch_memory`

- 入力: `id`（必須）, `start`, `end`, `maxChars`, `query`, `includeAgentDiffs`, `returnMetaOnly`
- 役割: 特定 memory の詳細参照
- 既定:
  - `includeAgentDiffs=false`
  - `returnMetaOnly=false`
- 出力:
  - `content`（`returnMetaOnly=true` なら省略）
  - `sliceStart`, `sliceEnd`, `truncated`, `contentLength`

### `doctor`

- 入力: なし
- 役割: システム全体のヘルスチェックと診断
- 診断項目:
  - DB 接続、テーブル構成、`pgvector` 拡張の状態
  - Embedding サービス（Daemon/CLI）の稼働状況
  - MCP ツール（Primary）が正しく公開されているか
  - Agent Log（Codex/Antigravity）の同期状態と LaunchAgent の稼働
  - Distillation（Vibe/Source）のバッチ実行状況とデータの鮮度
  - 直近の `context_compile` 実行の成功率・劣化率（Run Health）
