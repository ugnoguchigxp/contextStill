# Context Compile Duplicate Suppression 実装計画

更新日: 2026-05-26
Status: implementation plan

## 1. 結論
重複 knowledge の抑制は、semantic edge 生成より先に `context_compile` の候補圧縮で解く。

基本方針:

1. `context_compile` の候補段階で近似重複を検出する。
2. 既存 ranking 上の最上位候補を代表 knowledge とする。
3. 非代表候補は `selectedPackItems` に入れない。
4. 代表だけが `contextPackItems` / `compileSelectCount` / `used` の対象になる。
5. 非代表候補は candidate trace に `suppressed` として残す。
6. semantic edge は、重複ではなく、履歴だけでは解きにくい `supersedes` / `contradicts` の残差に限定する。

これにより、利用履歴と decay の既存ロジックを活かし、スコアの高い代表へ選択履歴を集約できる。

## 2. 背景
現在の `context_compile` は、retrieval で得た knowledge を ranking し、agentic refine、section budget、response compose を経て `selectedPackItems` に入れる。

現行の重要な性質:

- `rankAndDedupe()` は同一 `id` の重複を安定的に落とすが、内容が近い別 knowledge は落とさない。
- `recordKnowledgeCompileSelectionSafe()` は `selectedPackItems` 由来の `selectedKnowledgeIds` に対して `compileSelectCount` と `dynamicScore` を更新する。
- `recordCompileRunKnowledgeUsageSignalsSafe()` は selected knowledge に対して `used` / `not_used` を記録する。
- `computeDynamicScore()` は `compileSelectCount`、直近選択数、agentic accepted、up/down vote、直近 `used` / `off_topic` を見る。
- `not_used` は usage event として残るが、現時点では `dynamicScore` の直接ペナルティではない。
- candidate trace には `suppressed` / `suppressionReason` / `rankingReason` を保存できる。

つまり、近い候補が複数 `selectedPackItems` に入ると、低い方にも `compileSelectCount` が付く。これでは自然淘汰が弱くなる。

狙う挙動は次のとおり。

```txt
近似重複候補が複数ある
-> context_compile 内で代表1件だけを残す
-> 代表だけ selectedPackItems に入る
-> 代表だけ compileSelectCount / used の対象になる
-> 非代表は履歴が増えず、時間劣化で自然に下がる
```

## 3. スコープ
### In Scope
- `context_compile` 内の近似重複検出
- 代表 knowledge の選定
- 非代表候補の candidate trace 記録
- `selectedPackItems` への非代表混入防止
- `not_used` が多い selected knowledge の軽い減点設計
- replay / trajectory で効果を測る観測項目

### Out of Scope
- 全 knowledge graph への semantic edge 一括生成
- LLM による広域 duplicate 判定
- 新しい canonical edge table の追加
- `knowledge_review_queue` への通常重複候補投入
- production ranking に attractor / semantic edge を直接反映すること
- auto-merge / auto-delete / knowledge 本文の自動書き換え

## 4. 設計原則
1. まず既存の `context_compile` mainline を強くする。
2. 新 subsystem を作らず、既存の ranking / usage signal / candidate trace に寄せる。
3. 非代表候補は DB から消さず、選択履歴を増やさない。
4. 抑制理由は replay / trajectory で検証可能にする。
5. semantic edge は「再発する残差」だけを扱う。

## 5. 実装方針
### 5.1 挿入位置
最初の実装では、近似重複圧縮を `filterByCandidateEvidence()` の後、`agenticRefine()` の前に入れる。

候補位置:

```ts
const knowledgeFilterResult = filterByCandidateEvidence(rankedKnowledge);
const filteredKnowledge = knowledgeFilterResult.items;

const duplicateSuppression = suppressNearDuplicateKnowledge(filteredKnowledge);
const compressedKnowledge = duplicateSuppression.items;

const agenticResult = await agenticRefine(compressedKnowledge.map(...), ...);
```

理由:

- ranking 後なので、代表選定に既存の weighted order を使える。
- `agenticRefine()` へ渡す候補数を減らせる。
- agentic refine が失敗して fallback しても、fallback 対象は圧縮済みにできる。
- `selectedPackItems` へ入る前なので、非代表に `compileSelectCount` が付かない。

### 5.2 代表選定
代表は、既存 ranking 後の配列で最も上にある候補を選ぶ。

代表選定で追加の score 式は作らない。既存の `rankAndDedupe()` が反映している次の要素をそのまま使う。

- retrieval score
- importance
- confidence
- dynamicScore
- decayFactor
- source links
- applicabilityScore
- deprecated / stale penalty

この方針により、「スコアの高い方に Used を付け、低い方には付けない」という挙動が自然に成立する。

### 5.3 近似重複の判定
Phase 1 は deterministic heuristic のみにする。LLM は使わない。

同一グループに入れてよい条件:

- 同じ `type` である。
- normalized title が一致する、またはかなり近い。
- body の先頭要約または主要語彙が強く重なる。
- 同じ sourceRef を共有している場合は重複判定を少し強める。
- 同じ communityKey がある場合は重複判定を少し強める。

同一グループに入れてはいけない条件:

- `rule` と `procedure` が別で、片方がもう片方の手順詳細になっている可能性がある。
- 一方が明確に禁止・回避、もう一方が推奨を述べている。
- deprecated と active が近いが、内容差分が置換関係に見える。
- title は似ているが repo / technology / changeType の適用範囲が大きく違う。

Phase 1 の判定は保守的にする。迷う場合は圧縮しない。

### 5.4 データ構造
新規テーブルは作らない。まずは service 内の純粋関数で扱う。

```ts
type DuplicateSuppressionGroup = {
  representativeId: string;
  memberIds: string[];
  reason: "same_normalized_title" | "title_body_overlap" | "shared_source_overlap";
  confidence: number;
};

type DuplicateSuppressionResult<T> = {
  items: T[];
  groups: DuplicateSuppressionGroup[];
  suppressedById: Map<
    string,
    {
      representativeId: string;
      reason: DuplicateSuppressionGroup["reason"];
      confidence: number;
    }
  >;
};
```

実装候補ファイル:

- `src/modules/context-compiler/duplicate-suppression.service.ts`
- `src/modules/context-compiler/duplicate-suppression.service.test.ts`

### 5.5 Candidate Trace
非代表候補は candidate trace に残す。

`buildCandidateTraceRows()` に `duplicateSuppression` 情報を渡し、非代表候補には次を設定する。

- `suppressed: true`
- `suppressionReason: "near_duplicate_representative"`
- `rankingReason`: 既存値がなければ `"near_duplicate_representative:<representativeId>"`
- `evidence.duplicateSuppression.representativeId`
- `evidence.duplicateSuppression.reason`
- `evidence.duplicateSuppression.confidence`

これにより、trajectory / replay / Graph panel で「なぜ選ばれなかったか」を追える。

### 5.6 Usage Signal
Phase 1 では、非代表候補へ usage event を作らない。

代表が selected され、composer が `usedKnowledge` に含めた場合だけ `used` が付く。代表が selected されたが本文に使われなかった場合は、既存どおり `not_used` が付く。

Phase 2 で、繰り返し `not_used` になる selected knowledge に軽い減点を追加する。

候補:

```ts
type KnowledgeValueSignals = {
  usageNotUsedCount30d?: number;
};
```

`computeDynamicScore()` への反映は小さく始める。

```txt
not_used penalty: min(10, usageNotUsedCount30d * 1.0)
```

`off_topic` より弱い減点にする。`not_used` は「候補としては近いが最終出力には不要だった」だけの可能性があるため。

## 6. フェーズ
### Phase 0: 観測ベースライン
目的は、変更前の重複・not_used・selected count を測ること。

実施内容:

- 直近 compile run の `selectedKnowledgeCount` 分布を確認する。
- `knowledge_usage_events.verdict = not_used` の比率を見る。
- candidate trace の `suppressed` 理由の現状分布を見る。
- 同じ title / normalized title が複数 selected される run をサンプル抽出する。

成果物:

- 実装前ベースラインの数値メモ
- Phase 1 のテストケース候補

### Phase 1: Deterministic Duplicate Suppression
目的は、近似重複の非代表を `selectedPackItems` から外すこと。

実装内容:

- `duplicate-suppression.service.ts` を追加する。
- normalized title / body overlap / source overlap の保守的 heuristic を実装する。
- `compileContextPack()` に圧縮ステップを追加する。
- `buildCandidateTraceRows()` に duplicate suppression evidence を追加する。
- duplicate suppression が発生した場合、degraded reason ではなく trace evidence に記録する。

テスト:

- 同じ normalized title の active rule 2件では、上位1件だけ残る。
- `rule` と `procedure` は安易に圧縮されない。
- deprecated と active が近い場合、単純重複でないなら圧縮しない。
- 非代表候補は `selectedPackItems` に入らない。
- 非代表候補は candidate trace で `suppressed` になる。

### Phase 2: `not_used` Signal Tuning
目的は、選ばれるが使われない候補を少しずつ下げること。

実装内容:

- `loadRecentUsageSignalsMap()` に `notUsedCount30d` を追加する。
- `KnowledgeValueSignals` に `usageNotUsedCount30d` を追加する。
- `computeDynamicScore()` に弱い `not_used` penalty を入れる。
- `recalculateKnowledgeDynamicScores()` が新 signal を使うようにする。

テスト:

- `not_used` が増えると dynamicScore が少し下がる。
- `off_topic` の減点は `not_used` より強い。
- `used` がある候補は過剰に落ちない。

### Phase 3: Residual Semantic Edge Candidate
目的は、履歴と重複圧縮だけでは解けない残差を semantic edge 候補にすること。

対象:

- `supersedes`: 古い手順と新しい手順の置換関係
- `contradicts`: 高スコア候補同士の矛盾

Phase 3 でも、広域 LLM batch は行わない。trigger は compile / replay で観測された問題に限定する。

候補 trigger:

- 近い2候補が複数回同じ run で高順位に出るが、片方だけ `used` になる。
- deprecated 候補が active 候補と近く、かつ古い方が上位に出る。
- `used` 同士で contradiction heuristic に引っかかる。
- trajectory replay で `used_baseline_lost` や `over_selected_not_used` が繰り返される。

出力先:

- 既存の landscape review item / contradiction flow との整合を確認してから決める。
- `knowledge_review_queue` は誤判定レビュー専用のまま維持し、通常の重複候補は入れない。

## 7. 影響ファイル
想定される変更先:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/ranking.service.ts`
- `src/modules/context-compiler/duplicate-suppression.service.ts`
- `src/modules/knowledge/knowledge-value.service.ts`
- `src/modules/context-compiler/context-compiler.repository.ts`
- `src/shared/schemas/landscape-trajectory.schema.ts`
- `test/context-compiler.service.test.ts`
- `test/mcp.contract.test.ts`
- `test/agentic-refine.unit.test.ts` または新規 unit test

Phase 1 だけなら DB migration は不要。

Phase 2 も既存の `knowledge_usage_events` を使うため DB migration は不要。

## 8. 受け入れ条件
Phase 1 完了条件:

- 近似重複グループから代表1件だけが `selectedPackItems` に残る。
- 非代表候補に `compileSelectCount` が増えない。
- 非代表候補の candidate trace に `suppressionReason = near_duplicate_representative` が残る。
- `context_compile` の通常成功 path が `ok` / `degraded` 判定を不要に悪化させない。
- agentic refine が失敗しても、fallback は圧縮済み候補を使う。
- `bun run test:unit -- test/context-compiler.service.test.ts` 相当の focused test が通る。
- `bun run verify` が通る。

Phase 2 完了条件:

- `not_used` の repeated signal が dynamicScore に弱く反映される。
- `used` / `off_topic` の既存意味が壊れない。
- `unused-active` / `stale` / `high-value` の表示意味が変わらない。
- dynamic score の unit test が追加される。

Phase 3 開始条件:

- Phase 1 後も、重複では説明できない `supersedes` / `contradicts` 問題が replay で観測される。
- LLM edge 生成の対象が compile/replay 由来の小さな候補集合に限定できる。
- 生成結果の保存先が `knowledge_review_queue` と混線しない。

## 9. 検証計画
### Unit
- duplicate grouping
- representative selection
- cross-type non-suppression
- deprecated/active non-suppression
- source overlap boost
- candidate trace suppression metadata
- dynamicScore `not_used` penalty

### Integration
- `context_compile` で近似重複候補を含む fixture を流し、代表だけが selected されること。
- `knowledge_usage_events` に代表だけが記録されること。
- candidate trace に非代表が suppressed として残ること。
- composer が `usedKnowledge` に代表を返した場合だけ `used` になること。

### Replay / Observability
- 変更前後で selected count が過剰に減っていないこと。
- `No Content` 率が上がっていないこと。
- `not_used` 率が下がること。
- 代表へ `used` が集約されること。
- duplicate suppression の top reasons が確認できること。

## 10. リスク
### 過剰圧縮
似ているが役割が違う knowledge を落とすリスク。

対策:

- Phase 1 は保守的 heuristic に限定する。
- `rule` / `procedure` を原則またがない。
- applicability が大きく違う場合は圧縮しない。
- candidate trace に非代表を残して後から検証できるようにする。

### 代表固定による局所最適
一度代表が強くなると、別候補が復活しにくくなる。

対策:

- 代表選定は dynamicScore だけでなく decay / source / applicability を含む既存 ranking に従う。
- stale / deprecated penalty を維持する。
- replay で `used_baseline_lost` が増える場合は suppression rule を緩める。

### `not_used` penalty の過剰反応
composer が短くまとめたために `not_used` になった候補まで落ちる可能性。

対策:

- `not_used` penalty は `off_topic` より弱くする。
- 直近 window の repeated signal のみ使う。
- Phase 2 は Phase 1 の効果を見てから入れる。

## 11. 実装順序
1. Phase 0 のベースライン集計を追加なしで取得する。
2. `duplicate-suppression.service.ts` の pure unit test を書く。
3. deterministic suppression を実装する。
4. `compileContextPack()` に圧縮ステップを挿入する。
5. candidate trace evidence を追加する。
6. focused test を通す。
7. `bun run verify` を通す。
8. Phase 1 の効果を replay / usage events で見る。
9. 必要なら Phase 2 の `not_used` penalty を入れる。
10. それでも残る問題だけ Phase 3 の semantic edge candidate に進める。

## 12. 判断保留
次は実装前に小さく確認する。

- normalized title の閾値をどこまで厳しくするか。
- body overlap を文字 n-gram にするか token Jaccard にするか。
- sourceRef overlap を必須条件にするか補助 signal にするか。
- duplicate suppression reason を trajectory UI に表示するか、API trace のみで十分か。
- Phase 2 の `not_used` penalty を初回実装に含めるか、Phase 1 後に分けるか。
