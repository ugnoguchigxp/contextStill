# compile_eval MCP Tool と Vibe Note 簡素化 実装計画

更新日: 2026-05-27

## 1. 結論

`context_compile` の評価責務は Vibe Note / `session_memo` から外し、専用 MCP tool `compile_eval` に移す。

Vibe Note は、コーディングエージェント向けの session-scoped scratchpad と、`context_compile` run への参照リンクを見直すための UI に縮小する。`compile_eval` という note kind と、Vibe Note / `session_memo` の top-level `score` フィールドは廃止する。

評価結果は `context_compile` の run に紐づく first-class data として保存し、Context Compiler の run summary / run detail から回収できるようにする。Vibe Note は評価保存の主導線にしない。

実装方針は次で固定する。

- 評価保存先は新テーブル `context_compile_evals`。
- MCP tool 名は `compile_eval`。
- `session_memo` は `compile_eval` note kind の新規保存を拒否する。
- 既存 `session_memos.kind = 'compile_eval'` は one-time backfill で `context_compile_evals` へ移行する。
- Vibe Note は legacy `compile_eval` メモを通常メモとして表示しない。移行後は `compile_result` と `scratch` のみを表示対象にする。

## 2. 背景

現行の Vibe Note / session memo は、次の責務を同じ primitive に載せている。

- `scratch`: 自由メモ
- `compile_result`: `context_compile` 出力への参照
- `compile_eval`: コーディングエージェントによる compile 結果の採点
- `score`: `compile_eval` 用の評価値

この構成は実装しやすい一方で、評価ループの責任境界が曖昧になる。

- `session_memo` は汎用メモなので、agent-facing な評価 API としては入力が広すぎる。
- `score` が Vibe Note の概念に見えると、評価が UI / memo 依存に見える。
- `compile_eval` note は context window 圧縮後の見直しには便利だが、評価結果の source of truth としては弱い。
- `context_compile` の品質改善に使いたい評価は、`context_compile_runs` を中心に回収できるべきである。

一方で、`context_compile` 完了時に run id だけを返し、作業終了後に agent がそれを覚えて評価する設計も弱い。コンテキスト圧縮や長時間作業で run id を失うためである。

そのため、Vibe Note は廃止せず、`compile_result` リンクを保持する session-local anchor として残す。評価そのものは `compile_eval` MCP tool に移す。

## 3. 目標仕様

### 3.1 Vibe Note

Vibe Note の役割は次に限定する。

- session-scoped scratchpad を閲覧する。
- `context_compile` 完了時に作成された `compile_result` リンクを閲覧する。
- コンテキスト圧縮後でも、同一 session の compile run と出力 snapshot を見直せるようにする。

Vibe Note は次を扱わない。

- `compile_eval` note kind
- top-level `score` field
- compile 評価の保存 UI
- compile 評価の source of truth

### 3.2 session_memo

`session_memo` は汎用メモ primitive に戻す。

残す kind:

- `scratch`
- `compile_result`

廃止する kind:

- `compile_eval`

削除する input / output field:

- `score`

`compile_result` は引き続き `context_compile_runs.pack_snapshot` への参照として扱い、compile output 本文を `session_memos.body` に複製しない。

### 3.3 compile_eval MCP tool

新しい MCP tool `compile_eval` を追加する。

役割:

- コーディングエージェントが、作業後に `context_compile` run の実用性を評価する。
- run id を明示しない場合でも、同一 session の未評価または最新の `compile_result` から評価対象を解決する。
- 評価結果を `context_compile` run に紐づくデータとして保存する。

入力案:

```json
{
  "runId": "<uuid optional>",
  "score": 0,
  "outcome": "useful",
  "body": "実作業でどの程度役に立ったか、何が足りなかったか。",
  "title": "任意の短い評価タイトル"
}
```

`runId` は optional にする。未指定時の解決順序は次の通り。

1. 同一 MCP session の未評価 `compile_result` のうち最新
2. 同一 MCP session の最新 `context_compile_runs`
3. 見つからなければ `RUN_ID_REQUIRED_OR_UNRESOLVED` を返す

`outcome` は固定 enum にする。

- `useful`
- `partial`
- `misleading`
- `unused`

`score` は `0..100` の整数にする。

`compile_eval` は保存専用 tool であり、評価点を自動生成しない。tool caller は作業後に、実作業での有用度を score / outcome / body として渡す。

### 3.4 評価保存先

評価は `session_memos` ではなく、`context_compile` run 側に保存する。

推奨は新テーブル `context_compile_evals`。

理由:

- 1 run に複数評価を残せる。
- `context_compile_runs` の履歴と JOIN しやすい。
- Vibe Note のメモ寿命や slot 上限に影響されない。
- 将来、評価を retrieval 改善や dashboard に使いやすい。

想定カラム:

```sql
id uuid primary key
run_id uuid not null references context_compile_runs(id) on delete cascade
session_id text
score integer not null check (score between 0 and 100)
outcome text not null check (outcome in ('useful','partial','misleading','unused'))
title text
body text not null
source text not null check (source in ('mcp','ui','system','import'))
metadata jsonb not null default '{}'::jsonb
created_at timestamp not null default now()
updated_at timestamp not null default now()
```

`context_compile_runs` に直接 `score` を持たせない。複数回評価、再評価、agent 差分を保持する余地を残す。

Drizzle では enum 値を `src/db/schema.constants.ts` に追加し、check constraint は既存の `toSqlList(...)` パターンに合わせる。

Index:

- `context_compile_evals_run_created_at_idx` on `(run_id, created_at desc)`
- `context_compile_evals_session_created_at_idx` on `(session_id, created_at desc)` where `session_id is not null`
- `context_compile_evals_outcome_created_at_idx` on `(outcome, created_at desc)`

`body` は 10,000 文字上限を設ける。`title` は 160 文字上限を設ける。これは既存 `session_memo` の title/body 制約と揃えるためである。

### 3.5 context_compile 側の回収

`context_compile` run summary / detail に評価情報を出す。

summary:

```ts
evalSummary: {
  count: number;
  latestScore: number | null;
  averageScore: number | null;
  latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
  latestEvaluatedAt: string | null;
}
```

detail:

```ts
evaluations: Array<{
  id: string;
  runId: string;
  sessionId: string | null;
  score: number;
  outcome: "useful" | "partial" | "misleading" | "unused";
  title: string | null;
  body: string;
  source: "mcp" | "ui" | "system" | "import";
  createdAt: string;
  updatedAt: string;
}>
```

Context Compiler UI は run detail に evaluation list と summary を表示する。Vibe Note 側は評価を表示しないか、必要な場合でも run detail へのリンクに留める。

`averageScore` は DB 側で `avg(score)` を計算し、小数第1位に丸める。`latestScore` / `latestOutcome` は `created_at desc, id desc` の最新評価から取る。

## 4. 評価対象 run の解決ロジック

`compile_eval` tool は `runId` を optional にするため、run id 喪失時の解決規則を実装で固定する。

### 4.1 sessionId 解決

MCP request metadata から、既存 tool と同じ順で session id を解決する。

1. `sessionId`
2. `threadId`
3. `conversationId`
4. `codexSessionId`

`runId` が未指定で session id も解決できない場合は `SESSION_ID_REQUIRED_FOR_RUN_RESOLUTION` を返す。

### 4.2 runId 明示時

`runId` が渡された場合:

1. `context_compile_runs.id = runId` を取得する。
2. 見つからなければ `CONTEXT_COMPILE_RUN_NOT_FOUND` を返す。
3. run に `session_id` があり、MCP metadata の session id と異なる場合は `RUN_SESSION_MISMATCH` を返す。
4. run の `session_id` が null の場合でも、明示 runId の評価は許可する。

### 4.3 runId 省略時

`runId` が未指定の場合:

1. `session_memos` から同一 session の active `compile_result` を新しい順に見る。
2. `metadata.contextCompileRunId` が存在し、まだ `context_compile_evals` に同一 `run_id + session_id` の評価がない run を選ぶ。
3. 未評価 `compile_result` がなければ、同一 session の最新 `context_compile_runs` を選ぶ。
4. それでも見つからなければ `RUN_ID_REQUIRED_OR_UNRESOLVED` を返す。

この解決は `compile_result` を source of truth にしない。`compile_result` は圧縮後に run を再発見するための anchor であり、最終的な存在確認は常に `context_compile_runs` で行う。

## 5. 実装フェーズ

### Phase 1: スキーマ追加

追加:

- `drizzle/0049_context_compile_evals.sql`
- `src/db/schema-context.ts` に `contextCompileEvals`
- `src/db/schema.constants.ts` に outcome enum 値

要件:

- `run_id` は `context_compile_runs.id` に cascade delete。
- `score` は `0..100`。
- `outcome` は enum check。
- `session_id + created_at` と `run_id + created_at` に index を作る。

既存 `session_memos.metadata.score` は JSON 内に残り得るが、新規コードからは参照しない。過去データ移行は Phase 5 で扱う。

### Phase 2: compile_eval MCP tool 追加

追加:

- `src/mcp/tools/compile-eval.tool.ts`
- `src/modules/context-compiler/context-compile-eval.repository.ts`
- `src/modules/context-compiler/context-compile-eval.service.ts`
- `src/shared/schemas/context-compile-eval.schema.ts`

MCP registry に `compile_eval` を追加する。v2 exposed tools に追加し、v1 互換 surface には追加しない。legacy alias は作らない。

処理:

1. MCP metadata から `sessionId` / `threadId` / `conversationId` / `codexSessionId` を解決する。
2. `runId` があれば、その run が存在することを確認する。
3. `runId` がなければ、同一 session の評価対象 run を解決する。
4. `score` / `outcome` / `body` を validation する。
5. `context_compile_evals` に保存する。
6. 保存結果と対象 run summary を返す。

返却案:

```json
{
  "evaluation": {
    "id": "<uuid>",
    "runId": "<uuid>",
    "score": 82,
    "outcome": "useful",
    "createdAt": "<ISO8601>"
  },
  "resolvedFrom": "latest_session_compile_result"
}
```

エラーは `throw new Error("<CODE>: <human readable message>")` の形に揃える。既存 MCP tool の error handling に合わせ、tool result の独自 `isError` response は追加しない。

### Phase 3: session_memo / Vibe Note から評価責務を削除

削除・変更:

- `sessionMemoToolInputSchema.score`
- `sessionMemoItemInputSchema.score`
- MCP `session_memo` inputSchema の `score`
- API `POST /api/session-memo/item` の `score`
- `putSessionMemo` / `putManySessionMemos` の `score`
- `session_memo` の `compile_eval` 自動リンク処理
- `compile_eval:<runId>:<ordinal>` label 生成処理
- Vibe Note UI の score 表示
- Vibe Note session list の `compile_eval` 前提
- `src/shared/locales/initial-instructions.ts` の `session_memo kind="compile_eval"` 指示

残す:

- `compile_result` 自動リンク
- `compile_result` の linked output 解決
- `scratch` メモ
- `session_memo` の `kind` 自体

`kind === "compile_eval"` の特別扱いは削除する。新規保存は禁止し、`session_memo` / API の validation で `compile_eval` kind を拒否する。既存行は backfill 対象として残すが、Vibe Note の通常表示対象には含めない。

### Phase 4: context_compile run API / UI に評価を統合

変更:

- `CompileRunSummary` に `evalSummary` を追加
- `CompileRunDetail` に `evaluations` を追加
- `listRecentCompileRuns` で run ごとの評価 summary を JOIN / aggregate
- `getCompileRunDetail` で evaluations を取得
- Context Compiler UI の run list / detail に評価 summary を表示

表示方針:

- run list: `latestScore` と `evalCount` を小さく表示
- run detail: score、outcome、body、createdAt を表示
- 未評価 run: `Not evaluated` と表示

Vibe Note から評価一覧へ誘導する場合は、`context_compile` run detail へのリンクだけにする。

### Phase 5: 既存 compile_eval メモの backfill

one-time migration script を用意する。

- `session_memos.kind = 'compile_eval'`
- `metadata.contextCompileRunId` が uuid
- `metadata.score` が 0..100
- `body` が非空

上記を満たす既存メモを `context_compile_evals` に backfill する。

backfill 後:

- 元の `session_memos` は削除しない。
- 移行記録を audit log に残す。
- Vibe Note では `compile_eval` legacy memo を非表示にする。

同一 `session_memo.id` から複数回 backfill されないように、`context_compile_evals.metadata.sourceSessionMemoId` を保存し、repository 側で既存 metadata を確認して skip する。

## 6. initial_instructions / docs 更新

`initial_instructions` から、`session_memo kind="compile_eval"` と `score` を使わせる指示を削除する。

新しい説明:

- `session_memo` は必要時の短期メモ。
- `context_compile` 結果の評価は `compile_eval` MCP tool を使う。
- 評価は作業後に行う。
- run id を覚えていなくても、同一 session の最新 compile result から解決できる。

`docs/mcp-tools.md` は MCP surface を更新する。

- `compile_eval` を追加
- `session_memo` の説明から compile 評価責務を削除
- 推奨フローの実装・検証後に `compile_eval` を追加

`docs/vibe-note-session-memo-design.md` は後続タスクで更新または置換する。今回の計画では、既存設計書を直接修正しない。

## 7. 影響ファイル候補

Backend / MCP:

- `src/mcp/tools/index.ts`
- `src/mcp/tools/compile-eval.tool.ts`
- `src/mcp/tools/session-memo.tool.ts`
- `src/shared/schemas/session-memo.schema.ts`
- `src/shared/schemas/context-compile-eval.schema.ts`
- `src/shared/locales/initial-instructions.ts`
- `src/modules/session-memo/session-memo.service.ts`
- `src/modules/context-compiler/context-compiler.repository.ts`
- `src/modules/context-compiler/context-compile-eval.repository.ts`
- `src/modules/context-compiler/context-compile-eval.service.ts`
- `src/db/schema-context.ts`
- `src/db/schema.constants.ts`
- `drizzle/0049_context_compile_evals.sql`
- `src/db/schema.ts`

API:

- `api/modules/session-memo/session-memo.routes.ts`
- `api/modules/context-compiler/context-compiler.repository.ts`
- `api/modules/context-compiler/context-compiler.service.ts`
- `api/modules/context-compiler/context-compiler.routes.ts`

Web:

- `web/src/modules/admin/components/vibe-note.page.tsx`
- `web/src/modules/context-compiler/components/context-compiler.page.tsx`
- `web/src/modules/context-compiler/components/context-compiler.run-sidebar.tsx`
- `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`
- `web/src/modules/admin/repositories/admin.repository.ts`

Tests:

- `test/mcp.tools.test.ts`
- `test/mcp.contract.test.ts`
- `test/mcp-schema-compat.test.ts`
- `test/api.routes.integration.test.ts`
- `test/context-compiler.repository.test.ts`
- `test/context-compiler.service.test.ts`
- `test/components/admin/vibe-note-page.test.tsx`
- `test/components/admin/context-compiler-page.test.tsx`
- `test/context-compile-eval.service.test.ts`

Docs:

- `docs/mcp-tools.md`
- `docs/vibe-note-session-memo-design.md`

## 8. 実装順序

実装は次の順で進める。

1. DB schema / migration / shared schema を追加する。
2. `compile_eval` service と repository を追加し、明示 `runId` 保存だけを通す。
3. session-based run resolution を追加する。
4. MCP tool と registry を追加する。
5. `context_compile` run summary / detail に eval summary / evaluations を追加する。
6. `session_memo` から `score` と `compile_eval` 新規保存導線を削除する。
7. Vibe Note から score 表示と `compile_eval` 前提を削除する。
8. `initial_instructions` と MCP docs を更新する。
9. 既存 `compile_eval` メモ backfill script を追加する。
10. targeted tests と `bun run verify` を通す。

`compile_result` 自動リンクを壊すと run id 喪失対策が崩れるため、Phase 6 / 7 の削除作業より先に `compile_eval` tool の run resolution test を通す。

## 9. 受け入れ条件

- `session_memo` MCP tool の input schema から `score` が消えている。
- API `POST /api/session-memo/item` から `score` が消えている。
- 新規 `session_memo kind="compile_eval"` は公式導線として保存されない。
- 新規 `session_memo kind="compile_eval"` は MCP / API validation で拒否される。
- Vibe Note UI は score を表示しない。
- `context_compile` 完了時の `compile_result` リンクは維持される。
- `compile_eval` MCP tool で score / outcome / body を保存できる。
- `runId` 未指定でも、同一 session の最新評価対象 run を解決できる。
- `context_compile` run detail から evaluations を取得できる。
- `context_compile` run summary から eval summary を取得できる。
- `initial_instructions` は `session_memo` に compile 評価を書かせない。
- `docs/mcp-tools.md` の公開 tool 数と tool contract が実装と一致している。

## 10. 検証計画

Targeted tests:

- `compile_eval` tool schema test
- `compile_eval` tool saves evaluation with explicit runId
- `compile_eval` tool resolves latest session compile_result when runId is omitted
- `compile_eval` tool fails clearly when no session run can be resolved
- `compile_eval` tool rejects mismatched session run
- `session_memo` rejects `score` in new input contract
- `session_memo` rejects new `kind = "compile_eval"`
- legacy `compile_eval` memos can be backfilled once without duplicate eval rows
- Vibe Note does not render score
- Context Compiler run detail renders evaluations
- Context Compiler run list renders eval summary

Repository checks:

```bash
bun test test/mcp.tools.test.ts
bun test test/mcp.contract.test.ts
bun test test/mcp-schema-compat.test.ts
bun test test/api.routes.integration.test.ts
bun test test/context-compiler.repository.test.ts
bun test test/context-compiler.service.test.ts
bun test test/context-compile-eval.service.test.ts
bun test test/components/admin/vibe-note-page.test.tsx
bun test test/components/admin/context-compiler-page.test.tsx
bun run verify
```

Operational smoke:

1. MCP `context_compile` を実行する。
2. Vibe Note に `compile_result` リンクが残ることを確認する。
3. context window に run id を保持しない状態で `compile_eval` を runId なしで実行する。
4. `context_compile` run detail に evaluation が表示されることを確認する。
5. Vibe Note が score / compile_eval note に依存していないことを確認する。

## 11. レビュー時の重点確認

- `context_compile_runs.pack_snapshot` が評価結果で書き換わっていないこと。
- `session_memo` から `score` を消しても `compile_result` の linked output 解決が壊れていないこと。
- `compile_eval` tool の run resolution が session 境界を越えないこと。
- runId 明示時の API が、存在しない run と session mismatch を区別していること。
- backfill が idempotent で、同じ legacy memo から重複 eval を作らないこと。
- MCP exposed tools と `docs/mcp-tools.md` の tool 数が一致していること。
- `initial_instructions` が agent に古い `session_memo kind="compile_eval"` を指示していないこと。

## 12. 実装時の注意点

- `compile_eval` tool は評価を自動生成しない。score は作業したコーディングエージェントが判断して渡す。
- `context_compile` 直後に即採点させない。評価は作業後に行う。
- run id 喪失対策は Vibe Note の `compile_result` anchor と session-based resolution で解く。
- `context_compile_runs.pack_snapshot` に評価結果を書き戻さない。snapshot は compile 実行時点の出力として保持する。
- 評価集計は read model として `context_compile_evals` から作る。
- Vibe Note の廃止判断は、この簡素化後に scratchpad / anchor として使われるかを見てから行う。
