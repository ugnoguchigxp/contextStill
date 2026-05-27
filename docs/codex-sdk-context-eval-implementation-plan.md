# Codex SDK Context Eval 実装計画

## 目的

ChatGPT/Codex OAuth 認証済み環境を、`memoryRouter` の context 評価に使えるようにする。

最初の到達点は `context_compile` 本線への provider 追加ではなく、`eval:context` の LLM judge として Codex SDK を使うことである。これにより、OpenAI API key 課金とは別に、Codex の ChatGPT 認証経路で評価を実行できるかを低リスクに検証する。

## 根拠

### OpenAI 公式仕様

Codex は次の2つの認証方式を持つ。

- ChatGPT サインイン: subscription access
- API key サインイン: usage-based access

通常の OpenAI API call は Platform API key を使う前提で、ChatGPT サインインは Codex 側の利用経路である。

参照:

- https://developers.openai.com/codex/auth
- https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- https://www.npmjs.com/package/@openai/codex-sdk

### Codex SDK の性質

`@openai/codex-sdk` は Responses API client ではない。`@openai/codex` CLI を子プロセスとして起動し、JSONL event で通信する wrapper である。

確認済み仕様:

- `new Codex({ apiKey })` は子プロセスに `CODEX_API_KEY` を渡す。
- `apiKey` を渡さない場合、Codex CLI の通常認証状態を使う。
- thread は `~/.codex/sessions` に保存される。
- `outputSchema` で structured output を要求できる。
- `sandboxMode`, `approvalPolicy`, `workingDirectory`, `networkAccessEnabled`, `webSearchMode` を指定できる。

### OpenClaw の実装から得られる確証

OpenClaw は `openai-codex` provider を通常 OpenAI provider とは別に持ち、Codex OAuth / device-code / API key backup を分離している。

確認対象 commit:

`322ceb36ce4cd4fd33dea8cf5e10eae47052b5e5`

主要実装:

- `extensions/openai/base-url.ts`
  - `https://chatgpt.com/backend-api/codex` を Codex backend として扱う。
- `extensions/openai/openai-codex-provider.ts`
  - `openai-codex` provider に OAuth / device-code / API key backup を定義する。
- `extensions/openai/openai-codex-device-code.ts`
  - `https://auth.openai.com/api/accounts/deviceauth/...` の device-code flow を実装する。
- `src/agents/cli-credentials.ts`
  - macOS keychain の `Codex Auth` から Codex OAuth token を読む。
- `src/agents/openai-transport-stream.ts`
  - `openai-codex-responses` transport を通常 Responses API と別扱いし、unsupported params を削る。

この計画では、OpenClaw の「別 provider として扱う」設計を踏襲する。ただし最初は OAuth/device-code を memoryRouter に再実装せず、公式 Codex SDK/CLI 認証状態を使う。

## 非目標

- `openai` SDK で ChatGPT Pro を汎用 API key のように使う実装はしない。
- `context_compile` の通常 agentic refine をいきなり Codex SDK に置き換えない。
- OpenClaw の `chatgpt.com/backend-api/codex` direct transport は Phase 1 では実装しない。
- Codex に workspace write 権限や shell 実行権限を与える設計にはしない。

## 実装方針

Phase 1 では `eval:context` に `--judge codex-sdk` を追加する。

設計原則:

- Codex SDK は judge として扱い、通常 LLM provider とは分ける。
- Codex 実行は read-only、approval never、network disabled を既定にする。
- 評価対象 payload は必要最小限にする。
- 出力は JSON schema で固定し、parse failure は評価失敗として記録する。
- Codex が未ログイン、quota exceeded、rate limited の場合は明確な error code を返す。

## Phase 1: Codex SDK smoke

### 追加依存

`package.json` dependencies に追加する。

```json
"@openai/codex-sdk": "^0.134.0"
```

依存追加後:

```bash
bun install
```

### 追加ファイル

`src/modules/codex/codex-sdk-smoke.service.ts`

役割:

- Codex SDK が import できることを確認する。
- API key を渡さずに、既存 Codex login 状態で1 turn 実行できることを確認する。
- read-only / no approval / no network で実行する。

想定コード構造:

```ts
import { Codex } from "@openai/codex-sdk";

export type CodexSdkSmokeResult =
  | {
      ok: true;
      finalResponse: string;
      usage: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      } | null;
    }
  | {
      ok: false;
      code:
        | "CODEX_SDK_IMPORT_FAILED"
        | "CODEX_NOT_AUTHENTICATED"
        | "CODEX_USAGE_LIMIT"
        | "CODEX_TIMEOUT"
        | "CODEX_RUN_FAILED";
      message: string;
    };

export async function runCodexSdkSmoke(input?: {
  workingDirectory?: string;
  timeoutMs?: number;
}): Promise<CodexSdkSmokeResult> {
  // implementation
}
```

実行条件:

- `workingDirectory`: 既定は `process.cwd()`
- `sandboxMode`: `"read-only"`
- `approvalPolicy`: `"never"`
- `networkAccessEnabled`: `false`
- `webSearchMode`: `"disabled"`
- `skipGitRepoCheck`: `false`
- `modelReasoningEffort`: `"minimal"`

timeout:

- `AbortController` で 60 秒既定。
- timeout 時は `CODEX_TIMEOUT`。

エラー分類:

- `not logged in`, `login`, `auth`, `401`, `unauthorized` を含む場合: `CODEX_NOT_AUTHENTICATED`
- `usage limit`, `rate limit`, `quota`, `429` を含む場合: `CODEX_USAGE_LIMIT`
- それ以外: `CODEX_RUN_FAILED`

### CLI 追加

`src/cli/eval-context.ts` に以下のオプションを追加する。

- `--judge none|codex-sdk`
- `--codex-smoke`
- `--codex-timeout-ms <ms>`

Phase 1 では `--codex-smoke` のみ実行できればよい。

例:

```bash
bun run eval:context --codex-smoke --judge codex-sdk
```

期待出力:

```text
Codex SDK smoke: ok
usage: input=... cached=... output=... reasoning=...
```

失敗時:

```text
Codex SDK smoke: failed CODEX_NOT_AUTHENTICATED
message: ...
```

### Phase 1 検証

```bash
bun run typecheck
bun run eval:context --codex-smoke --judge codex-sdk
```

DB 依存を避けるため、smoke は replay report を読まずに早期 return する。

成功条件:

- `OPENAI_API_KEY` なしでも、Codex login 済み環境で smoke が成功する。
- 未ログイン環境では `CODEX_NOT_AUTHENTICATED` として失敗する。
- `typecheck` が通る。

## Phase 2: context eval judge 抽象

### 追加ファイル

`src/modules/landscape/context-eval-judge.types.ts`

```ts
import type { ContextEvalReport } from "./context-eval.service.js";

export type ContextEvalJudgeName = "none" | "codex-sdk";

export type ContextEvalJudgeInput = {
  report: ContextEvalReport;
  riskyRunLimit: number;
};

export type ContextEvalJudgeVerdict = {
  verdict: "pass" | "review" | "fail";
  confidence: number;
  summary: string;
  findings: Array<{
    severity: "low" | "medium" | "high";
    runId?: string;
    issue: string;
    recommendation: string;
  }>;
};

export type ContextEvalJudgeResult =
  | {
      ok: true;
      judge: ContextEvalJudgeName;
      verdict: ContextEvalJudgeVerdict;
      usage?: {
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
      } | null;
    }
  | {
      ok: false;
      judge: ContextEvalJudgeName;
      code:
        | "JUDGE_DISABLED"
        | "JUDGE_NOT_AUTHENTICATED"
        | "JUDGE_USAGE_LIMIT"
        | "JUDGE_TIMEOUT"
        | "JUDGE_PARSE_FAILED"
        | "JUDGE_RUN_FAILED";
      message: string;
    };
```

`src/modules/landscape/context-eval-judge.service.ts`

役割:

- `judge === "none"` の場合は実行しない。
- `judge === "codex-sdk"` の場合は Codex SDK judge を呼ぶ。

### report 拡張

`ContextEvalReport` に任意フィールドを追加する。

```ts
judge?: ContextEvalJudgeResult;
```

既存の report 生成は read-only のまま維持する。judge は report 生成後に付加する。

## Phase 3: Codex SDK judge 実装

### 追加ファイル

`src/modules/landscape/context-eval-codex-judge.service.ts`

役割:

- `ContextEvalReport` の要約と risky runs だけを Codex に渡す。
- JSON schema で `ContextEvalJudgeVerdict` を要求する。
- parse failure を `JUDGE_PARSE_FAILED` にする。

入力 payload は大きくしすぎない。

```ts
function buildCodexJudgePrompt(input: ContextEvalJudgeInput): string {
  return [
    "あなたは memoryRouter の context_compile 評価レビュアです。",
    "次の replay-based context eval report を見て、ranking変更や knowledge整理を進めてよいか判定してください。",
    "",
    "判定基準:",
    "- retentionScore が低い場合は fail または review",
    "- stabilityScore が低い場合は review",
    "- noCurrentMatchRuns が多い場合は reachability 問題として扱う",
    "- usedBaselineLost がある場合は対象 run を findings に含める",
    "- 出力は schema に従う JSON のみ",
    "",
    JSON.stringify(compactReport(input.report, input.riskyRunLimit), null, 2),
  ].join("\n");
}
```

`compactReport` に含めるもの:

- `summary`
- `metrics`
- `scores`
- `recommendedNextAction`
- `riskyRuns`
- `usedBaselineLost`
- `highChurnRuns`
- `noCurrentMatchRuns`

含めないもの:

- `replayComparison` の詳細 dump
- full knowledge content
- source body
- secrets / env

Codex SDK 呼び出し:

```ts
const codex = new Codex();
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  sandboxMode: "read-only",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
  modelReasoningEffort: "minimal",
});

const turn = await thread.run(prompt, {
  outputSchema: contextEvalJudgeSchemaJson,
  signal: abortController.signal,
});
```

schema は `zod-to-json-schema` を追加せず、Phase 3 では手書き JSON schema にする。依存増加を最小にするため。

### CLI 拡張

`src/cli/eval-context.ts`

追加 options:

- `--judge none|codex-sdk`
- `--judge-risky-run-limit <n>` 既定 10、最大 30
- `--judge-timeout-ms <ms>` 既定 90000、最大 300000

出力:

通常表示では summary の後に judge を表示する。

```text
Judge: codex-sdk review confidence=0.82
- [high] run=... used baseline lost ...
- [medium] run=... no current match ...
```

`--json` では `report.judge` に含める。

### Phase 3 検証

```bash
bun run typecheck
bun run eval:context --from-replay --limit 20 --current-limit 12 --judge codex-sdk
bun run eval:context --from-replay --limit 20 --current-limit 12 --judge codex-sdk --json
```

成功条件:

- `--judge none` の既存挙動が変わらない。
- `--judge codex-sdk` で judge が追加される。
- parse failure が process crash ではなく `report.judge.ok=false` になる。
- Codex 未ログイン時に replay report 自体は出せる。

## Phase 4: DB 永続化

Phase 3 で有用性が確認できた後に実装する。

### schema 追加案

新規テーブル:

`context_eval_judge_runs`

列:

- `id uuid primary key`
- `created_at timestamp`
- `judge text`
- `source_mode text`
- `window_days integer`
- `limit integer`
- `current_limit integer`
- `run_status text`
- `status text`
- `verdict text`
- `confidence real`
- `summary text`
- `findings jsonb`
- `usage jsonb`
- `error_code text`
- `error_message text`
- `report_snapshot jsonb`

drizzle:

- `src/db/schema-landscape.ts` に追加する。
- migration を生成する。

CLI option:

- `--persist-judge`

既定は永続化しない。最初は検証用途として明示 opt-in にする。

## Phase 5: context_compile 本線への限定導入

Phase 1-4 が安定してから検討する。

候補:

- `agenticCompile.provider = "codex-sdk"` を追加する。
- ただしデフォルトにはしない。
- `context_compile` の agentic refine では候補選別のみを行わせる。
- `sandboxMode: "read-only"`, `approvalPolicy: "never"` は固定する。

懸念:

- Codex SDK は agent runtime なので通常 LLM provider より遅い。
- thread/session が増える。
- shell/tool 実行 item が生成される可能性がある。
- `context_compile` のインタラクティブ応答時間が悪化する。

このため、本線導入は `eval:context` で効果と安定性を確認してからにする。

## Phase 6: OpenClaw direct transport 踏襲

必要になった場合のみ実装する。

実装対象:

- `openai-codex` provider
- OAuth browser login
- device-code login
- token refresh
- `chatgpt.com/backend-api/codex` Responses-compatible transport
- unsupported params sanitizer
- usage snapshot

参考にする OpenClaw ロジック:

- `extensions/openai/base-url.ts`
- `extensions/openai/openai-codex-provider.ts`
- `extensions/openai/openai-codex-device-code.ts`
- `extensions/openai/openai-codex-oauth.runtime.ts`
- `extensions/openai/openai-codex-provider.runtime.ts`
- `src/agents/openai-transport-stream.ts`
- `src/agents/cli-credentials.ts`

実装しない理由:

- Codex SDK/CLI 経由より保守コストが高い。
- public OpenAI API surface ではなく、ChatGPT backend 互換に依存する。
- token 保管、refresh、device code UX、地域・proxy・TLS エラー処理まで責務が広がる。

採用条件:

- Codex SDK が必要な structured judge 用途を満たせない。
- Codex SDK の起動 overhead が許容できない。
- OpenClaw 方式と同等の token 管理を memoryRouter に持つ必要が明確になった。

## セキュリティ境界

Codex SDK judge では以下を固定する。

- `sandboxMode: "read-only"`
- `approvalPolicy: "never"`
- `networkAccessEnabled: false`
- `webSearchMode: "disabled"`
- `workingDirectory: process.cwd()`
- `skipGitRepoCheck: false`

評価 prompt には以下を含めない。

- API keys
- env dump
- source full body
- file contents
- DB connection string

Codex response は JSON schema で検証し、raw response は既定で DB 永続化しない。

## 実装順チェックリスト

1. `@openai/codex-sdk` を依存に追加する。
2. `src/modules/codex/codex-sdk-smoke.service.ts` を追加する。
3. `src/cli/eval-context.ts` に `--codex-smoke`, `--judge`, `--codex-timeout-ms` を追加する。
4. `bun run typecheck` を通す。
5. Codex login 済み環境で smoke を実行する。
6. 未ログイン環境の error classification を確認する。
7. `context-eval-judge.types.ts` を追加する。
8. `context-eval-codex-judge.service.ts` を追加する。
9. `context-eval.service.ts` の report に `judge?` を追加する。
10. `eval-context.ts` で report 生成後に judge を呼ぶ。
11. `--json` 出力に judge を含める。
12. 通常出力に judge summary を追加する。
13. `bun run typecheck` と `bun run eval:context --from-replay --judge none` を確認する。
14. `bun run eval:context --from-replay --judge codex-sdk` を確認する。
15. 結果が有用なら Phase 4 の永続化へ進む。

## 受け入れ条件

Phase 1:

- `bun run eval:context --codex-smoke --judge codex-sdk` が Codex login 済み環境で成功する。
- `OPENAI_API_KEY` がなくても成功する。
- 未ログイン時は明確な error code で失敗する。

Phase 3:

- `--judge none` で既存 report が変わらない。
- `--judge codex-sdk` で `pass|review|fail` の verdict が得られる。
- `--json` で machine-readable な judge result が得られる。
- Codex judge 失敗時も replay report は出る。
- `bun run typecheck` が通る。

## 実装後に記録するべきメトリクス

- judge 実行時間
- Codex usage
- verdict 分布
- parse failure rate
- auth failure rate
- usage limit / rate limit 発生数
- risky run 数と findings 数

## 判断ゲート

Phase 3 完了後、次を満たすなら Phase 4 へ進む。

- judge 成功率が 80% 以上。
- parse failure が 5% 未満。
- 通常 eval report より意思決定に有用な findings が出る。
- 実行時間が手動 eval 用途で許容できる。

次を満たすなら `context_compile` 本線導入を検討する。

- judge 成功率が 95% 以上。
- p95 実行時間が context_compile の許容範囲に収まる。
- Codex の shell/tool 実行を実質的に抑止できている。
- quota/rate limit が運用上問題にならない。
