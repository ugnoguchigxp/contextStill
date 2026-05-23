# Compile Knowledge Usage Signal 改善 実装計画

> Status: implementation plan
> Date: 2026-05-23
> Scope: `context_compile` の選出 knowledge 利用判定、Compile run detail UI、feedback/quality signal の保存と反映。
> Relation: `docs/knowledge-feedback-staged-learning-plan.md` の保存基盤は継続利用する。ただし、手動 feedback を主入力にする前提はこの計画で置き換える。

## 1. 目的

Compile 画面の `Knowledge Feedback` を、毎回人間が `Used / Off-topic / Wrong` を押す UI から、compile 結果に基づく自動利用シグナルの監査 UI に変更する。

目標は次の 3 点である。

1. 人間が毎回 feedback しなくても、compile run ごとの knowledge 利用状況が蓄積される
2. `使われなかった` と `場違いだった` を分離し、単発の未使用で knowledge 品質を壊さない
3. 人間の操作は、明らかな誤判定、場違い、内容誤りの訂正に限定する

## 2. 現状の問題

### 2.1 UI が何を評価する画面かわからない

現在の Compile run detail は `Knowledge Feedback` という見出しの下に、選出 knowledge ごとの `Used / Off-topic / Wrong` ボタンを表示している。

問題:

- タイトル解決に失敗すると UUID が主表示になり、何を評価するのかわからない
- `Used` が「compile で選ばれた」のか「回答生成で参照された」のか曖昧
- `Off-topic` と `Wrong` の違いはあるが、ユーザーに判断材料が表示されない
- 毎回保存操作が必要に見え、compile の通常フローを邪魔する

### 2.2 手動 feedback 依存は学習信号として弱い

Compile は頻繁に実行されるため、人間が毎回 judgement する前提は現実的ではない。結果として、feedback が入らない run が大量に残り、入ったとしても強い関心があるケースだけに偏る。

そのため、手動 feedback は主データではなく、次の用途に限定する。

- 自動判定の訂正
- 明らかな `off_topic`
- 内容が間違っている `wrong` のレビュー送り

### 2.3 `not used` と `off_topic` が混ざる危険がある

選出された knowledge が最終 compile 結果で使われなかった理由は複数ある。

- 重要だが、ほかの knowledge に吸収されて明示されなかった
- 似た knowledge と重複していた
- task goal には関連するが、今回の回答には不要だった
- そもそも場違いだった

このため、`selected but not used` を即 `off_topic` や品質低下に変換してはいけない。

### 2.4 現在の agentic 採用判定は粗い

`src/modules/context-compiler/context-compiler.service.ts` では、agentic refine が使われた場合に `finalKnowledge` 全体を `agenticAcceptedKnowledgeIds` として扱っている。

これは「refine 後に候補として残った」ことを表すだけで、「最終 markdown で参照された」ことまでは表さない。Compile 画面の利用判定には、response composer の出力に基づく per-knowledge signal が必要である。

## 3. 仕様変更の結論

### 3.1 UI 名称を変更する

`Knowledge Feedback` は廃止し、Compile run detail では次のどちらかの名称にする。

- `Knowledge Usage Signals`
- `Selected Knowledge Audit`

初期実装では `Knowledge Usage Signals` を採用する。理由は、表示対象が人間の feedback ではなく、自動判定を含む利用シグナルだからである。

### 3.2 verdict を 4 種類にする

`knowledge_usage_events.verdict` を次に拡張する。

| verdict | 意味 | 主な actor | 品質反映 |
| --- | --- | --- | --- |
| `used` | 選出され、最終 compile 出力でも参照された | `agent`, `user` | 弱い positive |
| `not_used` | 選出されたが、最終 compile 出力で参照された証拠がない | `agent`, `system` | 初期は neutral |
| `off_topic` | task goal に対して場違い | `user`, 将来の高信頼 evaluator | negative |
| `wrong` | 内容が誤っている、または危険 | `user` | 自動減点せず review queue |

重要なルール:

- `selected` は `used` ではない
- `not_used` は `off_topic` ではない
- `wrong` は自動判定で確定させない
- `off_topic` は単発の自動推測だけで品質減点しない

### 3.3 手動操作は override にする

人間が押すボタンは「毎回回答する feedback」ではなく、表示された自動シグナルへの override とする。

UI の主操作:

- `Mark used`
- `Mark off-topic`
- `Mark wrong`
- `Clear override`

ただし初期表示では強く押させない。各 item の右側メニュー、または compact な secondary action として配置する。

## 4. 自動利用判定

### 4.1 Response composer が used knowledge を返す

`src/modules/context-compiler/context-response-composer.service.ts` の `ComposeResult` を拡張する。

```ts
export type ComposeResult = {
  markdown: string;
  agenticUsed: boolean;
  error?: string;
  usedKnowledge: Array<{
    id: string;
    confidence: number;
    evidence?: string;
    outputSection?: string;
    reason?: string;
  }>;
};
```

LLM に渡す knowledge candidates には、現在の title/summary だけでなく stable ID を含める。

```txt
knowledge candidates:
- id: <knowledge-id>
  kind: rule
  title: ...
  summary: ...
```

agentic composer の出力形式は JSON に変更する。

```json
{
  "markdown": "## 実装フォーカス\n...",
  "usedKnowledge": [
    {
      "id": "knowledge-id",
      "confidence": 0.82,
      "evidence": "該当 knowledge を実装境界として統合した",
      "outputSection": "実装手順"
    }
  ]
}
```

正規化ルール:

- `usedKnowledge[].id` は今回の selected rules/procedures に含まれる ID だけ許可する
- 重複 ID は 1 件にまとめる
- `confidence` が欠ける場合は `0.5`
- 不正 JSON、未知 ID、空 markdown は安全側に倒し、fallback markdown を使う
- `No Content` の場合、selected knowledge は `not_used` として記録する

### 4.2 fallback composer も deterministic signal を返す

agentic compile が無効、または provider failure で fallback markdown を使う場合も、fallback 生成で実際に参照した item ID を返す。

そのため、現在の `buildFallbackMarkdown()` は markdown 文字列だけでなく、使用 item ID も返す構造に変更する。

```ts
type FallbackCompose = {
  markdown: string;
  usedKnowledgeIds: string[];
};
```

fallback が title や workflow から明示的に行を生成した item は `used` とし、selected されたが fallback に入らなかった item は `not_used` とする。

### 4.3 Compile service が event を保存する

`src/modules/context-compiler/context-compiler.service.ts` は `insertContextPackItems()` と `recordKnowledgeCompileSelectionSafe()` の後に、response composer の signal を保存する。

保存対象:

- selected knowledge に含まれる `rule` / `procedure`
- composer が `usedKnowledge` として返した ID は `used`
- selected されたが used に含まれない ID は `not_used`

保存 actor:

- composer / fallback 由来は `agent`
- no-content など system 判定に近いものは `system` でもよいが、初期実装では `agent` に寄せてよい

保存 metadata:

```ts
type KnowledgeUsageSignalMetadata = {
  source: "response_composer" | "fallback_composer" | "manual_override";
  confidence?: number;
  evidence?: string;
  outputSection?: string;
  selectedRank?: number;
  previousAutoVerdict?: "used" | "not_used" | "off_topic" | "wrong";
};
```

## 5. データモデル / API / サービス

### 5.1 DB 変更

対象:

- `src/db/schema.ts`
- `drizzle/00xx_knowledge_usage_not_used.sql`
- shared schema / repository type

変更:

- `knowledge_usage_events.verdict` の check constraint に `not_used` を追加する
- TypeScript の `KnowledgeUsageVerdict` を `"used" | "not_used" | "off_topic" | "wrong"` に拡張する
- `knowledge_usage_events.metadata` に usage signal の evidence を保存できるよう、サービス入力型を拡張する

既存 data migration:

- 既存の `used/off_topic/wrong` はそのまま維持する
- 過去 run に対する retroactive `not_used` backfill は初期実装では行わない

### 5.2 Service 分離

既存の `recordCompileRunKnowledgeFeedback()` は manual override API として残す。

追加する service:

```ts
recordCompileRunKnowledgeUsageSignals({
  runId,
  items: Array<{
    knowledgeId: string;
    verdict: "used" | "not_used";
    reason?: string;
    metadata?: KnowledgeUsageSignalMetadata;
  }>;
  actor: "agent" | "system";
})
```

役割:

- compile 実行中に自動 signal を保存する
- selected knowledge 以外の ID を拒否する
- `wrong` は受け付けない
- `not_used` では review queue を作らない
- `not_used` では `importance/confidence` を変更しない

既存 manual feedback service の変更:

- `not_used` override を受け付ける
- `wrong` の review queue 作成ルールは維持する
- `wrong -> used/not_used/off_topic` 変更時の pending queue dismissal は維持する

### 5.3 API 方針

既存 route は互換維持する。

```txt
POST /api/context/runs/:id/knowledge-feedback
```

用途:

- Compile run detail からの手動 override
- `actor = user`
- `used/not_used/off_topic/wrong` を受け付ける

新規 public API は初期実装では増やさない。自動 signal 保存は compile service 内部から service を呼ぶ。

Run detail response は、UI がそのまま描画できる shape に拡張する。

```ts
type CompileRunKnowledgeSignal = {
  knowledgeId: string;
  title: string;
  type: "rule" | "procedure";
  section: "rules" | "procedures";
  selectedScore?: number;
  selectedReason?: string;
  autoVerdict?: "used" | "not_used" | "off_topic" | "wrong";
  autoActor?: "agent" | "system";
  userOverrideVerdict?: "used" | "not_used" | "off_topic" | "wrong";
  effectiveVerdict?: "used" | "not_used" | "off_topic" | "wrong";
  evidence?: string;
  outputSection?: string;
  rawId: string;
};
```

UI は `rawId` を主表示に使わない。必要なら copy/debug 用の secondary text にする。

## 6. Score / quality 反映

### 6.1 dynamicScore

`src/modules/knowledge/knowledge-value.service.ts` の dynamic score 集計に `not_used` を追加する。

初期式:

- `used`: 弱い positive
- `not_used`: 0 点
- `off_topic`: negative
- `wrong`: score には入れない

`not_used` は「今回の output には入らなかった」だけなので、1 回ごとの negative signal にしない。

### 6.2 quality adjustment

`src/cli/apply-knowledge-quality.ts` は既存どおり `off_topic` を主な品質減点 signal とする。

変更:

- `not_used` は `off_topic_rate` の分母にも分子にも入れない
- `not_used` が一定期間大量に続く場合は、別の reachability/redundancy report に出す
- `wrong` は引き続き review queue のみ

将来追加する report:

```txt
knowledge with high selected_count but low used_rate
```

これは品質減点ではなく、次の調査候補として扱う。

- title/body が抽象的すぎる
- 似た knowledge と重複している
- appliesTo が広すぎる
- response composer が拾いにくい形で書かれている

## 7. UI 改善

対象:

- `web/src/modules/context-compiler/components/context-compiler.page.tsx`
- `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`
- `test/components/admin/context-compiler-page.test.tsx`

### 7.1 表示構造

Compile run detail の下部に `Knowledge Usage Signals` を表示する。

各 item の表示:

- title
- type badge: `Rule` / `Procedure`
- effective verdict badge
- 自動判定の reason/evidence
- selected score / ranking reason
- body の短い preview
- raw ID は secondary/debug text

verdict badge 表示:

- `Used in output`
- `Selected, not referenced`
- `Marked off-topic`
- `Needs review`

### 7.2 手動操作

人間が常に押す前提のボタン列は廃止する。

代わりに、各 item に compact な action menu を置く。

- `Override as used`
- `Mark off-topic`
- `Mark wrong`
- `Clear override`

保存後は run detail query を invalidate し、effective verdict を再表示する。

### 7.3 空状態

自動 signal がまだない既存 run では、次を表示する。

```txt
Usage signals were not recorded for this run.
```

ただし、手動 override は可能にする。

## 8. 実装手順

### Phase 1: schema と型の拡張

1. `knowledge_usage_events.verdict` に `not_used` を追加する migration を作る
2. `src/modules/knowledge/knowledge-feedback.service.ts` の verdict type を拡張する
3. shared schema と web repository type を更新する
4. `not_used` が review queue を作らないことを service test に追加する

### Phase 2: response composer の structured output

1. `buildUserPrompt()` に knowledge ID を含める
2. system prompt に JSON output schema を明記する
3. `ComposeResult.usedKnowledge` を追加する
4. JSON parse / fallback normalize を実装する
5. fallback composer が deterministic `usedKnowledgeIds` を返すようにする

### Phase 3: compile service から自動 signal を保存する

1. `recordCompileRunKnowledgeUsageSignals()` を追加する
2. `context-compiler.service.ts` で selected IDs と used IDs の差分から `used/not_used` を作る
3. metadata に source, confidence, evidence, selectedRank を保存する
4. `recordKnowledgeCompileSelectionSafe()` は既存の selection/accepted tracking として残す

### Phase 4: run detail API を UI 向け shape にする

1. `api/modules/context-compiler/context-compiler.repository.ts` で selected items と usage events をまとめる
2. auto signal と user override を区別して返す
3. title/body が取れない場合も、UUID だけを主表示にしない fallback label を返す

### Phase 5: Compile UI を audit 画面へ変更する

1. `Knowledge Feedback` 見出しを `Knowledge Usage Signals` に変更する
2. UUID 主表示をやめる
3. 自動 verdict badge と evidence を表示する
4. 手動操作を override menu に移す
5. 既存 run の signal 未記録状態を表示する

### Phase 6: score / quality の境界を更新する

1. dynamic score は `used` を弱い positive、`not_used` を neutral にする
2. quality adjustment は `off_topic` のみを品質減点対象にする
3. `wrong` の review queue ルールが変わっていないことを確認する

## 9. テスト計画

追加 / 更新するテスト:

- `test/knowledge-feedback.service.test.ts`
  - `not_used` を保存できる
  - `not_used` は review queue を作らない
  - `wrong -> not_used` で pending queue が dismissed される
- `test/context-response-composer.service.test.ts`
  - JSON output から `usedKnowledge` を抽出する
  - 未知 ID を捨てる
  - fallback composer が deterministic used IDs を返す
- `test/context-compiler.service.test.ts`
  - compile 後に selected IDs 全体へ `used/not_used` signal が保存される
  - `No Content` では `not_used` が保存される
- `test/api.routes.test.ts`
  - manual feedback route が `not_used` を受け付ける
  - invalid verdict を拒否する
- `test/components/admin/context-compiler-page.test.tsx`
  - `Knowledge Usage Signals` が表示される
  - UUID だけの主表示にならない
  - override action 後に mutation が呼ばれる
- `test/knowledge-quality.service.test.ts`
  - `not_used` が off-topic quality decrement に混ざらない

検証コマンド:

```bash
bun run typecheck
bunx vitest run test/context-response-composer.service.test.ts test/knowledge-feedback.service.test.ts test/components/admin/context-compiler-page.test.tsx
bun run verify
bun run knowledge:apply-feedback-quality --dry-run --limit 1
```

## 10. 受け入れ条件

- Compile を実行するだけで、選出 knowledge に `used/not_used` の自動 signal が保存される
- 人間がボタンを押さなくても run detail に利用判定が表示される
- Compile UI に raw UUID が主表示されない
- `not_used` は `off_topic` と別扱いで、単発では score/quality を下げない
- `wrong` は自動生成されず、手動 override 時のみ review queue に入る
- 既存の `POST /api/context/runs/:id/knowledge-feedback` は互換維持される
- `bun run verify` が通る

## 11. 非対象

- 過去 compile run への retroactive usage signal backfill
- LLM による `wrong` の自動確定
- `not_used` を直接の品質減点 signal にすること
- Knowledge Landscape の新しい可視化画面
- Candidates / Knowledge table の pagination / sorting 改修

## 12. 未決定事項

1. `not_used` を既存 `knowledge_usage_events.verdict` に追加するか、別テーブル `knowledge_usage_signals` として分けるか
   - 初期方針は既存 event table への追加
   - 理由は run_id / knowledge_id の uniqueness と review queue 連携を流用できるため
2. agentic composer の JSON response を必須にするか、markdown + sidecar metadata にするか
   - 初期方針は JSON response
   - 理由は per-knowledge usage を本文推定に頼らないため
3. `not_used` の長期集計をどこに出すか
   - 初期方針は quality decrement ではなく、後続の Doctor / Knowledge Landscape report に回す
