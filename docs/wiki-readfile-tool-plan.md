# Wiki Source 読み込みツール実装計画（readFileドメイン）

作成日: 2026-05-19  
対象リポジトリ: `memory-router`  
方針: **実装は行わず、計画のみ**

## 1. 目的

`wiki/pages/**/*.md` を対象に、LLM向け入力を安定化する `read_file` MCP ツールを定義する。  
今回の主眼は「蒸留ロジック」ではなく、**入力を markdown 化し、装飾を除去し、token 単位で継続読みできること**。

## 2. 必須要件（今回反映）

1. 入力を `markdownify` で Markdown 化する。
2. Markdown 装飾を除去する。
3. 改行をスペースに置換する。
4. スペース2つ以上を1つに圧縮する。
5. デフォルトで **1500 token** 分を読み込む。
6. 継続読み込みとして、**「1500 token から x token」** の指定を受けられる。
7. HTML解説などで崩れを避けるため、`minify` を `off` にできる。

## 3. 非目標（今回やらない）

- findCandidate / coverEvidence / finalizeDistille 本体実装。
- 候補抽出や検証の品質改善ロジック。
- テストの大規模追加（最小の手動確認のみ）。

## 4. ツール契約（read_file）

### 4.1 ツール名

- MCP: `read_file`
- ドメイン: `src/modules/readFile/`

### 4.2 入力

- `path: string`  
  - `wiki/pages` 配下のみ許可
- `fromToken?: number`  
  - 既定 `0`
- `readTokens?: number`  
  - 既定 `1500`
- `includeFrontmatter?: boolean`  
  - 既定 `false`（LLM向け通常読み）
- `minify?: boolean`  
  - 既定 `true`
  - `false` の場合、改行/空白圧縮を行わない
- `minifiy?: boolean`  
  - 互換入力（typo吸収）。`minify` 未指定時のみ参照

使用例:
- 初回: `{ "path": "...", "readTokens": 1500 }`
- 継続: `{ "path": "...", "fromToken": 1500, "readTokens": 800 }`
- HTML解説を崩さない: `{ "path": "...", "readTokens": 1500, "minify": false }`

### 4.3 出力

- `path: string`
- `content: string`（最終正規化済みテキスト）
- `tokenRange: { from: number, toExclusive: number }`
- `hasMore: boolean`
- `nextFromToken?: number`
- `stats`:
  - `totalTokens: number`
  - `returnedTokens: number`
  - `charCount: number`
  - `contentHash: string`

## 5. 正規化パイプライン

`read_file` は以下の順で処理する。

1. ファイル読み込み（UTF-8）。
2. `markdownify` 段階で Markdown 化。  
   - `.md` はそのまま入力として扱う。  
   - 将来 `.html` 等を読む場合は同じ段階で Markdown 化する。
3. Markdown 装飾除去（プレーンテキスト化）。
4. `minify=true` の場合のみ:
   - `\r\n` / `\n` をスペースへ置換
   - 連続空白（2個以上）を1個へ圧縮
   - trim
5. `minify=false` の場合:
   - 改行と空白幅を維持（トークン切り出しのみ実施）
6. token 化して `fromToken/readTokens` の範囲を返却。

## 6. 実装方針（重要）

- 装飾除去は「過度な正規表現置換」を避け、ASTベースまたは構造的処理を優先する。
- 正規化後テキストは可観測性のため `contentHash` を返す。
- token 切り出しは常に決定的（同一入力で同一結果）にする。
- 例外時は `TOOL_ERROR` で返し、原因（path不正/token範囲不正/読込失敗）を分離する。
- `minify=false` 時は、可読性優先で改行/空白を保持する。

## 7. フェーズ計画

### Phase A: readFileドメイン骨格

対象:
- `src/modules/readFile/domain.ts`（新規）

作業:
- 入出力型、error型、安全path解決。
- 正規化パイプライン関数の実装枠だけ定義。

完了条件:
- `path/fromToken/readTokens` を受けるドメイン契約が固定される。

### Phase B: markdownify + 正規化処理

対象:
- `src/modules/readFile/markdownify.service.ts`（新規）
- `src/modules/readFile/normalize.service.ts`（新規）

作業:
- Markdown 化処理。
- 装飾除去を実装。
- `minify=true/false` 分岐を実装。
- `minify=true` 時のみ改行空白化・空白圧縮を実装。

完了条件:
- 1ファイルに対し正規化済み単一文字列が得られる。

### Phase C: token window 読み込み

対象:
- `src/modules/readFile/token-window.service.ts`（新規）

作業:
- `fromToken/readTokens` 切り出し。
- `hasMore/nextFromToken` 計算。

完了条件:
- 「1500 tokenからx token読む」が再現可能。

### Phase D: MCP公開

対象:
- `src/mcp/tools/read-file.tool.ts`（新規）
- `src/mcp/tools/index.ts`（登録）
- `docs/mcp-tools.md`（追記）

作業:
- Zod schema と handler 定義。
- ツール一覧に公開。

完了条件:
- MCP クライアントから `read_file` 呼び出し可能。

### Phase E: 設定値

対象:
- `src/constants.ts`
- `src/config.types.ts`
- `src/config.ts`
- `.env.example`

作業:
- `MEMORY_ROUTER_READ_FILE_ROOT`（既定 `wiki/pages`）
- `MEMORY_ROUTER_READ_FILE_DEFAULT_TOKENS`（既定 `1500`）
- `MEMORY_ROUTER_READ_FILE_MAX_TOKENS`（上限）

完了条件:
- 環境変数未指定でも 1500 token 既定で動作。

### Phase F: 最小確認（テスト大量追加なし）

作業:
- 手動確認のみ:
  - 初回1500token
  - fromToken指定の継続読み
  - 連続読みで重複/欠落がないこと
  - `minify=false` 時に改行が保持されること
  - ルート外path拒否

完了条件:
- Wiki読み込みの前処理が安定し、蒸留の前段入力として利用可能。
