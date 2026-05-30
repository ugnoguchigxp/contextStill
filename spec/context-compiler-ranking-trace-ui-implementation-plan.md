# Context Compiler Ranking Trace UI 実装計画

更新日: 2026-05-30
Status: implementation plan

## 1. 結論

最初の実装は、**Context Compiler の run detail 派生 UI** として作る。

新しい ranking engine、feature table、学習 pipeline、重み更新は作らない。既存の `context_compile_candidate_traces`、`context_pack_items`、`knowledge_usage_events`、`context_compile_evals`、`context_compile_runs` を join し、「なぜこの knowledge が選ばれたのか / 落ちたのか」を read-only に説明する。

初期到達点は次である。

1. Context Compiler run detail に `Ranking Trace` タブを追加する。
2. run 単位で candidate funnel を表示する。
3. candidate ごとの `textRank -> vectorRank -> mergedRank -> finalRank -> packed` を表で表示する。
4. `used / not_used / off_topic / wrong / no signal` を同じ表に重ねる。
5. `compile_eval` は「その run の評価サマリ」として表示するだけにする。
6. `compile_eval` や `used/not_used` の結果を production ranking に即時反映しない。

## 2. 背景

現行には ranking と trace の基盤がすでにある。

- `rankAndDedupe()` は `importance`、`confidence`、`dynamicScore`、`decayFactor`、source link、error context、applicability、status penalty を使って候補を並べる。
- `context_compile_candidate_traces` は `textRank`、`vectorRank`、`mergedRank`、`finalRank`、`selected`、`suppressed`、`suppressionReason`、`agenticDecision`、`communityKey` を保存する。
- `context_pack_items` は最終 pack に入った item の `score`、`rankingReason`、`sourceRefs` を保存する。
- `knowledge_usage_events` は run/item 単位の `used / not_used / off_topic / wrong` を保存する。
- `context_compile_evals` は run 全体の `relevance / actionability / coverage / noise / specificity` と outcome を保存する。

一方で、UI 上の体験はまだ分断されている。

- Context Compiler detail では selected item と feedback は見えるが、候補がどの段階で落ちたかは見えにくい。
- Graph / Community UI は attractor、community、replay health を見る画面であり、run 単位の ranking 原因説明には向かない。
- Ranking の存在はコードと DB にはあるが、ユーザーが「なぜこの順位か」を見る専用導線がない。

そのため、まず run detail に read-only の trace view を足す。

## 3. スコープ

### In Scope

- Context Compiler run detail への `Ranking Trace` タブ追加
- run 単位の candidate funnel 表示
- candidate trace table の read-only 表示
- selected / packed / suppressed / agenticDecision / feedback / compile_eval の横断表示
- pack position の表示
- `used/not_used` を中心にした視覚的な状態表示
- API response schema / repository / web repository / hook / component の追加
- unit/component test の追加

### Out of Scope

- production ranking の重み変更
- `compile_eval` score を ranking に反映する処理
- `used/not_used` を即時 learning feature として ranking に反映する処理
- 新しい feature table の追加
- goal embedding cluster の永続化
- dynamicScore 算出式の変更
- knowledge の自動 demote / promote
- landscape attractor / community score の production ranking 反映
- Graph UI の大規模改修
- writable sandbox UI

## 4. UI 方針

### 4.1 画面配置

既存 `Context Compiler Control Plane` の run detail 側にタブを追加する。

```txt
Context Compiler Run Detail
├─ Pack
├─ Ranking Trace
├─ Feedback & Eval
└─ Markdown Output
```

Phase 1 では既存 detail 内に収める。独立した `Ranking Insights` ページは作らない。

理由:

- 調査対象の基本単位が `runId` である。
- `used/not_used` も `compile_eval` も run に紐づく。
- 「この compile で何が起きたか」を説明できる前に、横断分析 UI を作ると抽象化が早すぎる。

### 4.2 Ranking Trace タブ

タブ上部に run summary を表示する。

```txt
Run Summary
goal: ...
repoPath: ...
changeTypes: feature, review
technologies: TypeScript, React
status: ok
compile_eval: 89 useful
selected: 6 / candidates: 42
feedback: used 4 / not_used 2 / no signal 0
```

次に candidate funnel を表示する。

```txt
Candidate Funnel
text hits 18 -> vector hits 24 -> merged 35 -> filtered 28 -> final 12 -> packed 6
```

候補表は次の列を持つ。

| Column | 内容 |
|---|---|
| `#` | 表示順。原則 `finalRank`、なければ stage rank / selected 優先 |
| `title` | knowledge title |
| `kind` | rule / procedure |
| `text` | textRank / textScore |
| `vector` | vectorRank / vectorScore |
| `merged` | mergedRank / mergedScore |
| `final` | finalRank / finalScore |
| `packed` | pack に入ったか、packPosition |
| `feedback` | used / not_used / off_topic / wrong / no signal |
| `decision` | accepted / rejected / skipped / not_evaluated |
| `reason` | rankingReason or suppressionReason |
| `community` | communityKey |

候補行を展開すると、原因説明を表示する。

```txt
Why This Item?
- textRank: 3
- vectorRank: 8
- mergedRank: 2
- finalRank: 1
- packPosition: 1
- selected: yes
- feedback: used
- suppressionReason: -
- rankingReason: ranked by weighted score (active)
- sourceRefs: 4
```

現時点では `weightedScore()` の内部寄与値は DB に保存されていないため、Phase 1 では「保存済み trace と outcome の説明」に留める。寄与値の分解表示は Phase 2 の候補とする。

### 4.3 Feedback & Eval タブ

既存の selected item feedback と evaluations を整理して表示する。

表示対象:

- `compile_eval` 最新値
- `relevance / actionability / coverage / noise / specificity`
- selected item ごとの feedback
- no signal の selected item

このタブは採点入力 UI ではなく、保存済み評価の確認 UI とする。

### 4.4 Graph / Community UI との関係

Graph / Community UI は Phase 1 では触らない。

将来的に連携する場合も、Graph 側は community health 表示に限定する。

```txt
Community Ranking Health
used rate: 72%
not_used rate: 18%
over-selected not_used: 3 items
used-lost in replay: 2 items
recommended: review scoping
```

run 単位の順位説明は Context Compiler に残す。

## 5. API 設計

### 5.1 Endpoint

新規 endpoint を追加する。

```txt
GET /api/context/runs/:id/ranking-trace
```

既存 `GET /api/context/runs/:id` に全 trace を混ぜない。run detail は既に pack、feedback、evaluations を含むため、trace table まで常時返すと payload が大きくなる。

### 5.2 Response shape

```ts
type CompileRunRankingTraceResponse = {
  run: {
    id: string;
    goal: string;
    repoPath: string | null;
    retrievalMode: string;
    status: "ok" | "degraded" | "failed";
    input: Record<string, unknown>;
    createdAt: string;
  };
  evalSummary: {
    count: number;
    latestAvg: number | null;
    latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
  };
  feedbackSummary: {
    used: number;
    notUsed: number;
    offTopic: number;
    wrong: number;
    noSignal: number;
  };
  funnel: {
    textHitCount: number;
    vectorHitCount: number;
    mergedCount: number;
    finalCount: number;
    packedCount: number;
    selectedCount: number;
    suppressedCount: number;
  };
  items: Array<{
    itemKind: "rule" | "procedure";
    itemId: string;
    title: string;
    status: "active" | "draft" | "deprecated";
    textRank: number | null;
    textScore: number | null;
    vectorRank: number | null;
    vectorScore: number | null;
    mergedRank: number | null;
    mergedScore: number | null;
    finalRank: number | null;
    finalScore: number | null;
    selected: boolean;
    packed: boolean;
    packPosition: number | null;
    suppressed: boolean;
    suppressionReason: string | null;
    agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
    rankingReason: string | null;
    communityKey: string | null;
    feedback: {
      verdict: "used" | "not_used" | "off_topic" | "wrong" | null;
      actor: "agent" | "user" | "system" | null;
      reason: string | null;
      updatedAt: string | null;
    };
    sourceRefs: string[];
  }>;
};
```

### 5.3 packPosition

`context_pack_items` には明示的な position column がないため、Phase 1 では次の順で算出する。

1. `context_compile_runs.pack_snapshot.rules/procedures` の配列順を優先する。
2. snapshot がない legacy run は `context_pack_items.created_at` と `section` から best-effort で算出する。
3. 算出できない場合は `null` にする。

新しい column は Phase 1 では追加しない。

## 6. Backend 実装手順

### 6.1 Schema

新規 Zod schema を追加する。

候補:

- `src/shared/schemas/compile-run-ranking-trace.schema.ts`

既存 `compile-run.schema.ts` が肥大化する場合は分離する。型は web repository からも利用できるよう shared に置く。

### 6.2 Repository

候補ファイル:

- `src/modules/context-compiler/context-compiler-ranking-trace.repository.ts`

責務:

- `context_compile_runs` を取得する。
- `context_compile_candidate_traces` を runId で取得する。
- `knowledge_items` を join して title/status/type を補う。
- `context_pack_items` と `pack_snapshot` から packed / packPosition / sourceRefs を補う。
- `knowledge_usage_events` から feedback を補う。
- `context_compile_evals` から eval summary を補う。

既存 `getRunDetailForApi()` の責務を肥大化させない。

### 6.3 API Service / Route

候補ファイル:

- `api/modules/context-compiler/context-compiler.service.ts`
- `api/modules/context-compiler/context-compiler.routes.ts`

追加:

```ts
getRunRankingTraceForApi({ id })
GET /runs/:id/ranking-trace
```

not found は既存 run detail と同じく 404 を返す。

### 6.4 Sorting

UI 表示順は backend で安定化する。

優先順:

1. `selected = true`
2. `packPosition`
3. `finalRank`
4. `mergedRank`
5. `textRank`
6. `vectorRank`
7. `itemId`

これにより、pack に入った item と落ちた候補を同じ表で比較しやすくする。

## 7. Frontend 実装手順

### 7.1 Repository / Hook

候補ファイル:

- `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`
- `web/src/modules/context-compiler/hooks/context-compiler.hooks.ts`

追加:

```ts
fetchRunRankingTrace(runId: string)
useCompileRunRankingTrace(runId: string | null)
```

query key:

```ts
["compile-run-ranking-trace", runId]
```

feedback mutation 成功時は、既存 detail と ranking trace の両方を invalidate する。

### 7.2 Components

候補:

- `web/src/modules/context-compiler/components/context-compiler.ranking-trace.tsx`

構成:

- `RankingTraceSummary`
- `CandidateFunnel`
- `RankingTraceTable`
- `RankingTraceRowDetail`
- `FeedbackSummaryChips`

既存 `Badge`、`Button`、`Card` を使い、Graph page の特殊な黒背景 UI には寄せない。Context Compiler の既存 control plane の visual language を維持する。

### 7.3 Run Detail タブ

`web/src/modules/context-compiler/components/context-compiler.page.tsx` の run detail 内に local state を追加する。

```ts
type RunDetailTab = "pack" | "ranking" | "feedback" | "markdown";
```

Phase 1 では URL state は不要。必要になったら query param 化する。

### 7.4 Responsive

desktop:

- summary cards
- funnel row
- full table
- expandable row detail

mobile:

- table をカード list に切り替える。
- rank columns は compact badge にする。
- `reason` と `sourceRefs` は collapse する。

ロジックは共通化し、表示だけを responsive にする。

## 8. Test Plan

### 8.1 Unit / API

追加候補:

- `test/context-compiler-ranking-trace.repository.test.ts`
- `test/api.routes.test.ts` または context compiler route の既存 test に追加

検証:

- trace が存在する run で candidate rows が返る。
- selected / packed / feedback / eval summary が join される。
- `pack_snapshot` から packPosition が算出される。
- snapshot 不在時も 500 にせず `packPosition: null` または best-effort を返す。
- run が存在しない場合 404。
- `compile_eval` score は出力されるが、ranking 関連 DB 値を更新しない。

### 8.2 Component

追加候補:

- `test/components/admin/context-compiler-ranking-trace.test.tsx`

検証:

- summary が表示される。
- `used / not_used / no signal` が表示される。
- selected item と suppressed item が同じ表で区別できる。
- row detail に rank trace が表示される。
- loading / empty / legacy snapshot unavailable を表示できる。

### 8.3 Finish Gate

実装完了時の確認:

```bash
bun run typecheck
bun run lint
bun run test:unit
bun run build:web
```

最終的には通常の finish gate として次を通す。

```bash
bun run verify
```

## 9. Acceptance Criteria

- Context Compiler run detail から `Ranking Trace` を開ける。
- candidate trace が run 単位で表として見える。
- selected / packed / suppressed / agenticDecision / feedback が同じ行で見える。
- `used/not_used` が ranking trace と分断されずに見える。
- `compile_eval` が run summary として見える。
- `compile_eval` や `used/not_used` による production ranking 更新は実装されていない。
- 新しい DB table / migration は追加されていない。
- Graph / Community UI の大規模変更は入っていない。
- legacy run や trace が存在しない run でも UI が壊れない。

## 10. 将来候補

Phase 1 の read-only UI で価値が確認できた後に検討する。

- `weightedScore()` の寄与値 breakdown 保存
- `goal embedding cluster` の保存と横断分析
- `Ranking Insights` 独立ページ
- used retention / not_used penalty の replay simulation
- rank parameter sandbox UI
- Graph community health から ranking trace run への deep link

これらは Phase 1 には含めない。
