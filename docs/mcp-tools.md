# MCP Tools

`memory-router` の公開 MCP surface は次の 7 ツールです。

1. `initial_instructions`
2. `context_compile`
3. `search_knowledge`
4. `register_knowledge`
5. `memory_search`
6. `memory_fetch`
7. `doctor`

## 推奨フロー

1. `initial_instructions`
2. `context_compile`
3. 必要時のみ `search_knowledge` / `memory_search` / `memory_fetch`
4. 実装・検証
5. `doctor`

## Tool Contract

### `initial_instructions`

- 入力: なし
- 出力: `## 常用ルール` と `## MCPツール種別` の短いガイド

### `context_compile`

- 入力: `goal`（必須）, `intent`, `repoPath`, `files`, `changeTypes`, `technologies`, `includeDraft` など
- 役割: 作業前コンテキスト pack 生成（主導線）
- 挙動:
  - `repoPath` 指定時は repo scoped 検索を優先
  - scoped ヒットがない場合のみ degraded reason 付き fallback
  - no-hit/degraded 時は `diagnostics.retrievalStats.suggestedNextCalls` を返す

### `search_knowledge`

- 入力: `query`（必須）, `repoPath`, `files`, `changeTypes`, `technologies`, `types`, `statuses`, `limit`, `includeDraft`
- 役割: raw knowledge 候補確認
- 出力:
  - 候補配列（`score`, `status`, `scope`, `sourceRefs`, `metadata`）
  - `diagnostics.degradedReasons`
  - `diagnostics.stats`（text/vector hit 数、repo scope fallback など）

### `register_knowledge`

- 入力: `title`（必須）, `body`（必須）, `type`（rule/procedure）, `status`, `scope`, `confidence`, `importance`, `metadata`
- 役割: 新しいルールや手順（スキル）を直接登録。自動的に Embedding が生成されます。デフォルトは `draft` 状態となり、人間のレビュー後に `active` 化されてから `context_compile` で利用可能になります（確信がある場合は `status: "active"` を指定することも可能）。

### `memory_search`

- 入力: `query`（必須）, `sessionId`, `limit`
- 役割: 過去会話・差分の候補探索

### `memory_fetch`

- 入力: `id`（必須）, `start`, `end`, `maxChars`, `query`
- 役割: 特定 memory の詳細参照

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
