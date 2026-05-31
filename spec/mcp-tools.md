# MCP Tools

`context-still` の公開 MCP surface は次の 13 ツールです。

1. `initial_instructions`
2. `context_compile`
3. `compile_eval`
4. `search_knowledge`
5. `register_candidate`
6. `register_candidates`
7. `vibe_memory_say`
8. `vibe_memory_reply`
9. `vibe_memory_peek`
10. `vibe_memory_mark`
11. `search_memory`
12. `fetch_memory`
13. `doctor`

> [!NOTE]
> 以前のスロットベースの `session_memo` ツールは廃止され、無制限に Capsule を追記可能な「Goal Room Memory」協調システム（`vibe_memory` 系 4ツール）へと完全にアップグレードされました。

---

## 推奨フロー

1. **`initial_instructions`**: セッション開始時に一度だけ実行し、常用ルールや hooks 活用指針をロードします。
2. **`vibe_memory_peek`**: 作業開始前に目的の Goal Room に入り、未解決の会話ループ（Open Loops）や Brief（圧縮サマリー）を確認します。
3. **`context_compile`**: `goal` を指定して最小限の最適コンテキストをコンパイルします。
4. **実装・検証**: hooksLLM による自動テスト検証や doctor 接続診断を活用しながら自律開発を行います。
5. **`vibe_memory_say` / `vibe_memory_reply`**: 発見、疑問、設計変更、またはパッチ適用が生じた場合、Capsule や返信をタイムラインに投稿して他のエージェント（または人間）と協調します。
6. **`vibe_memory_mark`**: 課題が解決（resolved）、またはチェックポイントをピン留め（pinned）した場合、マークを付与して状態を更新します。
7. **`compile_eval`**: 作業完了時にコンテキストコンパイラの品質評価を保存します。
8. **ナレッジ登録**: 得られた再利用可能な手順や失敗経験を `register_candidate` で登録します。
9. **`doctor`**: 必要に応じてシステムや DB の状態を診断します。

---

## 命名ポリシー

- `search_*`: 候補探索
- `fetch_*`: 詳細取得

`search_knowledge` に `fetch_knowledge` は追加しない。knowledge は 1 件あたりの情報が軽量で、`search_knowledge` 結果だけで十分に精査できるため。

---

## Deprecated Alias

互換のため、次の旧名は呼び出し可能な期間を残す（ListTools には表示しない）。

- `memory_search` -> `search_memory`
- `memory_fetch` -> `fetch_memory`

---

## Tool Contract

### `initial_instructions`

- 入力: なし
- 出力: `## 常用ルール`（Goal Room 協調ルール、および `hooksLLM` 活用指針）と `## MCPツール種別` のガイド

### `context_compile`

- 入力: `goal`（必須）, `changeTypes`, `technologies`, `domains`
- 役割: 作業前コンテキスト pack 生成（主導線）
- 挙動:
  - `goal` は設計書パスではなく、実装したいマイルストーンを自然文で渡す
  - 出力は knowledge 列挙ではなく、`実装フォーカス` / `実装手順` / `検証観点` を中心とした自然言語コンテキストに整形する
  - 有効な rule/procedure が選べない場合や compile が失敗した場合、Markdown は `No Content` のみ返す

### `compile_eval`

- 入力: `score`（必須）, `outcome`（必須）, `body`（必須）, `runId`（任意）, `title`
- 役割: `context_compile` の作業後評価を保存
- 挙動:
  - `runId` を省略した場合は、同じ session の最新 compile result から評価対象 run を解決する
  - 同一 session に複数の `context_compile` run がある場合は、Vibe Note の `compile_result` を参照して個別に評価を保存する
  - `score` は `0..100` の整数
  - `outcome` は `useful` / `partial` / `misleading` / `unused`

### `search_knowledge`

- 入力: `query`（必須）, `repoPath`, `changeTypes`, `technologies`, `domains`, `types`, `statuses`, `limit`, `includeDraft`
- 役割: raw knowledge 候補確認
- 出力: 候補配列（`score`, `status`, `scope`, `sourceRefs`, `metadata`）および `degradedReasons` / `stats`

### `register_candidate`

- 入力: `title` + `body`, または `text`（自由文/JSON風メモ）, `type`（rule/procedure）, `confidence`, `importance`, `metadata` 等
- 役割: 新しいルールや手順の候補を即時登録する
- 挙動:
  - `distillation_target_states.target_kind = knowledge_candidate` と `find_candidate_results` に候補を保存して即返す
  - その後の draft 化、Embedding 生成、重複判定は蒸留パイプラインが非同期で行う

### `register_candidates`

- 入力: `items`（1〜10件の candidate 配列）
- 役割: 複数の候補をまとめて登録する（best-effort）

### `vibe_memory_say`

- 入力: `goalId`（必須）, `intent`（必須, `ask`/`note`/`finding`/`review`/`decision`等）, `text`（必須）, `goalUri`, `goalAnchorRef`, `wants`, `refs`, `confidence`, `actorId`, `ttlHours`
- 役割: 特定の Goal Room の Capsule タイムラインに新しい共有メモ・タスク・決定事項を投稿する。
- 挙動:
  - 投稿された Capsule は無制限に追記保存され、Brief 生成や未解決 Open Loop 判定のソースとして即時反映される。

### `vibe_memory_reply`

- 入力: `goalId`（必須）, `parentId`（必須）, `intent`（必須）, `text`（必須）, `subject`, `wants`, `refs`, `confidence`, `actorId`
- 役割: Goal Room 内の既存のカプセルに対して返信し、スレッド状の会話ツリーを形成する。

### `vibe_memory_peek`

- 入力: `goalId`（必須）, `profile`（任意, `code-review`/`implementation`等の能力配列）
- 役割: 現在の Goal Room における未解決の会話ループ（Open Loops）と、圧縮された Brief（マニュアル付き要約）をプレビューする。エージェントが作業を開始する前に実行すべき最優先ツール。

### `vibe_memory_mark`

- 入力: `goalId`（必須）, `targetMemoryId`（必須）, `mark`（必須, `resolved`/`stale`/`pinned`等）, `note`, `actorId`
- 役割: カプセルに対して決定論的なステータス（マーク）を付与する。これによって、会話ループの解消（resolved）やマイルストーンの固定（pinned）が行われ、Brief や Open Loop の機械抽出が自動的に同期・アップデートされる。

### `search_memory`

- 入力: `query`（必須）, `sessionId`, `limit`, `includeContent`, `previewChars`
- 役割: 過去会話・差分の候補探索

### `fetch_memory`

- 入力: `id`（必須）, `start`, `end`, `maxChars`, `query`, `includeAgentDiffs`, `returnMetaOnly`
- 役割: 特定 memory の詳細参照

### `doctor`

- 入力: なし
- 役割: DB 接続、Embedding、同期、Automation、および distillation などのシステム全体のヘルスチェック
