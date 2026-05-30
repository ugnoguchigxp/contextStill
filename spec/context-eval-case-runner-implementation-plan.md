# Context Eval Case Runner 実装計画

更新日: 2026-05-30
Status: implementation plan

## 1. 結論

P1-1 は新しい `eval:replay` CLI や Admin UI として作らず、既存の `eval:context` に評価ケース JSONL を読む **read-only case runner** を追加する。

最初の到達点は、過去 run 全体の replay 比較ではなく、手で選んだ 10〜20 件の代表ケースに対して、現在の retrieval が期待 knowledge を拾えているか、混ぜてはいけない knowledge を拾っていないかを判定できることに置く。

実装方針:

1. `eval:context --from-replay` は現状維持する。
2. `eval:context --cases <jsonl>` を追加する。
3. case runner は `compileContextPack()` を呼ばず、既存 replay comparison と同じく `retrieveKnowledge()` ベースの dry-run にする。
4. DB migration、Admin UI、ranking 変更、CI gate は初回スコープから外す。
5. 出力は CLI summary と JSON report に限定する。

## 2. 背景

現状の `eval:context --from-replay` は、過去の `context_compile` run と現在の retrieval を比較し、retention / churn / repulsion / reachability / stability を出せる。

一方で、次のような「手で定義した期待値」による評価はまだない。

- この task では `knowledge A` が必ず候補に出てほしい。
- この task では `knowledge B` が出るとノイズである。
- ranking / appliesTo / duplicate suppression の変更後も、代表ケースで expected / forbidden の挙動が崩れていないことを見たい。

この gap を埋めるのが今回の P1-1 最小スライスである。

## 3. 非目標

初回では次をやらない。

- `eval:replay` という新CLIの追加
- Admin UI の Eval ページ
- 評価ケース DB テーブル
- `context_compile` production ranking の変更
- Landscape ranking の default on
- LLM judge / Codex SDK judge
- CI の必須 gate 化
- `compileContextPack()` の dry-run 化

`compileContextPack()` は通常 run と pack item を保存するため、初回の read-only 評価では使わない。

## 4. 評価対象の意味

初回 runner は「最終 context pack に選ばれたか」ではなく、**current retrieval window に入ったか**を評価する。

理由:

- 既存 replay comparison が `retrieveKnowledge()` による current retrieval dry-run を採用している。
- `retrieveKnowledge()` は compile run を保存しない。
- ranking や appliesTo の退行検知には、まず retrieval window の expected / forbidden 判定で十分な価値がある。

将来、最終 selected pack を評価したくなった場合は、別フェーズで `compileContextPack({ dryRun: true })` 相当の永続化抑止を設計する。

## 5. JSONL ケース形式

ファイル例:

```jsonl
{"id":"queue-repair-basic","goal":"Repair a stalled distillation queue and verify runtime health.","changeTypes":["debug","ops"],"technologies":["Bun","PostgreSQL"],"domains":["queue","distillation"],"expectedKnowledgeIds":["knowledge-queue-supervisor"],"forbiddenKnowledgeIds":["knowledge-ui-only-note"]}
{"id":"context-compile-duplicate-suppression","goal":"Check whether duplicate suppression prevents near-duplicate knowledge from being selected repeatedly.","changeTypes":["review"],"technologies":["TypeScript"],"domains":["context_compile"],"expectedKnowledgeIds":["knowledge-duplicate-suppression"],"forbiddenKnowledgeIds":[]}
```

Schema:

```ts
type ContextEvalCase = {
  id?: string;
  goal: string;
  changeTypes?: string[];
  technologies?: string[];
  domains?: string[];
  expectedKnowledgeIds?: string[];
  forbiddenKnowledgeIds?: string[];
  notes?: string;
};
```

Validation rules:

- `goal` は必須。
- `expectedKnowledgeIds` と `forbiddenKnowledgeIds` は省略時 `[]`。
- 同じ ID が expected と forbidden の両方にある場合は case validation error。
- JSONL の invalid line は line number 付きで報告する。
- 空行と `#` 始まりの comment line は無視してよい。

## 6. CLI インターフェース

追加する形式:

```bash
bun run eval:context -- --cases spec/context-eval-cases.example.jsonl
bun run eval:context -- --cases spec/context-eval-cases.example.jsonl --current-limit 12 --json
```

既存形式は維持する。

```bash
bun run eval:context -- --from-replay --limit 20 --current-limit 12 --json
```

Mode rules:

- `--from-replay` と `--cases` はどちらか一方だけ指定できる。
- どちらもない場合は現状どおり error。
- `--current-limit` は cases mode でも使う。
- 初回では `--write`, `--update-baseline`, `--ci` は追加しない。

## 7. Report 形式

JSON 出力の形:

```ts
type ContextEvalCaseReport = {
  generatedAt: string;
  source: {
    mode: "cases";
    path: string;
    currentLimit: number;
    readOnly: true;
  };
  summary: {
    status: "passed" | "failed" | "no_data";
    caseCount: number;
    passedCount: number;
    failedCount: number;
    passRate: number;
    reason: string;
  };
  metrics: {
    expectedTotalCount: number;
    expectedHitCount: number;
    missingExpectedCount: number;
    forbiddenTotalCount: number;
    forbiddenHitCount: number;
    retrievedTotalCount: number;
    expectedRecall: number | null;
    strictPrecision: number | null;
    strictF1: number | null;
    noContentCaseCount: number;
    degradedCaseCount: number;
  };
  cases: ContextEvalCaseResult[];
};
```

Case result:

```ts
type ContextEvalCaseResult = {
  id: string;
  goal: string;
  status: "passed" | "failed";
  retrievedKnowledgeIds: string[];
  expectedKnowledgeIds: string[];
  expectedHitIds: string[];
  missingExpectedIds: string[];
  forbiddenKnowledgeIds: string[];
  forbiddenHitIds: string[];
  degradedReasons: string[];
};
```

Metric semantics:

- `expectedRecall = expectedHitCount / expectedTotalCount`
- `strictPrecision = expectedHitCount / retrievedTotalCount`
- `strictF1` は expected ids を relevant set とみなした簡易 F1
- `passRate = passedCount / caseCount`
- case pass 条件は `missingExpectedIds.length === 0 && forbiddenHitIds.length === 0`

`strictPrecision` は expected ids が網羅的 relevant set でないと厳しすぎるため、README で過剰に宣伝しない。初回の主指標は `passRate`, `expectedRecall`, `forbiddenHitCount` とする。

## 8. 実装対象ファイル

新規:

- `src/shared/schemas/context-eval-case.schema.ts`
- `src/modules/landscape/context-eval-case.service.ts`
- `test/context-eval-case.service.test.ts`
- `spec/context-eval-cases.example.jsonl`

変更:

- `src/cli/eval-context.ts`
- `test/context-eval.service.test.ts` または CLI parse 用の新規 test

触らない:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/ranking.service.ts`
- `web/src/**`
- DB schema / drizzle migration

## 9. 実装手順

### Step 1: Schema と loader

- `contextEvalCaseSchema` と `contextEvalCaseReportSchema` を追加する。
- JSONL loader を service 側に置く。
- invalid JSON / invalid schema / expected-forbidden conflict を line number 付き error にする。

Verification:

```bash
bunx vitest run test/context-eval-case.service.test.ts
```

### Step 2: Case evaluator

- 各 case から `CompileInput` を作る。
- `deriveRetrievalModeFromChangeTypes()` で retrieval mode を決める。
- `retrieveKnowledge(input, { retrievalMode, limit: currentLimit, facetFilters })` を呼ぶ。
- `current.items.map((item) => item.id).slice(0, currentLimit)` を `retrievedKnowledgeIds` とする。
- expected / forbidden の hit/missing を計算する。
- aggregate metrics を作る。

Verification:

- `retrieveKnowledge` mock で expected hit / missing / forbidden hit / degraded reason を検証する。
- `compileContextPack` は mock も import もしない。

### Step 3: CLI 統合

- `CliOptions` に `casesPath?: string` を追加する。
- `--cases <path>` を parse する。
- `--from-replay` と `--cases` の同時指定を error にする。
- `--json` では case report をそのまま JSON 出力する。
- 非 JSON では summary と failed cases だけを短く出す。

非 JSON 出力例:

```txt
Context Eval (cases, cases=12, currentLimit=12)
Summary: failed passRate=0.83 expectedRecall=0.91 forbiddenHits=2 degraded=1

Failed cases:
- queue-repair-basic missing=[knowledge-queue-supervisor] forbidden=[]
- stale-bootstrap-rule missing=[] forbidden=[knowledge-old-bootstrap]
```

### Step 4: Example cases

- `spec/context-eval-cases.example.jsonl` を追加する。
- 実在 ID 依存で壊れやすいので、example は runnable fixture ではなく format reference と明記する。
- 実運用ケースは別途ローカルに作るか、後続で DB から候補生成する。

### Step 5: Verification

Focused:

```bash
bunx vitest run test/context-eval-case.service.test.ts test/context-eval.service.test.ts
bun run typecheck
```

Manual smoke:

```bash
bun run eval:context -- --cases spec/context-eval-cases.example.jsonl --json
```

example に実在しない ID が含まれる場合は failed report になってよい。CLI が validation / report generation まで到達することを確認する。

## 10. 受け入れ条件

- `bun run eval:context -- --cases <jsonl> --json` が JSON report を返す。
- report に case-level の `missingExpectedIds` と `forbiddenHitIds` が含まれる。
- aggregate に `passRate`, `expectedRecall`, `strictPrecision`, `strictF1`, `noContentCaseCount`, `degradedCaseCount` が含まれる。
- invalid JSONL は line number 付きで失敗する。
- expected / forbidden に同じ ID がある case は validation error になる。
- `--from-replay` の既存挙動が壊れない。
- case runner は `context_compile_runs` / `context_pack_items` に新しい row を書かない。
- DB migration がない。
- Admin UI 変更がない。
- ranking / compile mainline の変更がない。

## 11. リスクと対策

### Retrieval-only 評価が最終 pack 評価とずれる

初回は意図的に許容する。計画書と出力の `source.mode` を `cases` / current retrieval gate と明記し、最終 selected pack の品質保証とは言わない。

### expectedKnowledgeIds が網羅的ではない

`strictPrecision` は参考値に留める。主指標は `passRate`, `expectedRecall`, `forbiddenHitCount` とする。

### ケースが現行 DB に依存して壊れる

最初は 10〜20 件の手動 curated cases に限定する。後続で必要なら、過去 run の `used` / `wrong` / `off_topic` から candidate cases を生成する dry-run command を検討する。

### dynamicScore や usage signal で結果が揺れる

許容する。これは runtime state に対する gate であり、完全固定 fixture ではない。CI gate 化は、ケースと DB seed が安定してから別判断にする。

## 12. 後続候補

初回実装後に価値が確認できた場合だけ検討する。

- `--fail-on-forbidden`
- `--min-pass-rate 0.9`
- `--min-expected-recall 0.9`
- case report の markdown 出力
- 過去 run から case JSONL の候補を生成する `--suggest-cases-from-replay`
- Admin UI の Eval ページ
- selected pack を評価するための `compileContextPack` dry-run mode
- CI gate 化

## 13. 完了報告フォーマット

実装 PR / 完了報告では次を出す。

```txt
Implemented:
- eval:context --cases <jsonl>
- ContextEvalCase schema / service
- JSON report and text summary

Verified:
- bunx vitest run test/context-eval-case.service.test.ts test/context-eval.service.test.ts
- bun run typecheck
- bun run eval:context -- --cases spec/context-eval-cases.example.jsonl --json

Notes:
- read-only current retrieval gate only
- no Admin UI / no DB migration / no ranking change
```
