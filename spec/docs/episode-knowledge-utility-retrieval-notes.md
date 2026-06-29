# Episode / Knowledge Utility Retrieval Notes

Status: idea note
Created: 2026-06-29

## Purpose

Episode と knowledge の retrieval を、単純な文字列一致や embedding 類似だけでなく、後段で実際に採用される可能性から見直すための検討メモ。

この文書は実装計画ではない。後日、どの方向を採用するか判断するための材料として残す。

## Current Conclusion

Cube Core や Cube 風 semantic layer を急いで導入するメリットは、現時点では小さい。

一方で、Episode と knowledge には次の改善余地がある。

- Episode: 表面上の類似ではなく、同じ失敗構造・成功構造・検証パターンを持つ過去事例を拾う。
- Knowledge: query に文字列的・semantic 的に近くなくても、過去採用履歴や役割から採用される可能性が高いものを拾う。

したがって、追加するなら新しい外部 semantic runtime ではなく、既存 retrieval の横に小さな utility retrieval lane を足す方向がよい。

## Non Goals

- Cube Core を依存として導入しない。
- 既存の text / vector / facet retrieval を置き換えない。
- LLM に raw table を自由に query させない。
- 類似度が低い候補を広く混ぜることを目的にしない。
- Episode を source truth として扱わない。
- Knowledge の採用率改善を理由に、off_topic 候補を増やさない。

## Episode Idea

Episode は、直接類似だけでなく analogical retrieval を別レーンで扱う。

### Direct Lane

現在の goal / domain / technology / changeType / tool / repo / outcomeKind が近い Episode を拾う。

これは通常の類似事例検索であり、現在の検索と大きく変えない。

### Analogical Lane

表面上は違っても、次の構造が近い Episode を拾う。

- problemPattern: stale runtime, wrong source of truth, provider fallback, schema drift, queue stall
- rootCausePattern: live owner mismatch, missing side effect, misleading status, unsupported executor
- interventionPattern: restart owner, requeue subset, add verification gate, split terminal states
- verificationPattern: DB row check, process ownership check, trace comparison, before/after count

### Episode Utility Signal

```ts
type EpisodeUtilitySignal = {
  episodeId: string;
  lane: "direct_precedent" | "analogical_precedent" | "risk_pattern" | "verification_pattern";
  surfaceSimilarity: number;
  mechanismSimilarity: number;
  transferability: number;
  differencePenalty: number;
  usefulBecause: string;
  doNotUseIf: string[];
};
```

### Adoption Rule

Analogical Episode は最終判断の根拠に直結させない。

採用する場合も、次のどれに効くかを明示する。

- 判断軸
- 手順
- 確認観点
- risk cap
- verification hint

採用できない場合は、`differenceReason` を残す。

```ts
type EpisodeAdoption = {
  episodeId: string;
  usedFor: "support_hint" | "risk_cap" | "verification_hint" | "background";
  adopted: boolean;
  similarityReason: string;
  differenceReason: string | null;
};
```

## Knowledge Idea

Knowledge は、query への近さだけでなく、後段で採用される可能性を utility として見る。

### Existing Direct Lane

既存の text / vector / facet retrieval はそのまま残す。

これは query に直接近い候補を拾う主レーン。

### Utility Lane

直接近くないが、採用される可能性が高い候補を少数だけ拾う。

候補は次のレーンで分ける。

- co_selection: direct hit と過去 compile で一緒に選ばれた knowledge
- success_pack_prior: useful / partial だった compile pack に頻出した knowledge
- role_guardrail: verification, scope_guardrail, runtime_truth, rollback_condition など役割で効く knowledge
- negative_constraint: action を止める、狭める、確認条件を追加する negative guardrail

### Utility Candidate

```ts
type UtilityKnowledgeCandidate = {
  knowledgeId: string;
  lane: "co_selection" | "success_pack_prior" | "role_guardrail" | "negative_constraint";
  predictedUsefulness: number;
  semanticSimilarity: number;
  surpriseScore: number;
  adoptionReason: string;
  rejectIf: string[];
};
```

### Surprise Utility Score

近くない候補を拾うため、通常の類似度とは逆の観点も使う。

```text
surpriseUtility =
  predictedUsefulness
  + coSelectionScore
  + roleFitScore
  + successfulPackPrior
  - semanticSimilarity
  - offTopicPenalty
  - wrongPenalty
```

これは「遠い候補を多く出す」ためではない。

直接類似では出ないが、過去の採用パターンや role fit から見て効く可能性が高いものを、最大 1-3 件だけ混ぜるための補助スコア。

## Candidate Mix

初期案では、最終候補の大半は従来 retrieval から取る。

```text
final candidates =
  direct candidates 80-90%
  utility candidates 10-20%
```

utility candidate は、通常候補と同じ扱いにしない。

必ず `lane`, `adoptionReason`, `rejectIf` を付けて、なぜ近くない候補を入れたか説明できる状態にする。

## Safety Conditions

採用してよい候補:

- goal の手順、確認、制約のどれかに接続できる。
- 後段で `Workflow` / `Verification` / `Avoid` のいずれかに配置できる。
- 直接近くない理由と、それでも効く理由が両方説明できる。
- 過去の `used` / useful / partial / co-selection など、採用可能性の根拠がある。

採用しない候補:

- 役割が曖昧。
- 一般論にしかならない。
- `off_topic` / `wrong` の履歴が強い。
- direct candidate と重複した役割しか持たない。
- Episode precedent だけを source truth として使う必要がある。
- 現在の goal に対して完了条件や確認条件に変換できない。

## Evaluation Questions

後日検討するときは、次の問いで判断する。

1. unused が多い原因は、候補が遠すぎることか、近いが役割が曖昧なことか。
2. utility lane で拾った候補は、実際に `used` になるか。
3. utility lane は `off_topic` / `wrong` を増やさないか。
4. direct lane だけでは拾えなかった useful 候補が増えるか。
5. `context_decision` で risk / counter / verification の採用理由が明確になるか。
6. `context_compile` の pack が長くなるだけでなく、行動可能性や検証可能性を上げるか。

## Possible First Slice

実装するなら、最初は大きな retrieval rewrite ではなく trace-only でよい。

1. direct candidates を既存どおり取得する。
2. direct candidates に対して co-selection 候補を最大 5 件だけ計算する。
3. utility candidate を最終 pack には入れず、candidate trace にだけ保存する。
4. compile_eval / knowledge usage feedback と照合し、utility candidate が本当に使われた可能性を確認する。
5. 結果が良い場合だけ、最大 1-2 件を supplemental candidate として pack に入れる。

## Summary

Cube の概念導入よりも、既存 retrieval の横に小さな utility retrieval lane を作る方が現実的。

Episode では analogical retrieval、knowledge では co-selection / success-pack prior / role guardrail / negative constraint が主な候補。

ただし、どちらも最終判断に直接混ぜる前に、採用理由と不採用条件を trace として残すことを優先する。
