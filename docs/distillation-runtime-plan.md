# 共通 Knowledge Distillation Runtime 計画

## 方針

`vibe_memory` と `source/wiki` は入力元が違うだけで、蒸留 runtime は共通にする。

- 入力を evidence として扱う。
- Gemma4 に compile-ready な `rule / procedure` だけを作らせる。
- 外部主張や URL 参照がある場合は `search_web` / `fetch_content` tool で検証する。
- 保存前 validation と embedding 必須化を共通化する。
- 保存結果は `knowledge_items.status = "draft"` にする。

これにより、Graph は入力元に依存せず `knowledge_items.embedding` の距離と `relations` を見るだけでよい。

## 共通 runtime の責務

追加済みの共有モジュール:

- `src/modules/distillation/distillation-runtime.service.ts`
- `src/modules/distillation/distillation-tools.service.ts`
- `src/modules/distillation/distillation-prompts.ts`

runtime は次を受け取る。

```ts
type DistillationInput = {
  sourceKind: "vibe_memory" | "wiki";
  sourceId: string;
  sourceUri?: string;
  sourceFragmentIds: string[];
  content: string;
  localEvidence: Array<{
    kind: "vibe_memory" | "agent_diff" | "wiki";
    id: string;
    uri?: string;
    locator?: string;
    content: string;
  }>;
};
```

runtime は次を返す。

```ts
type DistillationCandidate = {
  type: "rule" | "procedure";
  title: string;
  body: string;
  confidence: number;
  importance: number;
  score: number;
  sourceRefs: Array<{ kind: string; id?: string; uri?: string; locator?: string }>;
  evidenceRefs: Array<{ kind: "local" | "web"; uri?: string; url?: string; contentHash?: string }>;
  rejected?: boolean;
  rejectionReason?: string;
};
```

## Tool loop

local-llm API は tool definitions を受け取れるが、tool 実行はクライアント責務。memory-router の共通 runtime が tool call を実行する。

1. Gemma4 に `tools` と `tool_choice: "auto"` を渡す。
2. Gemma4 が `search_web` または `fetch_content` を要求する。
3. memory-router が tool を実行する。
4. tool result を `role: "tool"` として戻す。
5. 最大 round 数まで繰り返す。
6. 最終応答は strict JSON candidates だけ受け付ける。

共通 tool:

- `search_web(query)`
  - 外部仕様、ライブラリ挙動、標準、公開ドキュメント、URL の現況確認に使う。
- `fetch_content(url)`
  - search result または入力に含まれる URL の本文取得に使う。

実行制約:

- search result snippet だけでは保存根拠にしない。
- 外部主張を含む candidate は最低 1 件の fetched evidence が必要。
- fetch に失敗した外部主張は保存しない。
- tool results はそのまま knowledge に貼らず、短い rule/procedure に蒸留する。

## 共通 System Context

Gemma4 に常に渡す共通 system context:

```text
You distill coding-agent evidence into compile-ready knowledge.
The output is not a transcript summary, document summary, changelog, or note.
The output must be reusable knowledge that helps context_compile decide what to include for a future coding task.

Allowed knowledge types are exactly: rule and procedure.

A rule is a durable constraint, preference, invariant, or decision.
A procedure is a reusable sequence of steps, command flow, operational skill, or review checklist.

Each candidate must be small enough to fit inside a compiled context pack.
Assign confidence and importance as 0 to 100 values (integers preferred).
Assign each candidate a score from 0 to 1 for overall preservation value.
Only emit candidates whose score is at least MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE.
Do not include below-threshold candidates in the candidates array; return an empty candidates array instead.
Prefer one decision or one procedure per candidate.
Reject candidates that are too broad, too vague, only historical, only interesting, or not actionable.

If a claim depends on external behavior, current public documentation, a library/API specification, or a URL in the evidence,
use search_web and fetch_content before producing the candidate.
Do not invent missing details.
Do not preserve fetched text as a long note.
Normalize fetched evidence into a concise rule/procedure that can guide a coding agent.

Every emitted candidate must include source refs and evidence refs.
If evidence is insufficient, return an empty candidates array or mark the candidate as rejected.
Return strict JSON only.
```

入力元ごとの追加 context:

- `vibe_memory`
  - raw conversation は信頼済み knowledge ではない。
  - ユーザーの継続的 preference、repo 運用 rule、再利用できる手順だけを残す。
  - 会話中の外部 API や URL について断定する場合は tool で再確認する。
  - agent diff は source code 全文ではなく、手順や制約の根拠として使う。
- `wiki`
  - wiki は人間が書いた source だが、そのまま knowledge ではない。
  - 長い説明、背景、記事、設計メモを compile-ready な rule/procedure に圧縮する。
  - source 内 URL や外部仕様への言及は fetch してから候補化する。

## 保存前 validation

共通 validation:

- `type` は `rule / procedure` のみ。
- `title` と `body` は空でない。
- `body` は 300-900 chars を目安にする。
- `body` は raw evidence の丸写しではない。
- `sourceRefs` が入力 evidence に対応している。
- 外部主張を含む candidate は fetched evidence を持つ。
- `confidence` と `importance` は `0..100` に clamp する。
- `score` は `0..1` に clamp し、`MEMORY_ROUTER_DISTILLATION_MIN_CANDIDATE_SCORE` 未満は保存しない。
- embedding 生成に失敗した candidate は保存しない。
- rejected candidate は run metadata に残しても `knowledge_items` には保存しない。

## 入力元別の保存先

vibe memory:

- run table: `vibe_memory_distillation_runs`
- source metadata: `source: "vibe_memory_distillation"`
- source refs: `vibeMemoryId`, `agentDiffEntryIds`

source/wiki:

- run table: `source_distillation_runs`
- evidence table: `source_distillation_evidence`
- source metadata: `source: "source_distillation"`
- source refs: `sourceId`, `sourceFragmentIds`, `sourceUri`
- link table: `knowledge_source_links`

## 実装順

1. `distillation-runtime` 共通モジュールを追加する。Done
2. 既存 vibe memory distillation を共通 runtime に載せ替える。Done
3. tool loop を runtime に追加する。Done
4. source/wiki distillation を同じ runtime で追加する。Done
5. validation / embedding / run summary を共通化する。Done
6. Doctor に vibe/source 両方の distillation health を出す。Done
