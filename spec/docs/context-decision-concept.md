# Context Decision Concept

Status: draft
Created: 2026-06-09
Owner: ContextStill / NightWorkers knowledge cycle

## Purpose

`context_decision` は、コーディングエージェントがユーザー確認で停止せず、過去 Knowledge に基づいて断定的な実行判断を下すための MCP ツールである。

このツールの価値は「おすすめを提示すること」ではない。NightWorkers のような personal Devin 型エージェントが、実装途中の判断点でユーザーへ問い返す頻度を下げ、実行・検証・破棄・再試行まで自走できるようにすることである。

運用上の目標は、判断点の少なくとも 90% でユーザー回答を求めない状態にすることである。ユーザー回答を求める頻度が高い場合、このツールは NightWorkers の自走価値を削ぎ、導入解除の対象になり得る。

期待する返答は次のような形である。

```text
判断: A を採用してください。

私は過去の Knowledge から、この選択が正しいと判断します。
理由は A-E の証拠があるためです。

対する有力案は、現在の Knowledge からは存在しません。
このユーザーはこの状況で対案を選ばないと判断できます。
したがって確認を取らず、この方針で進めてください。
失敗した場合は PR を破棄し、この decisionId にフィードバックを返してください。
```

## Background

`context_compile` は、作業前に必要な Knowledge を検索・圧縮し、エージェントへ最小コンテキストとして渡す。

一方で NightWorkers が自走するうえで問題になるのは、コンテキスト不足だけではない。実装が進むほど、次のような判断点が頻繁に発生する。

- この設計方針で進めるか。
- ユーザーに確認すべきか。
- PR を継続するか、捨てるか。
- 方針を修正して続行するか。
- 失敗を実装ミスとして扱うか、判断ミスとして扱うか。

これらを毎回ユーザーに戻すと、自走性が落ちる。`context_decision` は、この停止点を Knowledge に基づいて裁定する。

## Decision

`context_decision` を、`context_compile` の output mode ではなく、独立した MCP ツールとして設計する。

- `context_compile`: 作業に使う文脈を集める。
- `context_decision`: 文脈と過去判断から、実行判断を下す。

`context_decision` は選択肢を横並びに提示しない。最終的には一つの判断を返す。

- 実行する。
- 棄却する。
- 方針を修正して実行する。
- rollback / discard する。
- 判断権限外としてユーザーへ escalate する。

`escalate` は通常分岐ではなく、安全弁である。まずは自走可能な分岐を探す。

NightWorkers 側では、`context_decision` は MCP 経由の optional integration に留める。NightWorkers 固有の task / artifact / PR / runtime state を ContextStill 側 schema に取り込まず、呼び出し時に判断点を渡す。

## Non-Goals

- `context_compile` の既存契約を変更しない。
- NightWorkers 側に ContextStill 専用 schema / repository / fallback を持たせない。
- ユーザーへ丁寧な比較表を返すためのツールにしない。
- Good/Bad 以上の詳細な人間採点を要求しない。
- LLM の自己申告 confidence だけで判断しない。
- 失敗 PR を単なる失敗として捨てず、判断学習の材料として扱う。

## Core Contract

入力例:

```ts
type ContextDecisionInput = {
  taskGoal: string;
  decisionPoint: string;
  proposedAction?: string;
  options?: Array<{
    id: string;
    label: string;
    tradeoff?: string;
  }>;
  autonomyLevel?: "low" | "medium" | "high";
  riskBudget?: "low" | "medium" | "high";
  availableRollback?: string;
  verificationPlan?: string;
  knowledgePolicy?: "optional" | "required";
};
```

出力例:

```ts
type ContextDecisionResult = {
  decision: "execute" | "reject" | "revise_and_execute" | "rollback" | "discard" | "escalate";
  selected?: string;
  rejected?: string[];
  mandate: string;
  confidence: number;
  agentMessage: string;
  guardrails: {
    mustVerify: string[];
    rollbackIf: string[];
    discardIf: string[];
  };
  evidence: Array<{
    knowledgeId: string;
    role:
      | "selected_support"
      | "rejected_alternative"
      | "user_preference"
      | "risk_warning"
      | "missing_counter_evidence";
    summary: string;
    weight: number;
  }>;
  unsupportedAlternatives: Array<{
    optionId?: string;
    reason: string;
  }>;
  feedbackHandle: {
    decisionId: string;
    expectedSignals: string[];
  };
};
```

`agentMessage` は LLM がそのまま判断として受け取れる文体にする。

良い文体:

- 結論を先に置く。
- 「おすすめ」ではなく「判断」として書く。
- 根拠を Knowledge と対応づける。
- 対案が支持されない場合は不採用と言い切る。
- 失敗時の rollback / discard 条件を明示する。

避ける文体:

- 「A がよさそうです」
- 「B もあり得ます」
- 「ユーザーに確認した方がよいかもしれません」
- 根拠のない一般論
- 検索できなかっただけのものを、証拠なしに否定すること

## Autonomy Model

`context_decision` は、低 confidence でもすぐにユーザーへ戻さない。

優先順位:

1. 実行できるなら実行する。
2. 危険なら、より小さい変更へ切って実行する。
3. 検証できないなら、検証手段を先に作って実行する。
4. 失敗したら rollback / PR discard して feedback を残す。
5. 再試行しても収束しない時だけ `escalate` する。

Confidence は「迷いの表明」ではなく、実行ポリシーのしきい値として扱う。

例:

- `>= 0.78`: `execute`
- `0.55 - 0.78`: 原則として一つ選ぶが、rollback 条件を強くする。
- `< 0.55`: まず `revise_and_execute` や検証追加を検討し、それでも無理なら `escalate`
- 過去の明確な失敗パターンに一致: `reject` または `discard`
- 検証不能かつ rollback 不能: `escalate`

初期運用では `autonomyLevel` を強めに扱う。`escalate` は 10% 未満に抑える目標を置き、低 confidence でも検証追加、scope 縮小、rollback 条件強化で進められる場合はユーザーへ戻さない。

## Calling Convention

NightWorkers は、ユーザーへ質問する前に `context_decision` を呼ぶ。ユーザー確認は最初の選択肢ではなく、`context_decision` が `escalate` を返した時の安全弁である。

初期の呼び出しポイント:

- 設計分岐が発生した時。
- ユーザーへ確認質問を出す直前。
- 実装方針を大きく変える直前。
- PR 作成前に、方針継続 / 修正 / 破棄を判断する時。
- テスト失敗やレビュー指摘後に、修正継続 / rollback / discard を判断する時。
- 同じ失敗が再試行で収束しない時。
- NightWorkers が Blocker で作業を止めた時。
- 設計書または TodoList が消化された後、Done ではない残タスクがある時。
- cron 起動のような自動再実行で、未完了 task / Todo / status を見直す時。

呼び出し側は、判断点を抽象化しすぎない。少なくとも task goal、現在の proposed action、選択肢、rollback 可否、verification plan、実行ログ上の失敗信号を渡す。

NightWorkers は会話履歴だけでなく、TodoList、実装前 / 実装中 / 完了などの task status を持つ。`Done` ではない状態で残タスクが残っている場合、`context_decision` は「ユーザーに確認するか」ではなく「残タスクを再開・縮小・破棄・escalate のどれで扱うか」を判断する。

`context_decision` は NightWorkers に実装詳細を命令しない。返すのは実行判断、根拠、guardrails、feedback handle である。

## Confidence Model

`confidence` は LLM の自己申告値ではない。LLM は説明文の整形や不足理由の推定に使ってよいが、主スコアは検索された Knowledge evidence を根拠に合成する。

ここでいう deterministic は、判断内容をハードコードするという意味ではない。Knowledge を使わずに固定ルールだけで決めることもしない。まず Knowledge を取得し、その Evidence の role、weight、適合度、feedback 履歴、coverage trace を決定的に集計して score 化する、という意味である。

初期算出では、次の signal を合成する。

- Evidence 件数。
- Evidence role の分布。
- Evidence の weight / dynamic score。
- Evidence の source trace の強さ。
- 過去の Good/Bad feedback。
- 似た decision type の成功 / 破棄 / override 履歴。
- appliesTo / domain / repo / technology の適合度。
- temporal relevance。古い Knowledge は、現在も同じ境界・技術・運用条件に当てはまる場合だけ強く扱う。
- 対案を支持する Evidence の有無。
- rollback / verification の有無。

強制ルール:

- `knowledgePolicy=required` で採用 Evidence が 0 件なら `confidence=0` とし、成功扱いしない。
- `context_compile` または retrieval が degraded / failed の場合、confidence を上げない。
- `missing_counter_evidence` は単独で confidence を上げない。
- LLM self confidence は補正または diagnostic として保存してよいが、主スコアにはしない。

現在の Knowledge は evidence がないものを Knowledge 化しない方針なので、`missing_counter_evidence` の過剰断定リスクは相対的に低い。ただし coverage trace は、対案が見つからなかったことを後から検証するために残す。

初期式は単純でよい。重要なのは、score の内訳を trace として残し、後から Good/Bad と system feedback で補正できることである。

`risk_warning` は単純な減点要素ではない。リスクを正しく検出し、rollback / discard 条件へ反映できている場合は、判断品質を上げる signal になり得る。初期式では role ごとの単純な加減算に固定せず、risk が guardrail として機能したかを feedback で評価する。

低 confidence の判断が成功した場合も、即座に大きく boost しない。強い検証結果、Human Good、または複数回の system success が揃った場合に限り、未知領域で有効だった Knowledge として加点する。

## Persistence

`context_decision` は、`context_compile_runs` と同様に過去の判断をすべて保存する。

判断履歴と feedback は分ける。

```text
context_decision_runs
- id
- task_goal
- decision_point
- selected_action
- rejected_actions
- confidence
- agent_message
- autonomy_level
- risk_budget
- status
- created_at
```

```text
context_decision_evidence
- decision_run_id
- knowledge_id
- role
- weight_at_decision
- summary
```

```text
context_decision_feedback
- id
- decision_run_id
- source: ai | system
- outcome
- inferred_reason
- affected_knowledge_ids
- suggested_adjustment
- created_at
```

```text
context_decision_human_feedback
- decision_run_id
- value: good | bad
- created_at
```

Knowledge との紐付けは、既存の候補・証拠系と混同しない。候補や cover evidence の永続識別が必要な場合は、`metadata.coverEvidenceResultId` / `metadata.sourceUri` を正とし、単に `knowledgeIds` だけを正規リンクとして扱わない。

## Feedback Model

人間 feedback は `Good` / `Bad` の二値だけにする。

- `Good`: この判断はユーザーの期待に合っていた。
- `Bad`: この判断はユーザーの期待に反した。

人間に詳細理由は求めない。詳細分類を要求すると運用されなくなる。

詳細理由は AI / system feedback が補完する。

- PR が通った。
- PR が破棄された。
- テストで失敗した。
- レビューで覆された。
- ユーザーが Bad を付けた。
- 実装方針は正しいが verification が不足していた。
- Knowledge は正しいが appliesTo / domain 適合が誤っていた。

`Bad` は即座に全根拠 Knowledge を減点しない。まず失敗理由を推定する。

Human Bad は重く扱う。人間が確認して「この PR / 判断は良くない」と判断した結果であるため、system success と矛盾しても final outcome では Human Bad を優先する。

## Knowledge Weight Update

Feedback は以後の Knowledge 重要度へ反映する。

ただし Good/Bad を単純に全 Evidence へ一括加点・減点しない。判断時の Evidence role ごとに扱う。

Role:

- `selected_support`: 採用判断を支えた根拠。
- `rejected_alternative`: 対案を棄却した根拠。
- `user_preference`: ユーザーの過去選好。
- `risk_warning`: 失敗や rollback 条件に関する警告。
- `missing_counter_evidence`: 対案を支持する Knowledge が見つからないこと。

`missing_counter_evidence` は、原則として中立証拠である。対案を支持する Knowledge が見つからないことは、対案が誤りであることを直接証明しない。

`missing_counter_evidence` を弱い positive として扱えるのは、次の条件を満たす場合だけである。

- 対象 domain / repo / decision type に十分な Knowledge 密度がある。
- 検索 query と appliesTo が明確で、探索範囲が狭い。
- 対案を支持する query を複数発行し、coverage trace を残している。
- coverage trace に、query、検索範囲、hit 件数、最大類似度、採用 / 不採用の理由が残っている。
- 過去の user preference または rejected_alternative が同じ方向を支持している。
- retrieval / embedding / DB 状態が degraded ではない。

Knowledge が薄い領域、探索範囲が曖昧な領域、または単発検索しか行っていない場合、`missing_counter_evidence` は confidence 加点に使わない。

反映ルール:

```text
Human Good:
- selected_support を加点する。
- user_preference を加点する。
- rejected_alternative が正しく棄却されていたなら加点する。
- risk_warning は結果に応じて維持または微加点する。

Human Bad:
- selected_support を即減点しない。
- final outcome としては system success より Human Bad を優先する。
- AI/system が失敗理由を推定する。
- 方針ミスなら selected_support を減点する。
- 検証不足なら verification policy を補正する。
- スコープ誤認なら appliesTo / domain 適合を減点する。
- 棄却ミスなら rejected_alternative 周辺を見直す。
```

反映結果は別テーブルに残す。

```text
context_decision_feedback_effects
- feedback_id
- knowledge_id
- effect: boost | penalize | neutral
- amount
- reason
- confidence
- applied_at
```

これにより、「なぜこの Knowledge の重要度が上がった / 下がったか」を後から追える。

`context_decision_feedback_effects` は、Knowledge と同様に自動運用サイクルを回す前提で扱う。Good/Bad や system feedback から effects を生成し、継続的に Knowledge ranking / importance へ戻す。

推奨フロー:

1. decision feedback を保存する。
2. AI/system が失敗理由と affected Knowledge を推定する。
3. `context_decision_feedback_effects` を生成する。
4. 自動適用できる effects は Knowledge ranking / importance に反映する。
5. 境界例や矛盾がある effects は review queue に送る。
6. 適用後の score change を trace に残す。

review queue は、必要なら既存の merge review queue を再利用してよい。ただし、初期設計の主軸は手動審査ではなく自動運用サイクルである。

自動適用で注意する点:

- 誤った Bad feedback で同一 session 内の判断が連鎖的に歪む。
- system success と human Bad の矛盾を解決する前に重みが変わる。
- PR discard の状態が確定する前に原因を誤分類しやすい。

このため、Human Good / Human Bad、PR discard のように意味が明確な effects は自動適用し、原因推定が曖昧なものだけ review queue に残す。git rollback や CI / review finding 由来の system feedback は将来拡張として扱う。

PR discard は NightWorkers から明示イベントとして送られる前提にしない。初期実装では git / GitHub CLI (`gh`) から PR state を判定し、decisionId と結びつけられる場合に `discarded_pr` feedback として扱う。git pull だけで PR の close / discard 状態を十分に判定できない場合は、`gh` を使う。

`importance` が最小値未満の候補は Knowledge 化しない。`context_decision` の feedback によって重要度が上がる場合も、昇格条件と根拠 trace を残す。

## Relationship To Context Compile

`context_compile` と `context_decision` は競合しない。

`context_compile`:

- 作業前の Knowledge retrieval。
- コンテキスト圧縮。
- selected items の保持。
- compile_eval による出力評価。

`context_decision`:

- 実行途中の判断点を裁定。
- 断定的な agentMessage を返す。
- 判断履歴を保存。
- Good/Bad と AI/system feedback を保存。
- feedback effects を Knowledge ranking / importance に戻す。

`context_decision` は必要に応じて `context_compile` を内部補助として使ってよい。ただし、返すものはコンテキストパックではなく判断である。

## Failure And Degraded Handling

Knowledge が required なのに採用根拠が 0 件の場合、成功扱いしない。

- `knowledgePolicy=required` で evidence 0 件: degraded
- `context_compile` が degraded / failed: doctor でシステム状態を確認する
- 判断根拠はあるが検証不能: verification を先に作るか `escalate`
- rollback 不能で高リスク: `escalate`
- PR が破棄された: `discarded_pr` として system feedback を残す

degraded / failed を無視して断定すると、誤った Knowledge 更新につながる。

## Decision Web UI

WebUI には、`context_compile` と並ぶ `decision` メニューを作る。画面構成は `context_compile` と同様に、左側へ判断要求の一覧、右側へ本文・回答に至った経緯・全証跡を表示する。

decision detail は別画面や補助概念ではない。`decision` 画面の右側 detail 領域そのものが、判断本文と全証跡を載せる場所である。

右側の詳細には次を載せる。

- どういった判断を求められたか。
- decision の結論。
- agentMessage。
- confidence と主要 Evidence。
- 回答に至った coverage trace。
- 採用 / 棄却された Knowledge evidence。
- unsupported alternatives と、それを棄却した理由。
- feedback effects と適用 / 未適用の状態。
- guardrails。
- rollback / discard 条件。
- Good / Bad の二値入力。

Good/Bad feedback UI はこの detail view に載せる。NightWorkers の timeline inline feedback は将来の補助導線として有効だが、初期の主導線は WebUI の decision detail である。

Good/Bad は人間の作業を増やさないための最小入力である。詳細理由は system logs、PR 状態、review 指摘、AI feedback から補完する。

## Review Questions

複数エージェントに確認したい論点:

1. `context_decision` は `context_compile` と独立した MCP tool として十分に差分があるか。
2. `agentMessage` の断定文体は、コーディングエージェントの停止を減らす設計として有効か。
3. Human feedback を Good/Bad に絞る設計は、学習データとして十分か。
4. Bad feedback から Knowledge を直接減点しない方針は妥当か。
5. Evidence role の分類は、初期実装として過不足がないか。
6. `missing_counter_evidence` を弱い positive として扱える Knowledge 密度の条件は十分か。
7. NightWorkers の呼び出しポイントは、自走性と呼び出し過多のバランスが取れているか。
8. PR discard feedback をどの精度で system feedback として自動回収できるか。

## Open Questions

- `confidence` の各 signal 係数と閾値をどう初期設定するか。
- Good/Bad 反映の `amount` を固定値にするか、Evidence weight と実行結果から算出するか。
- Human Bad と system success が矛盾した場合、原因推定をどの分類へ落とすか。
- 自動適用から review queue へ逃がす境界条件をどう定義するか。
- `escalate` を 10% 未満に抑える autonomy threshold をどう初期設定するか。
- `confidence` の初期式をどの程度まで deterministic に固定し、どこから学習補正に委ねるか。
- `missing_counter_evidence` を弱い positive にできる Knowledge 密度の閾値をどう定義するか。
- PR discard 以外の system feedback をいつ追加するか。
