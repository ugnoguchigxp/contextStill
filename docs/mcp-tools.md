# MCP Tools

`memory-router` の公開 MCP surface は次の 10 ツールです。

1. `initial_instructions`
2. `context_compile`
3. `search_knowledge`
4. `register_knowledge`
5. `list_knowledge`
6. `update_knowledge`
7. `memory_search`
8. `memory_fetch`
9. `read_file`
10. `doctor`

## 推奨フロー

1. `initial_instructions`
2. `context_compile`
3. 必要時のみ `search_knowledge` / `list_knowledge` / `update_knowledge` / `memory_search` / `memory_fetch` / `read_file`
4. 実装・検証
5. `doctor`

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

### `register_knowledge`

- 入力: `title`（必須）, `body`（必須）, `type`（rule/procedure）, `status`, `scope`, `confidence`, `importance`, `metadata`
- 役割: 新しいルールや手順（スキル）を直接登録。自動的に Embedding が生成されます。デフォルトは `draft` 状態となり、人間のレビュー後に `active` 化されてから `context_compile` で利用可能になります（確信がある場合は `status: "active"` を指定することも可能）。

### `list_knowledge`

- 入力: `limit`, `status`, `type`, `query`
- 役割: draft backlog や active knowledge 一覧を確認する
- 出力:
  - `filters`（適用した条件）
  - `count`
  - `items`（knowledge 一覧。`sourceRefs` / `sourceVibeMemoryIds` を含む）

### `update_knowledge`

- 入力: `id`（必須）, `status`, `title`, `body`, `type`, `scope`, `confidence`, `importance`, `metadata`
- 役割: 既存 knowledge のステータス/内容を更新する
- 挙動:
  - `draft -> active -> deprecated` の遷移制約を検証
  - `metadata` 指定時は既存 metadata にマージ
  - 更新内容に応じて監査ログ（knowledge updated/status changed）を記録

### `memory_search`

- 入力: `query`（必須）, `sessionId`, `limit`
- 役割: 過去会話・差分の候補探索

### `memory_fetch`

- 入力: `id`（必須）, `start`, `end`, `maxChars`, `query`
- 役割: 特定 memory の詳細参照

### `read_file`

- 入力: `path`（必須）, `fromToken`, `readTokens`, `includeFrontmatter`, `minify`, `minifiy`
- 役割: wiki markdown を token 窓で部分読みする
- 既定:
  - `readTokens`: 1500
  - `fromToken`: 0
  - `minify`: true
- 継続読み:
  - 先頭 1500 token 以降を読むには `fromToken: 1500` を指定
- `minify=false`:
  - Markdown 装飾と改行や空白幅を保持して返す
- 出力（最小メタ）:
  - `content`, `totalTokens`, `from`, `toExclusive`, `returnedTokens`

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
