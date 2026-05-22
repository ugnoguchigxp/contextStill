# Context Compile No Content and Goal Quality Plan

> 作成日: 2026-05-22
> 対象: `context_compile` MCP tool、`initial_instructions`、context pack rendering、knowledge retrieval quality
> 目的: 設計ドキュメント参照や低信頼な検索結果から誤った knowledge を返さず、役立つ文脈がない場合は `No Content` だけを返す。

この文書は [Context Compile Four Input Redesign Plan](./context-compile-four-input-redesign-plan.md) のうち、LLM向け出力、Warning / Context Quality、goal 品質、vector-only 候補選別の方針を上書きする。4入力 (`goal` / `changeTypes` / `technologies` / `domains`) の contract は維持する。

---

## 1. 背景

`context_compile` は 4 入力に整理されたが、`goal` に `docs/context-compile-four-input-redesign-plan.md` のような設計ドキュメント参照が含まれると、ファイル名に含まれる断片語が retrieval query に混ざる。

実際の問題は、compiler が設計書本文を読まないにもかかわらず、パス文字列を意味のあるタスク説明として扱ってしまうことにある。今回の例では `redesign` や `design` といった語から `design.md` 系 knowledge が選ばれ、実装対象のマイルストーンとは関係の薄いルールが返った。

また `Context Quality` セクションは、LLM が実装判断に使う主出力として価値が低い。診断情報は履歴や UI の diagnostics に残せばよく、MCP のプロンプト本文へ載せる必要はない。

---

## 2. 方針

### 2.1 `goal` は設計書参照ではなくマイルストーンにする

`goal` は「いま達成したい 1 つのマイルストーン」を自然文で書く。設計書、計画書、仕様書、要件書、ロードマップなどの文書パスや文書ファイル名を `goal` の主語・対象にしない。

禁止例:

```ts
context_compile({
  goal: "docs/context-compile-four-input-redesign-plan.md を実装する",
  changeTypes: ["refactor"],
  technologies: ["typescript"],
  domains: ["context-compiler"]
})
```

推奨例:

```ts
context_compile({
  goal: "context_compile のMCP出力から Context Quality を削除し、役立つknowledgeがない場合は No Content だけを返す",
  changeTypes: ["refactor", "prompt-context"],
  technologies: ["typescript", "mcp"],
  domains: ["context-compiler", "knowledge"]
})
```

`tsconfig.json の compilerOptions を整理する` や `package.json の scripts を更新する` のように、実装対象ファイル自体がタスク内容を具体化している場合まで一律禁止しない。禁止対象は、compiler が本文を読まないと意味が分からない設計ドキュメント参照である。

### 2.2 設計ドキュメントは呼び出し側で読む

1000 行を超える設計ドキュメントは、`context_compile` に読ませる対象ではない。呼び出し側のコーディングエージェントが利用可能なファイル読取手段で必要部分を読み、現在実行する 1 マイルストーンを短い `goal` に変換してから `context_compile` を呼ぶ。

`context_compile` は「設計書全体に合う一般ルール」を返すのではなく、「このマイルストーンを実装する LLM が行動を変えられる knowledge」を返す。

### 2.3 役立つ文脈がない場合は `No Content`

compile が失敗した場合、または信頼できる rule/procedure が選べない場合、MCP の markdown 出力は厳密に次だけにする。

```text
No Content
```

余計な説明、警告、retry suggestion、入力の再掲は出さない。診断理由は `pack.diagnostics.degradedReasons` や run history に保存してよいが、LLM 向け本文には混ぜない。

### 2.4 `Context Quality` は削除する

`Context Quality` は主出力から削除する。UI にも `Context Quality` セクションとして表示しない。必要な運用情報は `Degraded Reasons` / diagnostics / Doctor 側で扱う。

---

## 3. 目標仕様

### 3.1 Initial Instructions

`src/mcp/tools/system.tool.ts` の `initial_instructions` に、次の方針を短く追加する。

```text
goal は設計書パスやファイル名ではなく、いま実行する1つのマイルストーンを自然文で書く。
設計ドキュメントを使う場合は、呼び出し側で必要部分を読んで要約し、現在のマイルストーンだけを goal にする。
context_compile は任意ファイル本文を読まないため、設計書パスを goal に入れない。
```

domain seed 一覧や長い例示は出さない。`initial_instructions` は短く保つ。

### 3.2 Goal validation

`compileInputSchema` は 4 入力のまま維持する。ただし `goal` を parse した後、compiler 内部で設計ドキュメント参照を検出する。

検出対象:

| Pattern | 例 |
|---|---|
| docs 配下の markdown 設計書 | `docs/context-compile-four-input-redesign-plan.md` |
| design/spec/requirements/roadmap/proposal/architecture 系 markdown | `design.md`, `api-spec.md`, `requirements.md`, `architecture-plan.md` |
| 設計書らしい file URI / absolute path | `file:///Users/example/project/docs/plan.md`, `/Users/example/project/docs/design.md` |
| 設計書参照が実装対象として書かれている文 | `docs/foo-plan.md を実装する`, `design.md に沿って対応する` |

非対象:

| Pattern | 例 |
|---|---|
| 実装対象ファイル名が具体的な作業内容になっている文 | `tsconfig.json の compilerOptions を整理する` |
| 設定・コードファイルの更新タスク | `package.json の scripts を更新する`, `src/foo.ts の型エラーを直す` |
| README 更新そのものが目的の docs 作業 | `README のセットアップ手順を現行コマンドに合わせる` |

検出した場合:

- knowledge/source retrieval を実行しない。
- `status` は `degraded` とする。
- `degradedReasons` に `GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE` を保存する。
- markdown は `No Content` のみ返す。
- run history には入力と診断を残す。

### 3.3 No Content 判定

以下の場合、markdown は `No Content` のみ返す。

1. `goal` に設計ドキュメント参照が含まれる。
2. retrieval または agentic refine がハード失敗し、信頼できる selected item がない。
3. selected rule/procedure が 0 件。
4. 候補が低信頼 vector-only だけで構成される。
5. agentic refine が空配列を返した。

`No Content` は失敗ではなく、誤った文脈を渡さないための正常な抑制結果として扱う。ただし diagnostics には理由を残す。

### 3.4 Candidate evidence guard

vector search の top-K をそのまま採用しない。候補ごとに内部メタデータを持ち、LLM に渡す前に低信頼候補を落とす。

内部メタデータ:

```ts
type KnowledgeCandidateEvidence = {
  textMatched: boolean;
  vectorMatched: boolean;
  vectorScore?: number;
  facetMatched: boolean;
};
```

このメタデータは `ContextPack` や MCP response に出さない。DB snapshot / diagnostics にも原則出さず、必要な場合だけテスト・デバッグ用に限定する。

採用前フィルタ:

- `vectorMatched === true` かつ `vectorScore` が低すぎる候補は、agentic refine に渡さない。
- `textMatched === false` かつ `facetMatched === false` かつ vector score が下限未満の候補は落とす。
- vector score の下限は候補足切りだけに使う。順位付けや最終採用理由にはしない。
- text / facet のどちらかが明確に一致している候補は、LLM が選別できる候補として残せる。

これにより、LLM 判断を優先しつつ、そもそも低品質な vector-only 候補を System Context に載せない。

### 3.5 Agentic refine

`agenticRefine` は複雑化しない。

方針:

- 既存の最小出力 (`selectedIds`) を維持する。
- per-candidate reason、reject reason、詳細JSON schema は追加しない。
- `selectedIds: []` は成功扱いにする。
- empty selection の場合、候補スコア順 fallback をしない。
- system prompt には「低信頼な vector-only 候補は候補集合に含めない。渡された候補でも goal に直接効かなければ空配列を返す」と短く書く。

---

## 4. 実装範囲

### 4.1 Core

対象:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/pack-renderer.ts`
- `src/modules/context-compiler/agentic-refine.service.ts`
- `src/modules/context-compiler/query-context.ts`
- `src/shared/schemas/context-pack.schema.ts`

実施内容:

1. `goal` の設計ドキュメント参照検出関数を追加する。
2. compile 開始直後に goal validation を行う。
3. invalid goal の場合は retrieval を実行せず、`No Content` pack を作る。
4. `buildHumanWarnings()` を削除または使用停止し、`pack.warnings` を新規 run では空配列にする。
5. `renderContextPackMarkdown()` は rule/procedure が空なら `No Content` を返す。
6. `Context Quality` の markdown rendering を削除する。
7. selected item が 0 件の場合、fallback source ref を markdown に出さない。

### 4.2 Retrieval / ranking

対象:

- `src/modules/knowledge/knowledge.service.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/modules/context-compiler/ranking.service.ts`
- `src/modules/sources/source-retrieval.service.ts`

実施内容:

1. `KnowledgeSearchResult` または compiler 内部候補に `KnowledgeCandidateEvidence` を持たせる。
2. text search hit 由来の候補は `textMatched: true` にする。
3. vector search hit 由来の候補は `vectorMatched: true` と `vectorScore` を持たせる。
4. facet 一致がある候補は `facetMatched: true` にする。
5. merge 時に同一 knowledge が複数 origin で見つかった場合、evidence を OR 合成する。
6. `textMatched === false && facetMatched === false && vectorScore < threshold` の候補を agentic refine 前に除外する。
7. すべての候補が除外された場合は `NO_RELEVANT_CONTEXT` として `No Content` にする。
8. source retrieval は audit/diagnostics 用に残してよいが、source refs だけで knowledge を補強採用しない。

### 4.3 MCP / CLI / docs

対象:

- `src/mcp/tools/system.tool.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/cli/compile.ts`
- `docs/mcp-tools.md`

実施内容:

1. `initial_instructions` に設計書参照禁止と milestone 単位の guidance を追加する。
2. MCP handler は compile 結果の markdown が `No Content` の場合、それだけを返す。
3. CLI も `No Content` のみ表示する。
4. `docs/mcp-tools.md` の `context_compile` 仕様に、設計書参照禁止とマイルストーン単位入力を追記する。
5. MCP response は markdown text 1件のまま維持し、候補 evidence JSON を返さない。

### 4.4 UI

対象:

- `web/src/modules/context-compiler/components/context-compiler.page.tsx`
- `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`

実施内容:

1. Detail 画面から `Context Quality` セクションを削除する。
2. `No Content` run は Rules/Procedures が空であることを明確に表示する。
3. `GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE` や `NO_RELEVANT_CONTEXT` は `Degraded Reasons` にだけ表示する。
4. 入力フォームの placeholder を、設計書パスではなく milestone goal を促す文言にする。

---

## 5. テスト計画

### 5.1 Unit

対象:

- `test/context-compiler.service.test.ts`
- `test/context-compiler.test.ts`
- `test/agentic-refine.unit.test.ts`
- `test/query-context.test.ts`
- `test/mcp.tools.test.ts`
- `test/mcp.contract.test.ts`
- `test/knowledge.service.test.ts`
- `test/knowledge.repository.test.ts`

追加・更新する検証:

1. `goal` に `docs/foo-plan.md を実装する` が含まれると retrieval を呼ばず `No Content` を返す。
2. `goal` に `design.md に沿って対応する` が含まれると `GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE` を記録する。
3. `goal` に `tsconfig.json の compilerOptions を整理する` が含まれても design-doc validation では落とさない。
4. selected rule/procedure が 0 件なら markdown は厳密に `No Content`。
5. `Context Quality` が markdown に出ない。
6. `initial_instructions` に「設計書パスではなくマイルストーンを書く」を含む。
7. agentic refine が空配列を返した場合、候補スコア順 fallback をしない。
8. vector-only かつ `facetMatched: false` かつ score が閾値未満の候補は agentic refine に渡されない。
9. 同一候補が text と vector の両方で見つかった場合、evidence が OR 合成される。

### 5.2 Integration

対象:

- `test/context-compiler.integration.test.ts`
- `test/cli.compile.e2e.test.ts`
- `test/api.routes.integration.test.ts`

追加・更新する検証:

1. `docs/context-compile-four-input-redesign-plan.md ...` のような入力で `design.md` 系 knowledge が選ばれない。
2. text hit なし、facet match なし、低 score vector hit ありの run は `No Content` になる。
3. 正しく書かれた milestone goal では、関連する context-compiler / knowledge rule が選ばれる。
4. CLI の removed flag エラーは維持する。

### 5.3 Frontend

対象:

- `test/components/admin/*context-compiler*`

追加・更新する検証:

1. `Context Quality` セクションが表示されない。
2. `No Content` run で Rules/Procedures が空表示になる。
3. `Degraded Reasons` には raw reason が残る。

---

## 6. 受け入れ条件

- `context_compile` の markdown 出力に `Context Quality` が出ない。
- 設計ドキュメント参照を `goal` にした場合、knowledge/source retrieval を行わず `No Content` を返す。
- `tsconfig.json` や `package.json` のような実装対象ファイル名だけでは design-doc validation に引っかからない。
- selected rule/procedure がない場合、markdown は `No Content` のみ。
- `docs/...redesign...md` のような設計ドキュメント参照から `design.md` 系ルールが選ばれない。
- 低 score vector-only 候補は agentic refine に渡されない。
- 候補 evidence は内部メタに留まり、MCP response に JSON として出ない。
- 設計ドキュメントは、呼び出し側がマイルストーン単位に分解してから `context_compile` する方針が `initial_instructions` と docs に明記されている。
- diagnostics / run history には `GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE`、`NO_RELEVANT_CONTEXT` などの理由が残る。
- `bun run verify` が通る。

---

## 7. 実装順序

1. `initial_instructions` と `docs/mcp-tools.md` を更新し、入力方針を固定する。
2. design-doc reference 検出関数と unit test を追加する。
3. invalid goal の `No Content` 早期 return を実装する。
4. renderer から `Context Quality` を削除し、empty pack を `No Content` にする。
5. agentic refine の empty selection fallback をなくす。
6. 候補 evidence (`textMatched` / `vectorMatched` / `vectorScore` / `facetMatched`) を内部メタとして追加する。
7. vector-only / no facet match / low score の relevance guard を追加する。
8. UI から `Context Quality` セクションを削除する。
9. integration / frontend test を更新する。
10. `bun run verify` で確認する。

---

## 8. 非対象

- `context_compile` に任意ファイル読取機能を追加しない。
- `goal` 以外に `files` / `repoPath` / `documentPath` 入力を再導入しない。
- 1000 行級ドキュメントの要約機能を compiler 内に実装しない。
- agentic refine に per-candidate reason JSON や reject reason schema を追加しない。
- 候補 evidence を MCP response に JSON として返さない。
- domain seed 一覧を `initial_instructions` に表示しない。
- 既存の過去 run snapshot を migration で書き換えない。

