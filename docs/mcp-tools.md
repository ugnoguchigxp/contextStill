# MCP Tools

`memory-router` の公開 MCP surface は次の 10 ツールです。

1. `initial_instructions`
2. `context_compile`
3. `search_knowledge`
4. `register_candidate`
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

### `register_candidate`

- 入力: `title` + `body`, または `text`（自由文/JSON風メモ）, `type`（rule/procedure）, `confidence`, `importance`, `appliesTo`, `technologies`, `changeTypes`, `domains`, `repoPath`, `repoKey`, `metadata`
- 役割: 新しいルールや手順（スキル）の候補を即時登録する。登録時点では `knowledge_items` に保存せず、Embedding も生成しない。
- 挙動:
  - `distillation_target_states.target_kind = knowledge_candidate` と `find_candidate_results` に候補を保存して即返す
  - その後の draft 化、Embedding 生成、重複判定、品質判定は蒸留パイプラインが行う
  - `text` だけ渡された場合は、サーバー側で最初の candidate JSON / `TYPE:` `TITLE:` `CONTENT:` 風テキストを `title` / `body` / `type` へ正規化する
- 推奨 JSON:

```json
{
  "title": "修正完了報告前に再現条件で検証する",
  "type": "procedure",
  "body": "Use when:\n- 修正完了を報告する前\n\nWorkflow:\n1. 失敗した再現条件を明示する\n2. 修正後に同じ条件で検証する\n3. 実行結果を確認してから完了報告する\n\nVerification:\n- 失敗していたテストまたは操作が成功している\n\nAvoid:\n- ログやテストを確認せずに治ったと報告する",
  "changeTypes": ["bugfix"],
  "domains": ["verification"]
}
```

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
