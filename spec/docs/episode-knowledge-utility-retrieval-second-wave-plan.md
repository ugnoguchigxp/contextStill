# Episode / Knowledge Utility Retrieval 第2弾 実装計画

Status: conditional implementation plan
Created: 2026-06-29
Related:
- [episode-knowledge-utility-retrieval-notes.md](episode-knowledge-utility-retrieval-notes.md)
- [episode-knowledge-utility-retrieval-first-wave-plan.md](episode-knowledge-utility-retrieval-first-wave-plan.md)

## Goal

第1弾を約2週間運用しても未活用 Knowledge / Episode の利用状況が改善しない場合に、効果が確認できた utility lane だけを最小限 pack に昇格する。

第2弾は常時実施する計画ではない。第1弾の observation report で改善不足が確認された場合だけ実施する。

## Entry Criteria

約2週間の観測後、次の両方を満たす場合にだけ着手する。

1. 改善不足が確認されている。
2. 第1弾の observation report 上、少なくとも 1 つの lane が promotion eligible である。

改善不足は次のうち 1 つ以上で判定する。

- `activationRate` が改善していない。
- `coldKnowledgeRate` が下がっていない。
- `Utility Hit Rate` が 25% 以上の lane があるのに final pack へ反映されていない。
- negative knowledge が必要な goal で trace-only には出るが、final pack には入らず guardrail が不足する。
- EpisodeCard が direct precedent としては拾われるが、verification / risk hint として活用されない。
- `compile_eval.coverage` が改善しない。

promotion eligible な lane が 0 件の場合、第2弾の実装には進まず、第1弾の計測設計または Knowledge 品質を見直す。

## Non Goals

- 全 utility lane を一括で pack に昇格しない。
- `surpriseUtility` で semantic distance が遠いほど加点する方式は採用しない。
- Role / Episode pattern を初手で必須 schema にしない。
- EpisodeCard を source truth にしない。
- Knowledge と Episode の usage signal を混ぜない。
- LLM に raw table を自由 query させない。
- `dynamicScore` を第2弾だけで大きく書き換えない。

## Implementation Surface

第2弾で触る対象を以下に限定する。

- `src/modules/context-compiler/utility-retrieval.service.ts`
  - promotion gate、threshold utility score、supplemental candidate selection。
- `src/modules/context-compiler/context-compiler.service.ts`
  - supplemental candidate を pack composition に最大 1 件だけ渡す。
- `src/modules/context-compiler/context-response-composer.service.ts`
  - Episode precedent / guardrail の表示境界を維持するための文言調整。
- `src/modules/knowledge/knowledge.service.ts`
  - negative inverse promotion に必要な helper。
- `src/modules/episodic-memory/episode-card.service.ts`
  - Episode pattern hint を derive する helper。必須 schema migration はしない。
- `src/cli/utility-retrieval-report.ts`
  - promotion dry-run と post-promotion report。

## Runtime Guard

第2弾は pack 内容を変えるため、feature flag を必須にする。

- flag: `CONTEXT_COMPILE_UTILITY_SUPPLEMENTAL`
- default: disabled
- enabled value: `1`, `true`, `on`
- disabled 時の期待動作: 第1弾の trace-only 挙動だけが残り、supplemental candidate は final pack に入らない。
- rollback: flag を disabled に戻す。migration を伴わない範囲で実装するため DB rollback を不要にする。

## P0: Promotion Gate

trace-only candidate を pack に入れてよいかを lane ごとに判定する。

### 実装

1. 第1弾の observation report を入力にする。
2. lane ごとに promotion eligibility を計算する。
3. eligible でない lane は引き続き trace-only にする。
4. promotion 判断は run 単位ではなく lane 単位で行う。
5. `--mode promotion-dry-run` を `utility:retrieval-report` に追加し、pack を変えずに eligible lane と候補件数を出す。

### Promotion Conditions

```text
eligible =
  utilityHitRate >= 0.25
  AND offTopicIncrease <= 0.05
  AND wrongCount == 0
  AND avgCoverageDelta >= 0
```

### Verification

- 条件を満たさない lane は pack に入らない。
- 条件を満たす lane でも最大件数 cap を超えない。
- promotion 判定の根拠が diagnostics に残る。
- `CONTEXT_COMPILE_UTILITY_SUPPLEMENTAL` が disabled の場合、promotion eligible でも pack に入らない。

### Command

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run utility:retrieval-report -- --mode promotion-dry-run --since-days 14 --limit 500 --json
```

## P1: Supplemental Candidate Slot

eligible lane から最大 1 件だけ final pack に入れる。

### 実装

1. direct candidates を従来どおり作る。
2. utility candidate を promotion gate に通す。
3. section ごとの token budget を崩さない範囲で supplemental slot を 1 件だけ確保する。
4. utility candidate は `rankingReason` に lane と promotion reason を残す。
5. `sourceRefs` と `rejectIf` がない candidate は pack に入れない。
6. token budget 超過時は direct candidate を削らず supplemental candidate を落とす。
7. supplemental candidate の `evidence.promoted=true` と `evidence.promotionReason` を candidate trace に残す。

### Candidate Mix

```text
final candidates =
  direct candidates: existing behavior
  supplemental utility candidate: max 1
```

第2弾でも 10-20% の混入を最初から狙わない。まずは最大 1 件に限定する。

### Verification

- final pack に supplemental item が最大 1 件だけ入る。
- supplemental item は diagnostics / pack item / candidate trace で追える。
- token budget 超過時は direct candidate を不自然に押し出さず、supplemental を落とす。
- `compile_eval.coverage` は悪化しない。
- flag disabled 時の pack snapshot が第1弾と一致する。

## P2: Co-selection Promotion

第1弾で co-selection lane が有効だった場合だけ、co-selection candidate を supplemental slot に昇格する。

### 実装

1. directional co-selection score を使う。
2. seed direct candidate と utility candidate の関係を `adoptionReason` に残す。
3. useful / partial outcome に基づく score を優先する。
4. misleading outcome の pair は除外または強く減点する。
5. seed direct candidate が final pack に残っていない場合、co-selection candidate は昇格しない。

### Verification

- direct candidate なしに co-selection candidate だけが出ない。
- pair の根拠 run count が diagnostics で見える。
- direct candidate と同じ役割の重複候補は抑制される。

## P3: Negative Inverse Promotion

第1弾で negative inverse lane が有効だった場合だけ、negative guardrail を supplemental slot に昇格する。

### 実装

1. `polarity=negative` の candidate だけを対象にする。
2. `intentTags` / applicability / metadata から constrained intent を解釈する。
3. guardrails section に入れる。
4. `Avoid` / `Prefer` に変換できない candidate は採用しない。
5. 必要なら metadata の `constrainedIntents` を任意フィールドとして保存するが、必須 schema にはしない。
6. `register_candidate(s)` の schema は第2弾でも変更しない。metadata を読むだけにする。

### Verification

- negative candidate は procedures / rules ではなく guardrails に入る。
- positive path の retrieval 結果が変わらない。
- `technologies`、`changeTypes`、`domains` が保存から retrieval まで落ちない。
- negative body の日本語ルールを壊さない。

## P4: Role Hints Without First-class Schema

functional role はすぐに first-class column にしない。第2弾では role hint を metadata / evidence として使う。

### 実装

1. utility candidate の `evidence.roleHint` を追加する。
2. role hint は `verification_gate`、`scope_boundary`、`negative_guard`、`rollback_trigger`、`prerequisite` に絞る。
3. retrievalMode から期待 role を軽量に推定する。
4. role hint は scoring 補助に使うが、単独の採用理由にしない。

### Verification

- role hint だけで candidate が pack に入らない。
- role hint は `adoptionReason` と `rejectIf` の説明を補強する。
- schema migration なしで実装できる。

## P5: Episode Analogical Trace and Risk Hint

Episode は引き続き precedent として扱う。第2弾では analogical / risk pattern を trace と prompt 表示に限定して改善する。

### 実装

1. EpisodeCard の metadata に任意の pattern hint を持てるようにする。
2. 初期 pattern は保存済み EpisodeCard の既存 fields から derive する。
3. pattern hint は direct search の補助として使い、source truth にはしない。
4. selected EpisodeCard の `rankingReason` に `risk_hint` / `verification_hint` を残す。
5. composer prompt では「過去事例」「現在の source truth ではない」境界を維持する。
6. EpisodeCard を supplemental Knowledge slot には入れない。Episode は既存の `episodePrecedentLimit` の範囲でだけ扱う。

### 初期 pattern hints

- `problemPattern`
- `rootCausePattern`
- `interventionPattern`
- `verificationPattern`
- `riskCategory`

### Verification

- EpisodeCard は Knowledge signals に混ざらない。
- EpisodeCard には raw evidence 確認の source refs が残る。
- `usedFor` は `support_hint` / `risk_cap` / `verification_hint` / `background` 相当として diagnostics で追える。
- Episode precedent が判断根拠に直結する表現にならない。

## P6: Threshold Utility Score

utility score は「遠いほど良い」ではなく、「utility が十分なら semantic distance を主判定から外す」方式にする。

### scoring

```text
utilityScore =
  coSelectionScore * 0.35
  + roleFitScore * 0.25
  + successPackPrior * 0.20
  + negativeIntentFit * 0.20

if utilityScore < threshold:
  reject

if wrongCount > 0 or offTopicRate > 0.30:
  reject
```

`successPackPrior` や `roleFitScore` の入力が observation report から取れない場合は 0 として扱う。欠損値を LLM に補完させない。

### Verification

- semantic similarity が低いだけでは採用されない。
- utilityScore の構成要素が trace に残る。
- `wrong` / `off_topic` は score 以前の hard guard として効く。

## Tests

- 第1弾の baseline / observation report test
- `test/context-compile-candidate-trace.test.ts`
- `test/context-compiler.service.test.ts`
- `test/context-response-composer.service.test.ts`
- `test/knowledge-feedback.service.test.ts`
- `test/knowledge.repository.test.ts`
- `test/episode-card.repository.sqlite.test.ts`

## Verification Commands

第2弾の実装 PR では、最低限この順で確認する。

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run utility:retrieval-report -- --mode promotion-dry-run --since-days 14 --limit 100 --json
CONTEXT_COMPILE_UTILITY_SUPPLEMENTAL=0 bunx vitest run test/context-compiler.service.test.ts test/context-compile-candidate-trace.test.ts
CONTEXT_COMPILE_UTILITY_SUPPLEMENTAL=1 bunx vitest run test/context-compiler.service.test.ts test/context-response-composer.service.test.ts test/knowledge-feedback.service.test.ts
bun run docs:check-links
bun run typecheck
```

期待結果:

- promotion dry-run が eligible lane と non-eligible lane を JSON で返す。
- supplemental flag disabled では pack snapshot が第1弾相当から変わらない。
- supplemental flag enabled でも final pack に入る utility candidate は最大 1 件。
- docs link check と typecheck が通る。

失敗時対応:

- flag disabled で pack が変わる場合は P1 実装を戻す。
- off_topic / wrong が増える再現がある場合は該当 lane の promotion を無効化する。
- Episode が source truth として表示される場合は composer 変更を戻す。

## Rollout

1. 第1弾の observation report を固定する。
2. promotion gate を trace-only で dry-run する。
3. eligible lane がある場合だけ supplemental slot を有効化する。
4. 最初は max 1 件にする。
5. さらに 1-2 週間観測し、coverage / off_topic / wrong を比較する。
6. 悪化した場合は supplemental slot を feature flag で無効化する。

## Stop Conditions

- 第1弾の observation report がない。
- 改善不足が確認されていない。
- eligible lane がないのに pack promotion を入れようとしている。
- supplemental candidate が direct candidate を大きく押し出す。
- `off_topic` / `wrong` が増える。
- EpisodeCard が source truth として扱われる。
- negative knowledge の minimal shape が崩れる。
- `CONTEXT_COMPILE_UTILITY_SUPPLEMENTAL=0` で第1弾相当の挙動に戻せない。

## Done

- 第1弾の観測結果に基づいて、pack 昇格する lane としない lane を説明できる。
- supplemental candidate は最大 1 件に制限され、根拠と不採用条件を trace で追える。
- negative guardrail と Episode precedent の境界が維持される。
- `compile_eval.coverage` が悪化せず、`off_topic` / `wrong` も増えない。
- 上記 Verification Commands の結果が記録されている。
