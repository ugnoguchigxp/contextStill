# Register Candidate Bulk Implementation Plan

> Status: planning draft
> Date: 2026-05-26
> Scope: `register_candidate` family の bulk 登録対応
> Review score: 9.4 / 10 after minimal-wrapper review

## 目的

LLM が複数の durable lesson / rule / procedure 候補を見つけたとき、1 件ずつ MCP call せずにまとめて登録できる経路を追加する。

既存の単発 `register_candidate` は維持する。bulk は一時メモではなく、従来と同じく「蒸留 pipeline に渡す knowledge candidate」の登録である。

## 判断

MVP では既存 `register_candidate` を overload せず、**新しい plural tool `register_candidates`** を追加する。

理由:

- 既存 `register_candidate` の input/output 契約を完全に維持できる。
- bulk 用の余計な `shared` / defaults 構造を作らず、MCP 公開面は `{ items: [...] }` の最小 wrapper にできる。
- LLM にとって `register_candidate` は 1 件、`register_candidates` は複数件という使い分けが明確。
- bulk result は per-item status を返す必要があり、単発 result と shape が違う。

再レビューでの固定事項:

- `shared` は作らない。
- MCP 公開面だけ `{ items: [...] }` の最小 wrapper にする。
- service / API 内部は bare array を受けてよい。
- `type`, `technologies`, `changeTypes`, `domains`, `repoPath`, `repoKey` は任意。蒸留 pipeline が後段で補えるものを登録時点で強制しない。

## 非ゴール

- `register_candidate` の既存 result shape を変えない。
- bulk 登録を atomic all-or-nothing として保証しない。
- bulk 登録で `knowledge_items` draft を同期作成しない。
- bulk 登録時に LLM による再要約や重複除去を追加しない。
- `session_memo` の `put_many` と同じ責務にしない。session memo は一時メモ、register candidate は durable candidate である。

## 現在の前提

- `register_candidate` MCP は `src/mcp/tools/knowledge.tool.ts` にある。
- 単発 input schema は `registerCandidateInputSchema`。
- service は `src/modules/registerCandidate/register-candidate.service.ts` の `registerCandidate`。
- `registerCandidate` は DB transaction で `distillation_target_states` と `find_candidate_results` を作成し、その後 `enqueueFindingJob` を呼ぶ。
- `text` に複数 candidate JSON が含まれる場合、現在は最初の candidate だけを登録し、warning を返す。

## Tool Contract

### `register_candidates`

説明:

```txt
Bulk-register lightweight rule/procedure candidates for later distillation. Use when multiple durable lessons should be registered from the same task.
```

入力:

```ts
{
  items: Array<{
    title?: string;
    body?: string;
    text?: string;
    type?: "rule" | "procedure";
    confidence?: number;
    importance?: number;
    appliesTo?: Record<string, unknown>;
    general?: boolean;
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
    repoPath?: string;
    repoKey?: string;
    metadata?: Record<string, unknown>;
  }>;
}
```

制約:

- `items` は 1..10 件。
- MCP tool arguments は object である必要があるため、公開 MCP 面だけ `{ items: [...] }` の最小 wrapper にする。
- `registerCandidatesToolInputSchema` は strict object とし、top-level は `items` 以外を受け付けない。
- service / API 内部は bare array `RegisterCandidateInput[]` を受けてよい。
- 各 item は単発 `register_candidate` と同じく `body` または `text` のどちらかだけを最小要件にする。
- `title`, `type`, `confidence`, `importance`, `technologies`, `changeTypes`, `domains`, `repoPath`, `repoKey`, `appliesTo`, `metadata` はすべて任意。蒸留 pipeline が後段で補えるものを bulk 登録時点で強制しない。
- `title` がない場合は既存単発 registration と同じ推論を使う。
- `type` がない場合は既存単発 registration との互換のため内部正規化では default type を使ってよい。ただし item metadata に `inputTypeProvided: false` を付け、後段の蒸留で type を見直せるようにする。`type` がある場合は `inputTypeProvided: true` を付ける。
- service は bulk call ごとに `bulkBatchId` を生成し、各 item の metadata/origin に `bulkBatchId`, `bulkIndex`, `bulkCount`, `bulkSource: "mcp_register_candidates"` を付ける。
- body/text の最大長は MVP では単発と同じ。長さ制限を入れる場合は単発 schema と同時に入れる。

出力:

```ts
{
  status: "bulk_candidates_registered" | "bulk_candidates_partial" | "bulk_candidates_failed";
  registeredCount: number;
  failedCount: number;
  items: Array<{
    index: number;
    status: "candidate_registered" | "candidate_failed";
    title?: string;
    type?: "rule" | "procedure";
    targetStateId?: string;
    findCandidateResultId?: string;
    findingJobId?: string;
    sourceUri?: string;
    warnings?: string[];
    error?: string;
  }>;
  next: "distillation_pipeline";
}
```

## Error / Atomicity

bulk は **per-item best effort** とする。

理由:

- 登録後に `enqueueFindingJob` という副作用があり、DB insert と queue enqueue を完全 atomic にしにくい。
- 候補同士は独立した lesson であり、1 件の失敗で残り全部を捨てるより、成功分を残す方が実用的。
- LLM は per-item result を見て、失敗分だけ修正して再送できる。

ただし、schema validation は call 全体に対して先に行う。`items` が空、11 件以上、いずれかの item で `body/text` が欠ける、といった入力エラーは DB 書き込み前に tool error とする。

registration 中の service error は item 単位で `candidate_failed` にする。成功済み item は rollback しない。

## Service 設計

追加:

- `registerCandidatesToolInputSchema`: MCP wrapper `{ items: [...] }` を検証する。
- `registerCandidatesBulkInputSchema`: service / API 用の bare array `RegisterCandidateInput[]` を検証する。
- `registerCandidatesBulk(input: RegisterCandidateInput[]): Promise<RegisterCandidatesBulkResult>`
- `registerCandidatesBulkResultSchema` は必要なら shared schemas に追加

実装方針:

1. MCP tool は `registerCandidatesToolInputSchema` で wrapper object を validate し、service へ `items` array だけを渡す。
2. service は `registerCandidatesBulkInputSchema` で bare array を validate する。
3. 各 item を既存 `registerCandidate` に渡せる shape に正規化する。
4. `bulkBatchId` と item index metadata を付与する。
5. item を順番に処理する。
6. 成功/失敗を `items[index]` に記録する。
7. `registeredCount` / `failedCount` と aggregate `status` を返す。

parallel 登録は MVP ではしない。queue と DB への負荷、ログ順序、失敗時の再現性を優先して sequential にする。

## MCP 実装タスク

1. `src/shared/schemas/knowledge.schema.ts`
   - `registerCandidatesToolInputSchema` と `registerCandidatesBulkInputSchema` を追加する。
2. `src/modules/registerCandidate/register-candidate.service.ts`
   - `RegisterCandidatesBulkInput` / `RegisterCandidatesBulkResult` 型を追加する。
   - `registerCandidatesBulk` を追加する。
3. `src/mcp/tools/knowledge.tool.ts`
   - `registerCandidatesTool` を追加する。
   - `inputSchema` は `{ items: [...] }` の最小 wrapper にする。
4. `src/mcp/tools/index.ts`
   - v2 exposed tools に `registerCandidatesTool` を追加する。
   - v1 callable/exposed に追加するかは、MCP v2 既定化に合わせて判断する。MVP は v2 exposed のみでよい。
5. `docs/mcp-tools.md`
   - tool count と `register_candidates` contract を追加する。
6. `src/shared/locales/initial-instructions.ts`
   - 長文追加はしない。
   - 必要なら既存 `register_candidate` 行を「複数ある場合は `register_candidates`」の短い補足へ変更する。
7. `src/modules/doctor/doctor.constants.ts` と MCP contract fixtures
   - `register_candidates` を primary required tool にするか optional exposed tool にするかを実装時に固定する。
   - MVP では primary required tool に追加せず、optional exposed tool として扱う方針を推奨する。

## Test Plan

Unit:

- `register-candidate.service.test.ts`
  - bulk registers two candidates successfully
  - bulkBatchId and bulkIndex metadata are attached
  - type / technologies / repoPath are optional in each item
  - missing type adds `inputTypeProvided: false` metadata
  - provided type adds `inputTypeProvided: true` metadata
  - one failing item returns `bulk_candidates_partial`
  - more than 10 items fails before DB write

MCP:

- `mcp.tools.test.ts`
  - `register_candidates` calls `registerCandidatesBulk`
  - bulk response includes `registeredCount`, `failedCount`, per-item status
  - existing `register_candidate` tests remain unchanged

Schema:

- `schemas.test.ts`
  - accepts valid 1..10 items
  - rejects empty `items`
  - rejects item without `body` or `text`
  - MCP wrapper schema accepts only `{ items }` and rejects extra top-level keys
  - service schema accepts bare array
  - accepts items without `title`, `type`, `technologies`, `changeTypes`, `domains`, `repoPath`, or `repoKey`

Contract:

- `mcp.contract.test.ts`
  - exposed tool list includes `register_candidates`
  - `register_candidate` schema remains backward compatible

## UX Guidance For Agents

Use `register_candidate` when registering one durable lesson.

Use `register_candidates` when the same task produced multiple independent reusable lessons. Keep each item focused; do not put unrelated lessons into one body.

Do not use bulk registration to dump session notes. Use `session_memo` for temporary notes and only promote durable lessons to candidate registration.

## Open Questions

- Should bulk default to best effort forever, or add `mode: "best_effort" | "stop_on_error"` later?
- Should item-level `dedupeKey` be added before registration, or leave duplicate detection to the distillation pipeline?
- Should `text` containing multiple parsed candidates become a hard warning in bulk mode, nudging agents to split into `items`?
