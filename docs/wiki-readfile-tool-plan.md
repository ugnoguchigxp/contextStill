# Wiki Source 読み込みツール実装メモ（readFileドメイン）

作成日: 2026-05-19  
対象リポジトリ: `memory-router`

## 目的

`wiki/pages/**/*.md` を LLM が安定して部分読みできるようにする。蒸留ロジック本体とは分離し、入力を Markdown 化してから token window で返す。

## 現行契約

MCP ツール名: `read_file`

入力:

- `path: string`（必須）
- `fromToken?: number`（既定 `0`）
- `readTokens?: number`（既定 `1500`）
- `includeFrontmatter?: boolean`（既定 `false`）
- `minify?: boolean`（既定 `true`）
- `minifiy?: boolean`（typo 互換。`minify` 未指定時のみ参照）

出力は flat JSON にする。

- `content`
- `totalTokens`
- `from`
- `toExclusive`
- `returnedTokens`

`contentHash`、`path`、`stats`、`runs`、`compressed/original` ラベルは返さない。呼び出し元は自分が指定した読み取り条件を知っているため、余計なメタデータは増やさない。

## 読み取りモード

### 圧縮読み取り（`minify=true`）

1. ファイルを UTF-8 で読む。
2. `.md` / `.markdown` / `.mdx` / `.txt` はそのまま Markdown として扱う。
3. HTML らしい入力や `.html` / `.htm` は `markdownify` で Markdown 化する。
4. frontmatter は既定で除去する。
5. Markdown 装飾を Bun markdown renderer の callback で除去する。
6. 改行をスペースに置換し、連続空白を 1 つに圧縮する。
7. `fromToken/readTokens` で window を切る。

### 原文読み取り（`minify=false`）

1. Markdown 化と frontmatter 処理までは同じ。
2. Markdown 装飾、改行、空白幅は保持する。
3. token window だけ適用する。

HTML 解説やコードブロックの形が重要な場合は、原文読み取りを使う。

## CLI 確認

`bun run read-file:smoke` は `wiki/pages/best-practice/hono_backend.md` を読む。

出力は pretty JSON を 2 個、順番に標準出力へ出す。

1. 圧縮読み取り
2. 原文読み取り

## 関連ドメイン

`memoryReader` は vibe memory を distillation reader に渡す前処理で使う。公開オプションは `compressed` と `original` の 2 つだけにする。

- `compressed`: memory 本文は Markdown 装飾除去、同一フレーズ削除、空白圧縮を行う。diff は Markdown 装飾除去せず、同一行削除と空白圧縮だけ行う。
- `original`: 入力文字列をそのまま返す。

`bun run memory-reader:smoke` は比較的長い session を選び、圧縮読み取りと原文読み取りの 2 個の pretty JSON を出す。
