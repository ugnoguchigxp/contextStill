# MCP Tool Refresh 実装計画

最終更新: 2026-05-23

## 1. 目的

- MCP ツール群を「日常運用で本当に使う導線」に再編し、LLM の context 消費を削減する。
- `search_memory` と `fetch_memory` の責務を明確に分離する。
- 既存クライアント互換を維持したまま段階的に刷新する。

## 2. 背景と現状課題

現行の公開ツールは 10 個 (`docs/mcp-tools.md`)。運用上は以下の課題がある。

1. `memory_search`（現行名）が本文を返すため、探索フェーズで context を使いすぎる。
2. `memory_fetch`（現行名）は詳細取得として有効だが、検索フェーズとの責務境界が曖昧。
3. `list_knowledge` / `update_knowledge` / `read_file` は常用フロー外で、初見利用者に判断コストが高い。
4. `search_knowledge` の使い方（agentic search としてどう使うか）がドキュメントで弱い。

## 3. 設計方針

1. **探索 (`search`) と読解 (`fetch`) を分離する。**
2. **不要ツールは最終的に公開 surface から廃止する。**
3. **互換性を壊す変更は feature flag と段階移行で行う。**
4. **ツール追加より先に contract とドキュメントを揃える。**

## 3.1 最終ツール一覧（刷新後に残す公開 MCP ツール）

最終的に公開 surface に残すのは次の 7 ツールとする。

1. `initial_instructions`
2. `context_compile`
3. `search_knowledge`
4. `register_candidate`
5. `search_memory`
6. `fetch_memory`
7. `doctor`

## 3.2 廃止対象（公開 surface から削除）

以下 3 ツールは公開 MCP surface から廃止する。

- `list_knowledge`
- `update_knowledge`
- `read_file`

補足:
- DB/内部機能として即削除する必要はない。まず公開 tool としての露出を止める。
- 代替導線は `context_compile` / `search_knowledge` / `fetch_memory` に寄せる。

命名統一ポリシー:
- `search_*` は探索、`fetch_*` は詳細取得に統一する。
- `search_knowledge` に `fetch_knowledge` を追加しない（knowledge は `search_knowledge` の返却 1件ごとに本文を含み、追加 fetch の利益が小さいため）。

## 4. 対象範囲 / 非対象

### 対象

- `src/mcp/tools/memory.tool.ts`
- `src/modules/vibe-memory/vibe-memory.service.ts`（必要なら検索返却 shape を調整）
- `src/mcp/tools/system.tool.ts`（`initial_instructions` の最小導線更新）
- `src/mcp/tools/knowledge.tool.ts`（`search_knowledge` 利用ガイドに合わせた説明整理）
- `docs/mcp-tools.md`
- 契約・ツールテスト

### 非対象

- distillation パイプライン仕様変更
- context_compile の ranking ロジック変更
- DB スキーマ大規模変更

## 5. 実装マイルストーン

## Milestone 1: `search_memory`（旧 `memory_search`）を探索専用にする

### ゴール

`search_memory` のデフォルト返却を「候補判別に必要な最小情報」に限定する。

### 変更内容

1. `search_memory` input に以下を追加する。
   - `includeContent?: boolean`（default: `false`）
   - `previewChars?: number`（default: `0`。`includeContent=true` 時のみ有効）
2. デフォルト返却項目を以下に制限する。
   - `id`, `sessionId`, `memoryType`, `createdAt`, `score`
   - `title`（先頭行抽出。未抽出時は短い `summary`）
3. `includeContent=false` では本文 (`content`) を返さない。
4. `includeContent=true` でも `previewChars` 上限で短い preview のみにする（全文は返さない）。

### 受け入れ条件

- 既定呼び出しで本文が返らない。
- 候補 ID 判別に必要な情報で再検索/絞り込みが可能。
- 既存クライアントがエラーにならない。

## Milestone 2: `fetch_memory`（旧 `memory_fetch`）を詳細読解専用にする

### ゴール

`fetch_memory`（旧 `memory_fetch`）で必要な範囲だけ確実に読める contract にする。

### 変更内容

1. 既存引数 (`id`, `start`, `end`, `maxChars`, `query`) は維持。
2. `query` 利用時の周辺抽出を明示化する。
   - `maxChars` 未指定時の既定値を仕様として固定（例: 1000 chars）。
3. オプション追加:
   - `includeAgentDiffs?: boolean`（default: `false`）
   - `returnMetaOnly?: boolean`（default: `false`）
4. 返却に `slice` 情報を含める。
   - `sliceStart`, `sliceEnd`, `truncated`

### 受け入れ条件

- `fetch_memory` だけで「全文」「範囲」「query周辺」の3パターンを扱える。
- `includeAgentDiffs=false` で不要 payload が抑制される。

## Milestone 3: MCP 公開面の再編（Core 固定 + 廃止対象分離）

### ゴール

最終公開ツールを 7 個に固定し、初期導線を簡潔化する。

### 変更内容

1. `initial_instructions` を更新し、常用導線を次で固定する。
   - `initial_instructions -> context_compile -> (必要時) search_knowledge/search_memory/fetch_memory -> doctor`
2. `docs/mcp-tools.md` を更新し、公開ツール一覧を最終 7 ツールに合わせる。
3. `list_knowledge` / `update_knowledge` / `read_file` を `src/mcp/tools/index.ts` の exposed tools から除外する（内部実装は残してよい）。
4. ツール名を統一する。
   - `memory_search` -> `search_memory`
   - `memory_fetch` -> `fetch_memory`
5. `search_knowledge` の推奨利用を明文化。
   - 「通常は `context_compile`、候補精査・agentic search補助時のみ `search_knowledge`」

### 受け入れ条件

- 初回利用者が 7 ツールの範囲で運用開始できる。
- 廃止対象 3 ツールが ListTools に出ない。

## Milestone 4: 互換性と段階移行（廃止反映）

### ゴール

既存クライアントを壊さずに新 contract へ移行する。

### 変更内容

1. 互換ポリシー:
   - 既存必須引数は維持。
   - 新引数は optional で追加。
2. 返却 shape 変更は段階化:
   - Phase A: 旧 shape を保持しつつ新フィールド追加
   - Phase B: `MEMORY_ROUTER_MCP_V2=1` で新デフォルト有効化
   - Phase C: 次 minor で新デフォルトを標準化
3. ツール廃止は段階化:
   - Phase A: `initial_instructions` / docs に deprecate 告知
   - Phase B: `MEMORY_ROUTER_MCP_V2=1` で廃止対象を非公開化
   - Phase C: 次 minor で既定を非公開化（最終 7 ツール）
4. ツール名変更は段階化:
   - Phase A: `search_memory` / `fetch_memory` を追加し、`memory_search` / `memory_fetch` は alias として残す
   - Phase B: v2 で旧名を非推奨表示（`initial_instructions` と docs で告知）
   - Phase C: 次 minor で旧名を公開 surface から削除
5. 変更ログを `docs/mcp-tools.md` に追記。

### 受け入れ条件

- `test/mcp.contract.test.ts` が通る。
- v1/v2 両モードで `test/mcp.tools.test.ts` が通る。
- v2 では ListTools が最終 7 ツールのみを返す。

## 6. テスト計画

1. `test/mcp.tools.test.ts`
   - `search_memory`: default で本文が返らないこと
   - `search_memory`: `includeContent=true` で preview のみ返ること
   - `fetch_memory`: `query` 周辺抽出、`start/end` 切り出し、`truncated` 判定
   - 旧名 alias (`memory_search` / `memory_fetch`) の互換動作
2. `test/mcp.contract.test.ts`
   - 既存ツール名セットが維持されること
   - 新 optional 引数の schema 契約
   - v2 で公開ツールが最終 7 件であること
3. `test/mcp.server.test.ts` / `test/mcp-server.test.ts`
   - ListTools/CallTool で後方互換を維持
4. 必要に応じて snapshot test 追加
   - `initial_instructions` の Core/Optional 表示

## 7. リスクと対策

1. **既存エージェントが `memory_search.content` 依存**
   - 対策: v2 flag 段階移行 + リリースノート明示
2. **検索ヒット判別に必要な情報不足**
   - 対策: `title/summary` 抽出ルールを定義し、最小情報を保証
3. **旧ツール名 (`memory_search` / `memory_fetch`) 直呼びクライアントの失敗**
   - 対策: alias 併走期間を設け、削除時期を固定して告知
4. **廃止対象ツールを呼んでいる既存クライアントの失敗**
   - 対策: deprecate 告知期間を設け、v1/v2 併走、移行先ツールを明記
5. **ドキュメントと実装の乖離**
   - 対策: 実装 PR で `docs/mcp-tools.md` 同時更新を必須化

## 8. 実装順序（推奨）

1. Milestone 1 (`search_memory` 軽量化 + 旧名 alias)
2. Milestone 2 (`fetch_memory` 詳細化 + 旧名 alias)
3. Milestone 3 (公開 7 ツール化 + 廃止対象分離)
4. Milestone 4 (flag 移行 + 廃止反映 + 契約テスト固定)

## 9. 完了判定

- Core フローでの実運用時に、探索段階の平均レスポンス文字量が現状比で有意に減少している。
- `search_memory -> fetch_memory` の二段運用が docs と実装で一致している。
- 主要 MCP テスト群が通過し、最終公開ツールが 7 件で固定されている。
