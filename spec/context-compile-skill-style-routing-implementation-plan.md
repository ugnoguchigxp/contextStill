# Context Compile SKILL/Narrative 出力分岐 実装計画

更新日: 2026-05-29
Status: implementation plan

## 1. 結論

`context_compile` の 2 ラウンド composer を次の方針で拡張する。

1. Round 1 で `responseStyle` を決定する。
2. 形式制御はロジック矯正ではなく、SystemContext（prompt 契約）で主導する。
3. `responseStyle = skill` は「Goal が手順志向」で、かつ候補が足りる場合のみ採用する。
4. 候補不足・低信頼時は `responseStyle = narrative` に降格するが、判定はまず LLM の自己評価を優先する。
5. ハードガードは parse failure や明確な契約違反時のみ最小限に適用する。

この変更により、procedure がヒットしたかどうかだけで形式を決めず、Goal と候補の実効性を両方見て出力形式を選べるようにする。さらに、過剰な if/else 分岐ではなく prompt 設計で挙動を安定化する。

## 2. 背景

現状の 2 ラウンド実装では、Round 1 は見出し設計と query hint 選定を行い、Round 2 はその構成で本文を生成する。

一方で、次の要件が未充足である。

- Goal が明確に手順化を求める場合、再利用しやすい SKILL 形式に寄せたい。
- procedure ヒットの有無だけで SKILL 化を強制したくない。
- 候補が不足している場合は無理に SKILL 化せず、narrative を維持したい。

## 3. 目標仕様

### 3.1 Round 1 の追加出力

Round 1 planner の JSON に次を追加する。

```json
{
  "responseStyle": "skill | narrative",
  "styleReason": "...",
  "styleConfidence": 0.0
}
```

既存項目（`headings`, `ruleQueryHints`, `procedureQueryHints`, `exclusionHints`, `includeAvoidSection`）は維持する。

### 3.2 style 決定方針

`responseStyle = skill` を許可する条件:

- Goal が手順化・実行フロー・運用手引きを主目的にしている。
- 候補に実行可能ステップへ落とし込める材料がある（procedure または action-oriented rule）。
- planner が十分な確信を持つ（`styleConfidence >= 0.70`）。

それ以外は `responseStyle = narrative`。

注意点:

- procedure が存在しても、Goal が設計比較・方針説明中心なら narrative を選ぶ。
- rules のみでも、Goal が手順化目的で候補が十分なら skill を許可する。
- 候補不足判定に該当する場合は style を narrative に降格する。

優先原則:

- 形式判定の主導は Round 1 prompt（SystemContext）で行う。
- 実装ロジックは最終的な安全弁に留める。

### 3.3 候補不足判定

Round 2 実行前に planner が `candidateSufficiency`（`enough | limited | insufficient`）を返し、`limited/insufficient` の場合は narrative を優先する。

補助的に、次のどちらかを満たす場合のみ deterministic な降格を行う。

- `procedures.length === 0` かつ action-oriented rule が 2 件未満
- Round 1 の hint に対する候補一致が閾値未満（例: `rule/procedureQueryHints` の合計一致数が 2 未満）

上記判定は LLM 判定を置き換えるためではなく、明確な不足ケースでの安全弁として使う。

### 3.4 Round 2 の出力契約

`responseStyle = skill` のときは、本文を次の構成で返す。

- `Use when`
- `Workflow`
- `Verification`
- `Avoid`

`responseStyle = narrative` のときは現行方針を維持する。

- Goal に合わせた見出し（Round 1 headings）
- 手順・確認観点中心のコンテキスト

### 3.5 失敗時フォールバック

次の場合は最終出力を narrative に落とす。

- planner JSON parse 失敗
- `styleConfidence` 低値
- skill 形式の必須セクション欠落
- skill 出力が goal に非整合

`No Content` は候補ゼロまたは goal 非整合が強いケースに限定する。rules のみヒット時は基本 narrative で返す。

運用原則:

- まず prompt で `skill -> narrative` の判断をさせる。
- 実装側ガードは「落とし穴回避」の最低限に限定する。

## 4. 実装範囲

### In Scope

- `src/modules/context-compiler/context-response-composer.service.ts`
  - planner schema 拡張 (`responseStyle`, `styleReason`, `styleConfidence`)
  - style ガード実装（confidence / candidate sufficiency）
  - skill 形式の生成制約と検証
  - narrative フォールバック経路の明示化
- `test/context-response-composer.service.test.ts`
  - style 選択・降格・フォールバックのテスト追加

### Out of Scope

- retrieval pipeline 全体の ranking ロジック変更
- DB schema 変更
- MCP tool 入出力 schema 変更
- Vibe Note / WebUI の表示仕様変更

## 5. 実装手順

### Step 1: Planner 型と prompt 拡張

- `ComposePlan` に `responseStyle`, `styleReason`, `styleConfidence` を追加。
- `candidateSufficiency`（`enough | limited | insufficient`）を追加。
- Round 1 system prompt で style 決定責務を明示し、手順志向 Goal なら SKILL 形式へ寄せる方針を埋め込む。
- Round 1 user prompt に候補量の要約（rules/procedures 件数、上位タイトル）を渡す。

### Step 2: 最小ガード実装

- `enforceStyleGuards(plan, params)` を追加。
- 判定順序:
  1. parse/構造検証
  2. 明確な候補不足チェック
  3. 契約違反チェック（skill 必須セクション欠落など）
- 不成立時は `responseStyle = narrative` へ書き換える。
- style 判定の一次決定は planner 出力を尊重する。

### Step 3: Round 2 生成制約を style 別に分離

- `buildComposerSystemPrompt(...)` を style-aware にする。
- `skill` のときは section contract を固定。
- `narrative` は現行見出しベース生成を維持。

### Step 4: 出力検証とフォールバック

- `validateSkillMarkdown(markdown)` を追加。
- 必須セクション欠落時は `buildFallbackCompose(... narrative ...)` に切替。
- エラーコードを分離して追跡可能にする。
  - 例: `COMPOSER_SKILL_SECTION_MISSING`
  - 例: `COMPOSER_STYLE_DOWNGRADED_TO_NARRATIVE`

### Step 5: テスト整備

以下を unit test に追加する。

1. Goal が手順志向 + 候補十分 -> skill 形式で返る
2. Goal は手順志向だが候補不足 -> narrative に降格
3. procedure があっても Goal が説明中心 -> narrative を維持
4. rules のみでも候補十分なら skill 許可
5. skill 出力崩れ -> narrative フォールバック
6. planner が `candidateSufficiency=limited` を返した場合は narrative 優先

## 6. テスト観点

- style 判定が source kind 固定ではなく Goal 主導になっているか
- style 判定がロジック主導ではなく SystemContext 主導になっているか
- `skill` と `narrative` の分岐が再現可能か
- 候補不足時に `No Content` へ落ちず narrative を返せるか
- error reason が追跡できるか（degraded reason/ログ）

## 7. リスクと対策

### リスク 1: style 判定が不安定

対策:

- planner の styleReason / candidateSufficiency を必須化する
- 不確実時は常に narrative へ倒す

### リスク 2: skill 形式が硬すぎて goal 逸脱

対策:

- styleReason を保持して検証対象にする
- goal alignment check を既存どおり維持する

### リスク 3: 候補不足判定が厳しすぎる

対策:

- 閾値は定数化し、テストで調整可能にする
- first rollout は保守的に narrative 偏重で開始

## 8. 完了条件

- planner が `responseStyle/styleReason/styleConfidence` を返せる
- style ガードが動作し、候補不足時に narrative へ降格する
- skill 形式の section contract 検証がある
- 上記テストケースが通る
- 既存の narrative ケースが退行していない
