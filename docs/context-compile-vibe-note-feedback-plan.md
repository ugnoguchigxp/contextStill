# Context Compile Vibe Note Feedback Plan

> Status: planning draft
> Date: 2026-05-26
> Scope: `context_compile` result evaluation, free-form kind Vibe Note receipts, and session-scoped feedback reuse

## 目的

`context_compile` の結果を LLM が採点し、その採点を `kind=compile_eval` の Vibe Note として保存する。

保存された採点は、次回以降の `context_compile` で直接本文として混ぜるのではなく、session-scoped feedback signal として使う。LLM に `runId` を書かせず、`sessionId` からサーバー側で `context_compile_runs` と照合する。

## 判断

採用する方針:

- Vibe Note には `kind` を持たせる。`kind` は自由文字列でよい。
- ただし `context_compile` 後の採点だけは予約用途として `kind=compile_eval` を使う。
- `context_compile` の full result は Note に複製しない。既存の run snapshot / pack snapshot を source of truth にする。
- LLM が書く payload は `kind`, `title`, `body`, `score` を基本にする。
- `runId`, `sessionId`, `contextCompileRunId`, `createdBy`, `schemaVersion` はサーバー側で補完する。
- feedback loop は Vibe Note の本文ではなく、`kind=compile_eval` の metadata / event を読む。
- UI は「ユーザーが保存しまくるノート」導線にしない。note がなければ `保存されたノート無し` と表示する。

採用しない方針:

- `context_compile` 結果全文を `session_memo.body` に保存しない。ただし、LLM が後で使える評価を書く余地は十分に残す。
- `dimensions` のような詳細採点を MVP では要求しない。
- LLM に `runId` を入力させない。
- `context_compile` input schema に feedback fields を追加しない。

## ドキュメントレビュー

レビュー後の評価は **9.6 / 10** とする。

改善した点:

- `missing` / `noise` を削除し、LLM が意識する入力を `kind`, `title`, `body`, `score` に絞った。
- `verdict` を削除し、`score` と `body` の重複を避けた。
- `kind` は自由文字列にし、予約用途は `compile_eval` だけにした。
- `compile_eval.body` は hard limit 10k chars とし、LLM が実用的な評価を書ける余地を残した。
- `initial_instructions` には細かい schema や文字数を出さず、1 行だけで意図を伝える方針にした。

残る判断事項:

- `score` を必須にするか optional にするか。MVP では optional とし、存在する場合だけ context_compile 採点として扱う。
- `body` から summary / hints を抽出する方式を heuristic にするか LLM summarization にするか。MVP では heuristic excerpt から開始する。

## Note Kind

`kind` は用途識別用の短い文字列にする。ガチガチの enum にはしない。

予約済みとして扱うのは `compile_eval` だけでよい。

- `compile_eval`: `context_compile` 後の採点 receipt
- その他: 任意。未指定なら `scratch`

`label` は人間向け、`kind` は機械向けに分ける。`compile_eval` は feedback loop が読むため、`metadata.kind` だけではなく DB column にする。

## LLM Payload

`context_compile` の採点で LLM に書かせる payload は、厳密な schema として説明しない。`initial_instructions` では「`kind: "compile_eval"` と評価を保存する」程度に留める。

内部的な最小形:

```json
{
  "action": "put",
  "kind": "compile_eval",
  "title": "context_compile eval",
  "score": 74,
  "body": "Useful repo files surfaced, but Vibe Note UI parity was missing. Next inspect existing session summary logic."
}
```

制約:

- `title`: optional。未指定なら server が `compile_eval` から生成する。
- `body`: soft target は 1k-2k chars。hard limit は 10k chars。
- `score`: optional 0..100 integer。ただし `kind=compile_eval` の場合だけ `context_compile` 採点として扱う。

通常は `kind`, `title`, `body`, `score` だけでよい。`body` に役立った情報、不足、ノイズ、次回補正を自然文で書く。

10k は保存上限であり、毎回そこまで書くことを期待しない。LLM が活用しやすい note には、次の情報が自然文で入る余地が必要である。

- どの情報が実際に役立ったか
- 何が不足していたか
- 何がノイズだったか
- 次回の `context_compile` でどう補正すべきか

一方で、feedback loop が読むときは全文をそのまま context に入れない。利用時は server 側で 500-1000 chars 程度の summary / excerpt に圧縮する。

## Server-Enriched Metadata

サーバー保存時に補完する metadata:

```json
{
  "kind": "compile_eval",
  "sessionId": "...",
  "contextCompileRunId": "...",
  "contextCompileRunCreatedAt": "...",
  "score": 74,
  "title": "context_compile eval",
  "createdBy": "llm_self_eval",
  "schemaVersion": 1,
  "linkStatus": "linked"
}
```

`contextCompileRunId` は LLM 由来ではなく、`sessionId` からサーバーが解決する。

解決できない場合:

```json
{
  "linkStatus": "unresolved",
  "unresolvedReason": "no_recent_context_compile_run"
}
```

未解決でも note 保存は失敗させない。ただし feedback loop では `linked` を優先する。

## SessionId と Run 照合

現状の `context_compile_runs` には `session_id` がない。MVP では次を追加する。

```txt
context_compile_runs.session_id text null
index context_compile_runs_session_created_at_idx on (session_id, created_at desc)
```

`context_compile` tool handler は MCP request metadata から `sessionId` を解決し、`insertCompileRun` に渡す。

照合ルール:

1. `sessionId` がある `context_compile_runs` から最新 run を取得する。
2. note 作成時刻以前、かつ直近 30 分以内の run を優先する。
3. 該当 run が複数ある場合は `created_at desc` の先頭を使う。
4. 該当 run がない場合は `linkStatus=unresolved` として保存する。

LLM には `runId` を見せない。必要な場合でも UI / API / debug response のみで扱う。

## DB 変更計画

### `session_memos`

追加:

```txt
kind text not null default 'scratch'
```

index:

```sql
create index session_memos_session_kind_updated_at_idx
  on session_memos (session_id, kind, updated_at desc)
  where deleted_at is null;
```

check:

```sql
char_length(kind) <= 64
```

### `session_memo_events`

追加:

```txt
kind text not null default 'scratch'
```

index:

```sql
create index session_memo_events_session_kind_created_at_idx
  on session_memo_events (session_id, kind, created_at desc);
```

`compile_eval` の履歴は active note ではなく event から読む。active `session_memos` row は「最新の評価 receipt」として表示する。

### `context_compile_runs`

追加:

```txt
session_id text null
```

index:

```sql
create index context_compile_runs_session_created_at_idx
  on context_compile_runs (session_id, created_at desc)
  where session_id is not null;
```

## MCP/API 設計

既存 `session_memo` tool を拡張する。新 tool は増やさない。

追加 input:

```ts
{
  kind?: string;
  title?: string;
  body?: string;
  score?: number;
}
```

`kind=compile_eval` の場合:

- `body` は必須。採点理由や次回補正を書く。
- `title` がない場合、server が短い title を生成する。
- `score` は optional。ただし存在する場合は `context_compile` 採点として扱う。
- `metadata.contextCompileRunId` は server が付与する。
- `label` の既定は `compile_eval`。
- active row は label upsert で最新評価にする。
- event は毎回 append し、履歴を残す。

body 生成例:

```txt
context_compile eval: 74/100
Useful repo files surfaced, but Vibe Note UI parity was missing. Next inspect existing session summary logic.
```

## Feedback Loop

次回 `context_compile` で使う情報:

- 同一 `sessionId` の直近 `compile_eval` event
- `linkStatus=linked` のものを優先
- `score`, `body`

使い方:

- `body` から server 側で短い summary / hints を抽出する。
- `score < 50` の場合、compile response に warning を出す。
- `body` は丸ごと pack に混ぜない。保存上限は 10k まで許すが、利用時は 500-1000 chars 程度に圧縮して diagnostics / query hints に使う。

使わない情報:

- Vibe Note の full body
- 過去 session の eval
- `context_compile` full result copy

## initial_instructions 追記方針

長文にしない。日本語版・英語版とも 1 行にする。

追加候補は 1 行に抑える:

```txt
- `context_compile` 後の採点を残す場合は、`session_memo` に `kind: "compile_eval"` と評価を保存する。runId は書かない。
```

英語版:

```txt
- After `context_compile`, optionally save a `session_memo` with `kind: "compile_eval"` and an evaluation; do not write run IDs.
```

既存の `session_memo` 行はこの 1 行に置き換える。細かい schema や文字数上限は `initial_instructions` に出さない。

## Vibe Note UI 方針

右ペインは note 保存を主導線にしない。

- note がない場合: `保存されたノート無し`
- note がある場合: `kind`, `title`, `score`, `updatedAt`, preview を表示
- `kind=compile_eval` は score badge を表示
- 手動保存フォームは常時表示しない。必要なら secondary action に隠す
- session list は Vibe Memory と同じ見出し・時刻・project/source/count 表示に揃える

## Milestones

### Milestone 1: schema and repository

1. `session_memos.kind` / `session_memo_events.kind` を追加する。
2. `context_compile_runs.session_id` を追加する。
3. `kind` は自由文字列として schema に追加する。`compile_eval` だけ validation branch を持つ。
4. 最新 run 解決 repository を追加する。

### Milestone 2: session_memo typed eval

1. `session_memo` input に `kind`, `title`, `body`, `score` を追加する。
2. `kind=compile_eval` の validation を追加する。
3. server-side title generation を追加する。
4. server-side context compile run linking を追加する。
5. `compile_eval.body` の保存上限を 10k chars にする。
6. active row upsert + event append を同一 transaction にする。

### Milestone 3: context_compile session tracking

1. MCP request metadata から `sessionId` を取得する。
2. `insertCompileRun` に `sessionId` を渡す。
3. API / CLI 経由で sessionId がない場合は null のままにする。
4. 既存 run list/detail の contract を壊さない。

### Milestone 4: feedback consumption

1. `context_compile` の前処理で同一 session の直近 eval events を取得する。
2. `body` から短い summary / hints を抽出する。
3. 長い `body` は 500-1000 chars 程度の summary / excerpt に圧縮して扱う。
4. feedback が壊れていても `context_compile` は failed にしない。

### Milestone 5: UI and instructions

1. Vibe Note の右ペイン empty state を `保存されたノート無し` にする。
2. `compile_eval` を score badge 付きで表示する。
3. 手動保存フォームを secondary action に落とす。
4. `initial_instructions` に 1 行だけ追記する。

## Test Plan

Unit:

- `session_memo` schema accepts `kind=compile_eval` with `title/body/score`.
- `session_memo` schema rejects eval without `body`.
- server generates title when title is omitted.
- server accepts free-form `kind` strings up to 64 chars.

Repository:

- latest context compile run resolves by `sessionId`.
- unresolved link stores `linkStatus=unresolved`.
- active note is upserted while event history appends.

MCP:

- `session_memo` eval payload saves without explicit `runId`.
- metadata session id wins over explicit session id.
- `contextCompileRunId` is server-filled.

Context compiler:

- `context_compile` stores `sessionId` when metadata exists.
- previous eval feedback is loaded only for same session.
- feedback load failure does not fail compile.

UI:

- Vibe Note shows `保存されたノート無し` when no notes exist.
- Vibe Note session list matches Vibe Memory session title behavior.
- `compile_eval` note shows score badge.

## Acceptance Criteria

- LLM can save context compile evaluation with `kind=compile_eval`, `body`, and optional `score`.
- LLM never needs to provide `runId`.
- Server links the note to the latest context compile run by `sessionId`.
- Vibe Note does not duplicate full context compile output.
- Feedback loop can read recent `compile_eval` events without loading note bodies.
- `initial_instructions` explains this in 1 short line and does not show a rigid schema.
