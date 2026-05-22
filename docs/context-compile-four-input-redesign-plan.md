# Context Compile Four Input Redesign Plan

> 作成日: 2026-05-21
> 対象: `context_compile` MCP tool、knowledge applicability、context pack rendering
> 目的: `goal` / `changeTypes` / `technologies` / `domains` の4入力から、LLMが実際のコーディング判断に使える最小コンテキストを生成する。

> 追補: `No Content`、`Context Quality` 削除、設計ドキュメント参照を `goal` に入れない方針、vector-only 候補の抑制は [Context Compile No Content and Goal Quality Plan](./context-compile-no-content-and-goal-quality-plan.md) を優先する。

---

## 1. コンセプト

`context_compile` はソースファイルを読むツールではない。役割は、作業前に渡されたタスク情報を手掛かりに、既存 knowledge から「今回のコーディングに効くルール・手順」だけを選び、LLMのプロンプトに載せられる量へ圧縮することである。

今後の入力は次の4つだけにする。

| Field | 役割 | 例 |
|---|---|---|
| `goal` | 達成したい状態。最重要の自然文入力 | `context_compile の入力を4軸に整理し、LLM向けコンテキストを短く有用にする` |
| `changeTypes` | 作業種別・判断モード | `plan`, `docs`, `review`, `debug`, `ui`, `refactor`, `prompt-context` |
| `technologies` | 技術スタック・ランタイム・ライブラリ | `typescript`, `mcp`, `zod`, `react`, `drizzle`, `bun` |
| `domains` | プロジェクト内の機能領域 | `context-compiler`, `knowledge`, `mcp-tools`, `doctor`, `admin-ui`, `distillation` |

この4つの責務は重ならない。

- `goal`: 何を達成するか
- `changeTypes`: どんな種類の作業か
- `technologies`: どの技術のノウハウが必要か
- `domains`: どの機能領域のノウハウが必要か

`files`、`repoPath`、`lastErrorContext`、`intent`、`tokenBudget`、`includeDraft`、`queryEmbedding`、`acceptanceCriteria`、`constraints` は、`context_compile` の入力として作らない。現行コードに存在するものは、隠し入力として残すのではなく廃止対象として扱う。

重要なのは「入力を4つに減らすこと」自体ではなく、compiler がこの4つから **コーディング時に行動を変えられる knowledge** を選べることである。診断・監査・履歴保存のための情報は残してよいが、LLM prompt に渡す主出力へ混ぜない。

---

## 2. 現状の問題

### 2.1 `initial_instructions` が入力を増やしすぎている

`src/mcp/tools/system.tool.ts` は現在、`context_compile` に以下を渡すよう案内している。

- `goal`
- `intent`
- `technologies`
- `files`
- `changeTypes`
- `lastErrorContext`

このうち `files` は compiler が中身を読めないため、コンテキスト本文ではなく単なる文字列ヒントでしかない。別プロジェクトのパスを渡されても compiler は安全に読みに行けない。`lastErrorContext` も、エラー解析の本文としては大きくなりやすく、必要なら `goal` に短く含める方がプロンプト効率が良い。

### 2.2 `intent` と `changeTypes` が重複している

`intent` は `plan/edit/debug/review/finish` だが、これは `changeTypes` の一部として表現できる。

例:

- `intent: "review"` -> `changeTypes: ["review"]`
- `intent: "debug"` -> `changeTypes: ["debug"]`
- `intent: "plan"` -> `changeTypes: ["plan", "docs"]`

入力に両方あると、呼び出し側LLMが分類で迷う。

### 2.3 `domains` の下地はあるが利用されていない

`src/modules/knowledge/knowledge-tags.repository.ts` の `KnowledgeTagKind` には `domain` が存在する。一方で `src/modules/knowledge/applicability.service.ts` の正規化対象は `technologies` と `changeTypes` だけである。

また `drizzle/0028_remove_retrieval_domain_applicability.sql` では、過去の `domains`、`retrievalModes`、`files` applicability が削除されている。今回の `domains` 再導入は、過去の雑なファイルパス・検索モード適用条件へ戻すものではなく、制御された機能領域タグとして再設計する。

### 2.4 MCP出力がLLM向けではなく監査向けに寄っている

`src/mcp/tools/context-compile.tool.ts` は現在、JSON pack と Markdown の両方を返す。LLMのプロンプトとして見ると重複が大きい。

`src/modules/context-compiler/pack-renderer.ts` の Markdown は、rule/procedure の本文ではなくタイトル中心であり、逆に Source Refs、警告、診断情報は長く出る。これは「LLMが従ってコーディングする」目的には効率が悪い。

---

## 3. 目標仕様

### 3.1 MCP 入力

`context_compile` の入力は次の形にする。

```ts
{
  goal: string;
  changeTypes?: string[];
  technologies?: string[];
  domains?: string[];
}
```

入力例:

```ts
context_compile({
  goal: "context_compile を4入力からコーディングに役立つ最小コンテキストを生成する設計へ変更する。files や repoPath に依存せず、警告や source refs のプロンプト浪費を減らす。",
  changeTypes: ["feature", "refactor", "prompt-context"],
  technologies: ["typescript", "mcp", "zod"],
  domains: ["context-compiler", "knowledge", "mcp-tools"]
})
```

`goal` は必須。残り3つは精度を上げる任意入力とする。迷う場合は `goal` だけで呼べる状態を維持する。

### 3.2 作らない入力

| Field | 実装方針 | 理由 |
|---|---|---|
| `intent` | 入力・ContextPack 表示から廃止する | `changeTypes` と重複する |
| `files` | schema、CLI、`codeContext` 生成から廃止する | compiler はファイル本文を読まない |
| `repoPath` | schema と retry suggestion から廃止する | repo/global の扱いは呼び出し側入力ではなくサーバー側責務 |
| `lastErrorContext` / `errorKind` | schema、error keyword/file boost から廃止する | 必要なエラー要約は `goal` に短く含める |
| `tokenBudget` | 入力として作らない | 予算は compiler 側の設定値で制御する |
| `includeDraft` | 入力として作らない | compile は active knowledge のみを使う。draft は knowledge review tool で扱う |
| `queryEmbedding` | 入力として作らない | embedding は compiler 内部で生成する |
| `constraints` | 新設しない | `goal` と `changeTypes` に吸収できる |
| `acceptanceCriteria` | 新設しない | 呼び出し側の入力負担が大きい |

「入力から隠す」ではなく、`context_compile` の contract から廃止する。既存DB履歴の読み取り互換が必要な箇所だけ legacy として読むが、新しい compile run では生成・保存・表示しない。

### 3.3 Retrieval mode 導出

`intent` は作らない。`retrievalMode` は入力にせず、`changeTypes` から直接導出する。

| `changeTypes` | retrievalMode |
|---|---|
| contains `debug` | `debug_context` |
| contains `review` | `review_context` |
| contains `plan` or `docs` | `architecture_context` |
| contains `procedure` | `procedure_context` |
| otherwise | `task_context` |

### 3.4 Facet 正規化

`changeTypes`、`technologies`、`domains` は controlled tag として扱う。ただし compile input では、未知タグを即座に捨てると `goal` 以外の検索シグナルが消える。

方針:

- knowledge 登録時は、active tag definition に一致した facet だけを `appliesTo` に保存する。
- compile 検索時は、active tag definition に一致した facet を applicability matching に使う。
- compile 検索時の未知 facet は、確定した applicability 条件としては使わないが、`goal` と一緒に retrieval query text へは残す。
- 未知 facet は `diagnostics.inputFacets.unknown` に出し、Markdown prompt には原則出さない。

これにより、タグ辞書が未整備でも text/vector search の手掛かりは残り、controlled applicability の品質も守れる。

---

## 4. 実装範囲

### 4.1 Schema / MCP contract

対象:

- `src/shared/schemas/compile.schema.ts`
- `src/shared/schemas/context-pack.schema.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/cli/compile.ts`
- `src/db/schema.ts`
- `drizzle/*`
- `test/schemas.test.ts`
- `test/mcp.contract.test.ts`
- `test/cli.compile.e2e.test.ts`

実施内容:

1. `compileInputSchema` に `domains?: string[]` を追加する。
2. `contextCompileTool.inputSchema` を `goal/changeTypes/technologies/domains` だけに変更する。
3. `intent`、`repoPath`、`files`、`lastErrorContext`、`errorKind`、`tokenBudget`、`includeDraft`、`queryEmbedding` を `compileInputSchema` と MCP schema から削除する。
4. `deriveRetrievalModeFromChangeTypes()` を追加し、`intent` を中継せずに `retrievalMode` を決める。
5. `ContextPack` schema から `intent` と `codeContext` を削除する。
6. `context_compile_runs.intent` は廃止対象にする。migration で削除するか、段階移行が必要なら nullable/deprecated にして新規 run では書かない。
7. `context_compile_runs.input` の新規保存 payload は `goal/changeTypes/technologies/domains` だけにする。既存履歴の読み取り互換は repository / UI 側で吸収する。
8. CLI は `--goal`、`--change-types`、`--technologies`、`--domains`、`--json` だけを残す。削除対象 flag が渡された場合は明示的にエラーにする。

### 4.2 Initial Instructions

対象:

- `src/mcp/tools/system.tool.ts`
- `docs/mcp-tools.md`
- `test/mcp.contract.test.ts`

新しい案内内容:

```text
context_compile には goal を必ず渡す。
可能なら changeTypes / technologies / domains を渡す。

goal は達成したい状態を1-3文で書く。
changeTypes は作業種別、technologies は技術、domains は機能領域を表す。
渡す入力はこの4つだけ。追加フィールドは作らない。
```

`initial_instructions` は、長い汎用ルールではなく「良い compile 入力を作るための短い指示」に寄せる。

`tokenBudget`、`includeDraft`、`queryEmbedding` のような調整値は案内しない。compile の品質は入力者に予算調整を求めるのではなく、compiler 側の選別・圧縮・既定値で担保する。

### 4.3 Knowledge applicability に `domains` を追加

対象:

- `src/shared/schemas/knowledge.schema.ts`
- `src/modules/knowledge/applicability.service.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/modules/knowledge/knowledge.service.ts`
- `src/mcp/tools/knowledge.tool.ts`
- `src/knowledge/tagDefinitionSeeds.ts`
- `test/knowledge-applicability.test.ts`
- `test/knowledge.repository.test.ts`
- `test/knowledge.service.test.ts`

実施内容:

1. `KnowledgeApplicabilityInput` に `domains?: string[]` を追加する。
2. `knowledgeApplicabilitySchema` に `domains` を追加する。
3. `KnowledgeTagSeedKind` を `technology | change_type | domain` に広げる。
4. domain seed を追加する。
5. `drizzle/0028_remove_retrieval_domain_applicability.sql` で削除済みの domain tag definitions を再投入するため、新しい migration または seed 再実行手順を明記する。

初期 domain seed 案:

```ts
[
  "context-compiler",
  "knowledge",
  "mcp-tools",
  "doctor",
  "admin-ui",
  "distillation",
  "source-sync",
  "vibe-memory",
  "database",
  "testing"
]
```

6. `normalizeKnowledgeApplicability()` で `domains` を `KnowledgeTagKind: "domain"` として正規化する。
7. unknown domain は unknown tag candidate として扱う。
8. register/update/search の MCP/API schema でも `domains` を扱えるようにする。
9. `retrieval_mode` tag kind は今回復活させない。`domains` は機能領域のみを表す。
10. domain seed は正規化・UI補助・管理用の辞書であり、`initial_instructions` には候補一覧を表示しない。`initial_instructions` は `domains` の意味だけを短く説明し、具体的な候補列挙はしない。

### 4.4 Retrieval query と LLM selection

対象:

- `src/modules/context-compiler/query-context.ts`
- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/agentic-refine.service.ts`
- `src/modules/sources/source-retrieval.service.ts`
- `test/query-context.test.ts`
- `test/context-compiler.service.test.ts`

実施内容:

1. `buildRetrievalQueryText()` を `goal/changeTypes/technologies/domains` だけで構成する。
2. `fileHintsFromInput()` は context compile の主導線から外す。
3. `repoPath` を query text に混ぜない。
4. `retrieveKnowledge()` に `domains` を渡す。
5. `agentic-refine` の task summary から `files` を外し、`domains` を追加する。
6. source retrieval が `CompileInput` の legacy field に依存している箇所を、4入力ベースへ更新する。
7. Source Refs は prompt 本文ではなく監査・UI用に扱う。

facet は候補収集と LLM への判断材料に使う。`domain exact match +0.10` のような固定重みは追加しない。下手な重み付けで compiler の判断を歪めるより、候補を渡された LLM が「今回のコーディングに役立つか」を直接判断し、その選択を受け入れる。

deterministic logic の責務は次に限定する。

- active knowledge だけを候補にする。
- `goal/changeTypes/technologies/domains` から retrieval query text を作る。
- text/vector search と facet 条件から、LLM が選別できる候補集合を作る。
- LLM が返した knowledge IDs と順序を検証し、存在しないID・重複・deprecated を除外する。
- 出力長の上限を超える場合だけ、LLM が選んだ順序を保って後続項目を落とす。

`hasApplicabilityQuery()` は `domains` も見るようにする。ただしこれは候補集合を作るためであり、facet ごとの固定重みを追加するためではない。`appliesTo.general` の暗黙判定も、`domains` を facet data として扱い、domain 付き knowledge が general fallback と誤判定されないようにする。

### 4.5 Context Pack Rendering

対象:

- `src/modules/context-compiler/pack-renderer.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/shared/schemas/context-pack.schema.ts`
- `test/context-compiler.service.test.ts`
- `test/mcp.tools.test.ts`

実施内容:

1. MCP response は原則として LLM向け Markdown 1本にする。
2. full JSON pack は DB snapshot / admin UI / resource endpoint 用に保持する。
3. Markdown には rule/procedure の `title` だけでなく `content` を短く載せる。
4. Source Refs は通常 Markdown から外し、diagnostics / UI 用に残す。
5. `ファイル・ヒント` セクションは削除する。
6. `診断情報` はデフォルトで出さない。`Context Quality` セクションは追補計画に従い出さない。
7. 静的 warning を出さない。
8. `goal`、`changeTypes`、`technologies`、`domains`、`status` の再掲はしない。呼び出し側LLMが渡した入力を返すだけの情報は prompt の無駄になる。

MCP response の contract は次のように分ける。

| 用途 | 出力先 | 内容 |
|---|---|---|
| LLM prompt | `context_compile` MCP response | Markdown 1件 |
| Admin UI / history | DB snapshot / resource endpoint | full `ContextPack` JSON |
| Debug / audit | diagnostics / source refs | UI detail または resource 経由 |

これにより、LLMには必要な rule/procedure だけを渡しつつ、監査に必要な情報は失わない。

出力イメージ:

```md
## Rules

### 関連コンテキストは具体的に絞って渡す
AIに実装を任せる際は、全てのコードベースを渡すのではなく...

## Procedures

### AIコーディング計画書はMarkdownで記述し、再利用可能な構造を持つこと
...
```

### 4.6 Warning / Degraded の再設計

この節の LLM 向け warning 方針は追補計画で上書きする。新規実装では `Context Quality` を出さず、役立つ rule/procedure がない場合は `No Content` だけを返す。

対象:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/pack-renderer.ts`
- `test/context-compiler.service.test.ts`

方針:

- Warning は「LLMが今の作業で行動を変えられるもの」だけにする。
- 定型文は `initial_instructions` 側へ移す。
- `degraded` は「何が足りないか」だけでなく「まだ使える情報は何か」を返す。ただし入力不足のオウム返しはしない。
- `suggestedNextCalls` から `retry with explicit repoPath/files` を削除する。
- `domains` 未指定は degraded にしない。LLM向け Markdown にも「domains が未指定」という入力再掲は出さない。

例:

| 状態 | 表示 |
|---|---|
| no knowledge hit | `該当する knowledge はありません。通常の実装判断で進めてください。` |
| output compacted | `LLMが選んだ knowledge の一部は、出力上限のため省略されました。` |

ただしこの種の文も最大3件程度に抑える。

### 4.7 Compile history / Doctor UI への反映

対象:

- `web/src/modules/admin/components/context-compiler.page.tsx`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/modules/admin/repositories/admin.repository.ts`
- `test/components/admin/context-compiler-page.test.tsx`
- `test/components/admin/doctor-page.test.tsx`

実施内容:

1. Compile history の input 表示を `goal/changeTypes/technologies/domains` 中心にする。
2. 既存履歴にだけ残る legacy `intent/files/repoPath/lastErrorContext` は、履歴互換用の raw detail に閉じ込める。新規 compile run では保存しない。
3. Doctor の compile health では、degraded reason code ではなく「入力不足」「一致不足」「システム劣化」「予算不足」のように人間向け分類で表示する。
4. Source Refs は主表示から外し、詳細/監査用に残す。

---

## 5. 実装順序

### Step 1: 入力 contract の整理

- `domains` を compile schema と MCP schema に追加する。
- `initial_instructions` を4入力中心に書き換える。
- public docs `docs/mcp-tools.md` を更新する。
- `intent/files/repoPath/lastErrorContext/errorKind/tokenBudget/includeDraft/queryEmbedding` を compile input から削除する。
- CLI の削除対象 flags を廃止し、渡された場合は明示エラーにする。
- tests:
  - `test/schemas.test.ts`
  - `test/mcp.contract.test.ts`
  - `test/cli.compile.e2e.test.ts`

### Step 2: domains applicability の復活

- knowledge schema / service / repository に `domains` を追加する。
- domain tag seeds を追加する。
- 既存 migration で削除された domain tag definitions を再投入できることを確認する。
- search/register/update MCP tool でも `domains` を扱う。
- tests:
  - `test/knowledge-applicability.test.ts`
  - `test/knowledge.repository.test.ts`
  - `test/knowledge.service.test.ts`

### Step 3: retrieval / LLM selection を4入力へ寄せる

- query text から `files` / `repoPath` を外す。
- `domains` を query text、search options、agentic refine input に含める。
- facet ごとの固定重み付けは追加しない。
- LLM が選んだ knowledge IDs と順序を検証し、そのまま採用する。
- unknown facet は diagnostics に残し、query text からは落とさない。
- `lastErrorContext` 由来の error keyword/file boost を削除する。
- tests:
  - `test/query-context.test.ts`
  - `test/context-compiler.service.test.ts`

### Step 4: LLM向け Markdown 出力へ変える

- MCP response を原則 Markdown 1本にする。
- rule/procedure body を出す。
- Source Refs / diagnostics / static warnings を prompt から外す。
- `codeContext` / `ファイル・ヒント` を出さない。
- `intent` 表示を出さない。
- `goal` / facets / status の入力再掲を出さない。
- tests:
  - `test/mcp.tools.test.ts`
  - `test/context-compiler.service.test.ts`

### Step 5: Compile history / Doctor 表示を合わせる

- Compile run input 表示を4入力中心にする。
- Doctor degraded reason を人間向け分類にする。
- Source Refs を主表示から外す。
- tests:
  - `test/components/admin/context-compiler-page.test.tsx`
  - `test/components/admin/doctor-page.test.tsx`

### Step 6: DB / history cleanup

- `ContextPack` snapshot から `intent` と `codeContext` を消す。
- `context_compile_runs.intent` を削除または deprecated nullable 化し、新規 run では書かない。
- `context_compile_runs.input` は4入力だけを保存する。
- 既存履歴に残る legacy input は読み取り専用の raw detail として扱い、新規 run では再生成しない。
- `repoPath/files` retry suggestion を削除する。
- `token_budget` DB column は compiler 内部の実行メタとして残す場合でも、input としては保存・表示しない。

---

## 6. 検証計画

最低限実行する。

```bash
bunx vitest run test/schemas.test.ts test/mcp.contract.test.ts test/query-context.test.ts test/knowledge-applicability.test.ts test/context-compiler.service.test.ts test/mcp.tools.test.ts
bunx vitest run test/components/admin/context-compiler-page.test.tsx test/components/admin/doctor-page.test.tsx
bun run verify
```

手動確認する MCP 呼び出し例:

```ts
context_compile({
  goal: "context_compile のMCP出力を、LLMが実装判断に使える短いMarkdownへ変更する",
  changeTypes: ["refactor", "prompt-context", "test"],
  technologies: ["typescript", "mcp", "zod"],
  domains: ["context-compiler", "mcp-tools"]
})
```

確認観点:

- 入力に `files` / `repoPath` / `intent` がなくても有用な knowledge が選ばれる。
- `domains` が候補収集と LLM selection の判断材料として渡っている。
- 固定重み付けではなく、LLM が選んだ knowledge IDs と順序が採用される。
- unknown `domains` / `technologies` / `changeTypes` が diagnostics に出るが、query text から完全には消えない。
- Markdown に rule/procedure の本文が含まれる。
- Source Refs と診断 JSON が通常プロンプトを圧迫しない。
- `degraded` でも、LLMが次にどう振る舞うべきか短く分かる。
- `retry with explicit repoPath/files` が出ない。
- 削除対象 CLI flags が明示エラーになる。

---

## 7. 非目標

- compiler に任意ファイル読取能力を追加しない。
- エラーログ全文を compiler に渡す設計へ戻さない。
- domain をファイルパスやディレクトリ名の代替として乱用しない。
- Source Refs を削除しない。監査・UI用には保持し、LLM prompt から外す。
- 既存DB履歴の読み取り互換を破壊しない。
- `retrieval_mode` applicability を復活させない。

---

## 8. 完了条件

- `context_compile` の入力 contract が `goal/changeTypes/technologies/domains` の4入力で説明されている。
- `initial_instructions` が、良い compile input の作り方を短く説明している。
- `domains` が knowledge applicability、候補収集、LLM selection の判断材料に効いている。
- unknown facet の扱いが diagnostics と検索品質の両面で定義されている。
- MCP response が、JSON重複やSource Refsではなく、rule/procedure本文中心の短い Markdown になっている。
- compile history / doctor 表示で、LLMが受け取るコンテキスト量と degraded 理由が人間に分かる。
- 関連テストと `bun run verify` が通る。
