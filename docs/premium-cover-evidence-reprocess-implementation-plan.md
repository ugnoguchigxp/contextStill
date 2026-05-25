# Premium Cover Evidence 再評価 実装計画

> 作成日: 2026-05-25
> スコープ: 調査・計画のみ。この文書では実装コードを変更しない。
> 目標品質: 実装着手前の計画として 9/10。

## 目的

Candidates 画面から、過剰 reject の疑いがある Cover Evidence 結果をユーザー操作で再評価キューに戻し、次回の Cover Evidence を local LLM ではなく Cloud API provider class で処理できるようにする。

UI 上の名前は `Premium再評価` とする。内部実装では Azure OpenAI 固定にせず、`cloud_api` / `cloud_api_reprocess` のような provider class / reprocess mode として扱う。

この機能で防ぎたい失敗は次のもの。

1. Candidate 画面で高 importance / confidence になり得る候補が `insufficient` として rejected になっている。
2. ユーザーが再評価したい candidate を見つけても、現状は UI から安全に再キューできない。
3. 単に `reprocess_requested` に戻しても、次の worker が再び local LLM / Gemma 系で処理して同じ過剰 reject を繰り返す可能性がある。

## 用語

| 用語 | 意味 |
| --- | --- |
| Premium再評価 | Candidates 画面に表示する操作名。ユーザーが押すボタン。 |
| `cloud_api` | Azure OpenAI / OpenAI API / Bedrock など、local LLM ではない cloud provider class。 |
| `cloud_api_reprocess` | Cover Evidence を cloud provider class で再処理する reprocess mode。 |
| `reprocess_requested` | 既存の Cover Evidence retryable checkpoint status。 |
| target | `distillation_target_states` の 1 行。findCandidate / coverEvidence / finalize の処理単位。 |
| candidate | `find_candidate_results` の 1 行。Cover Evidence result は同じ id で `cover_evidence_results` に保存される。 |

## 成功条件

- Candidates 画面の rejected / retryable candidate から `Premium再評価` を要求できる。
- 要求は監査可能で、対象 candidate id、以前の status / reason、要求時刻、mode が DB と audit に残る。
- 再キュー後の pipeline は対象 candidate を `reprocess_requested` として再実行する。
- `cloud_api_reprocess` 要求された candidate は local LLM に流れず、設定済み cloud provider のみで Cover Evidence を実行する。
- Azure OpenAI 固定ではなく、OpenAI 本家 API / Azure OpenAI / Bedrock を provider class として扱える。
- 同じ candidate への二重押下は idempotent に処理され、重複キューや metadata 汚染を起こさない。
- 失敗時に API / UI / audit から理由を追える。

## 非目標

- rejected 全件の自動再評価。
- すべての reject 判定を cloud provider で常時処理する設定変更。
- Azure OpenAI deployment の個別選択 UI。
- Cloud API usage/cost dashboard の新設。
- importance / confidence の採点ロジック刷新。
- findCandidate の再実行。

importance / confidence の reject 時保存は別問題として重要だが、この計画の主軸は「ユーザーが選んだ candidate を cloud provider class で再評価できるキュー操作」に限定する。

## 確認済みの事実

### Candidate API

- `api/modules/candidates/candidates.routes.ts` は現状 `GET /api/candidates` のみを提供している。
- Candidate 単位の mutation endpoint はまだない。
- `api/modules/candidates/candidates.types.ts` の `CandidateListItem` は `id`, `targetStateId`, `cover`, `knowledge`, `outcome` を持つため、UI から再評価対象を判定する材料はある。

### Candidate UI

- `web/src/modules/admin/components/candidates.page.tsx` は `useQuery` で `fetchCandidateItems()` を呼び、5 秒 interval で一覧を更新している。
- 現状は `useMutation` / `useQueryClient` を使っていない。
- 行クリックで詳細行を開くため、ボタンを行内に置く場合は `event.stopPropagation()` が必要。
- 展開詳細には `targetStateId`, `findCandidateResultId`, `coverEvidenceResultId`, `knowledgeId`, `references`, `toolEvents` が表示されている。最初の配置場所はここが安全。

### Frontend repository

- `web/src/modules/admin/repositories/admin.repository.ts` には `requestJson<T>(url, method, body?)` があり、mutation API 追加に使える。
- `fetchCandidateItems()` は `/api/candidates` を叩いているため、同じ module に `requestPremiumCandidateReprocess()` を追加するのが自然。

### 既存 reprocess service

- `src/modules/coverEvidence/reprocess-rejected.service.ts` は batch CLI 向けだが、必要な再キュー操作の大半を既に持つ。
- 既存 service は対象 row を `cover_evidence_results.status = "reprocess_requested"` にし、`toolEvents` に `reprocess_rejected_candidate` を追記する。
- 対応する `distillation_target_states` を `status = "pending"`, `phase = "selected"`, lock 解除、attempt reset に戻す。
- audit event として `COVER_EVIDENCE_REPROCESS_REQUESTED` が既に存在する。

### Pipeline

- `src/modules/coverEvidence/runner.ts` と `src/modules/distillationPipeline/runner.ts` は `reprocess_requested` を retryable status として扱う。
- `runOrResumeCandidates()` は既存 cover result が retryable の場合に `runCoverEvidenceForCandidate()` を再実行する。
- `forceRefreshEvidence` がない場合、未実行 candidate と retryable candidate だけを次 batch に入れる。
- 現在の pending selection は target 内の retryable candidate をまとめて見るため、特定 candidate のボタン操作を厳密に再現するには、metadata の requested ids による filter / priority が必要。

### Provider routing

- `src/modules/coverEvidence/domain.ts` は `resolveCoverEvidenceRoutes()` を使い、`sourceSupport`, `externalEvidence`, `mcpEvidence` それぞれの provider / fallback を解決している。
- `providerOverride` と `providerFallbackMode` は既に存在する。
- `docs/cover-evidence-provider-fallback-implementation-plan.md` は Azure 固定ではなく provider adapter / route 境界を保つ方針を示している。
- 現状の `taskRouting.coverEvidence` には `sourceSupport`, `externalEvidence`, `mcpEvidence` の route があるが、`cloud_api` 専用 route はまだない。

### Metadata

- `src/shared/schemas/distillation-target-metadata.schema.ts` の web ingest metadata parser は `.passthrough()` であり、target metadata に新しいキーを入れても既存 parser は壊れにくい。
- ただし `cloud_api_reprocess` の意味を runner が読むなら、専用 parser を追加した方が安全。

## 問題の分解

### 問題 1: UI から再評価できない

Candidate 一覧は rejected / retryable を見つけるには十分だが、再評価 action がない。

### 問題 2: 再キューだけでは provider が保証されない

`cover_evidence_results.status = "reprocess_requested"` に戻すだけだと、次の worker は pipeline input / runtime settings に従う。設定次第では local LLM が再び処理し、過剰 reject を繰り返す。

### 問題 3: target 単位 queue と candidate 単位 UI の粒度が違う

pipeline は target を claim し、target 内の candidate を処理する。一方、UI 操作は candidate 単位である。metadata で対象 id を明示しないと、同じ target 内の別 retryable candidate まで処理される可能性がある。

### 問題 4: Cloud API 未設定時の挙動を決める必要がある

`cloud_api` は provider class であり、実際に使える provider は runtime settings と環境変数に依存する。API 押下時点で hard block するか、queue 登録して worker 側で失敗させるかを決める必要がある。

### 問題 5: コストが発生する操作である

Premium再評価は cloud provider を使うため、誤クリックや連打を避ける UI と idempotency が必要。

## 推奨アーキテクチャ

### 全体フロー

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Candidates UI
  participant API as Candidates API
  participant S as Reprocess Service
  participant DB as PostgreSQL
  participant W as Distillation Worker
  participant CE as Cover Evidence
  participant CP as Cloud Provider

  U->>UI: Premium再評価を押す
  UI->>API: POST /api/candidates/:id/premium-reprocess
  API->>S: requestCloudApiCoverEvidenceReprocess(candidateId)
  S->>DB: cover result を reprocess_requested に更新
  S->>DB: target を pending / selected に戻す
  S->>DB: metadata と audit を保存
  API->>UI: queued / already_queued
  W->>DB: pending target を claim
  W->>DB: metadata の requested candidate ids を読む
  W->>CE: cloud_api policy で対象 candidate のみ実行
  CE->>CP: OpenAI / Azure OpenAI / Bedrock の cloud route を使用
  CE->>DB: 新しい cover evidence result を保存
```

### Durable metadata

`distillation_target_states.metadata` に以下を追加する。

```json
{
  "coverEvidenceReprocessRequest": {
    "mode": "cloud_api",
    "requestedAt": "2026-05-25T00:00:00.000Z",
    "requestedBy": "user",
    "findCandidateResultIds": ["..."],
    "coverEvidenceResultIds": ["..."],
    "forceRefreshEvidence": true,
    "providerPolicy": "cloud_api",
    "status": "requested"
  }
}
```

既存の `reprocessRejectedCandidates` metadata key とは分ける。batch CLI の repair intent と、UI からの premium/cloud intent を混同しないため。

### Cover result tool event

`cover_evidence_results.toolEvents` には以下の event を append する。

```json
{
  "name": "cloud_api_cover_evidence_reprocess_requested",
  "ok": true,
  "metadata": {
    "previousStatus": "insufficient",
    "previousStage": "final",
    "previousReason": "rule_body_not_actionable",
    "requestedAt": "2026-05-25T00:00:00.000Z",
    "mode": "cloud_api"
  }
}
```

### Reason / outcome

- cover result reason: `reprocess_requested:cloud_api:<oldReason>`
- target `lastOutcomeKind`: `manual_cloud_api_cover_evidence_reprocess`
- target `lastError`: `reprocess_requested:cloud_api:<oldReason>`
- audit event: 既存 `COVER_EVIDENCE_REPROCESS_REQUESTED` を使い、payload に `mode: "cloud_api"` を含める

## 実装計画

### Phase 1: Candidate 単位 reprocess service

追加候補:

- `src/modules/coverEvidence/reprocess-candidate.service.ts`
- `src/modules/coverEvidence/reprocess-candidate.types.ts` は必要なら分離

公開関数:

```ts
export type CoverEvidenceReprocessMode = "cloud_api";

export type RequestCoverEvidenceReprocessInput = {
  findCandidateResultId: string;
  mode: CoverEvidenceReprocessMode;
  actor?: "user" | "system";
  forceRefreshEvidence?: boolean;
};

export type RequestCoverEvidenceReprocessResult = {
  findCandidateResultId: string;
  coverEvidenceResultId: string;
  targetStateId: string;
  status: "queued" | "already_queued";
  mode: CoverEvidenceReprocessMode;
  previousStatus: string;
  previousReason: string | null;
};
```

service の責務:

1. `find_candidate_results` を id で取得する。
2. 同じ id の `cover_evidence_results` を取得する。
3. 同じ id の knowledge が既に保存済みなら reject する。
4. target が `running` なら `409 target_running` に相当する domain error を返す。
5. cover status が `insufficient`, `provider_failed`, `tool_failed`, `parse_failed`, `reprocess_requested` の場合だけ許可する。
6. 既に同じ mode の `reprocess_requested` なら `already_queued` として成功扱いにする。
7. transaction で cover result と target state を更新する。
8. audit event を記録する。

許可 status:

| cover status | 許可 | 理由 |
| --- | --- | --- |
| `insufficient` | yes | 主対象。過剰 reject を cloud で再判定する。 |
| `provider_failed` | yes | provider failure は retryable であり cloud retry に適する。 |
| `tool_failed` | yes | tool/read/search failure は retryable。cloud で改善するとは限らないが再処理対象として妥当。 |
| `parse_failed` | yes | retryable。provider 変更で改善する可能性がある。 |
| `reprocess_requested` | yes/idempotent | 連打対策。 |
| `near_duplicate` / `duplicate` | no 初期版 | 重複判定を cloud が覆す用途ではない。必要なら後続で追加。 |
| `knowledge_ready` | no 初期版 | 既に ready。UI 上は別操作にする。 |

DB 更新の擬似コード:

```ts
await tx.update(coverEvidenceResults).set({
  status: "reprocess_requested",
  reason: prefixedCloudApiReason(oldReason),
  toolEvents: appendJsonbEvent(...),
  updatedAt: requestedAt,
}).where(and(
  eq(coverEvidenceResults.id, findCandidateResultId),
  sql`${coverEvidenceResults.status} in (...)`
));

await tx.update(distillationTargetStates).set({
  status: "pending",
  phase: "selected",
  lockedBy: null,
  lockedAt: null,
  heartbeatAt: null,
  nextRetryAt: null,
  attemptCount: 0,
  completedAt: null,
  lastOutcomeKind: "manual_cloud_api_cover_evidence_reprocess",
  lastError: prefixedCloudApiReason(oldReason).slice(0, 500),
  metadata: sql`${distillationTargetStates.metadata} || ${JSON.stringify(metadata)}::jsonb`,
  updatedAt: requestedAt,
}).where(eq(distillationTargetStates.id, targetStateId));
```

注意点:

- `coverEvidenceResultId` は実質 `findCandidateResultId` と同じ id で扱われている。
- 既存 batch service の `rowToItem()` も同じ前提で `coverEvidenceResultId` を組み立てている。
- completed target を pending に戻すことは許可する。rejected candidate を再処理するには必要。
- running target は初期版では拒否する。lock 競合を避けるため。

### Phase 2: API route

変更対象:

- `api/modules/candidates/candidates.routes.ts`
- 必要なら `api/modules/candidates/candidates.types.ts`

endpoint:

```http
POST /api/candidates/:id/premium-reprocess
Content-Type: application/json

{
  "mode": "cloud_api",
  "forceRefreshEvidence": true
}
```

初期版では `mode` は省略可にしてもよいが、内部では常に `cloud_api` に正規化する。

レスポンス:

```json
{
  "result": {
    "findCandidateResultId": "...",
    "coverEvidenceResultId": "...",
    "targetStateId": "...",
    "status": "queued",
    "mode": "cloud_api",
    "previousStatus": "insufficient",
    "previousReason": "rule_body_not_actionable"
  }
}
```

エラー設計:

| 条件 | status | reason |
| --- | --- | --- |
| candidate がない | 404 | `candidate_not_found` |
| cover result がない | 409 | `cover_evidence_result_missing` |
| knowledge 保存済み | 409 | `knowledge_already_exists` |
| target running | 409 | `target_running` |
| status 非対応 | 409 | `cover_evidence_status_not_reprocessable` |
| cloud provider 未設定 | 409 または warning | 下記の設計判断を参照 |

API error は既存の reason-first 方針に合わせ、UI が短く表示できる `reason` を返す。

### Phase 3: Cloud API provider policy

ここが必須。これがないとボタンは「再キュー」にはなるが「Premium再評価」にはならない。

追加候補:

- `src/modules/coverEvidence/provider-policy.ts`
- または `src/modules/coverEvidence/domain.ts` 内の private helper から始める

型:

```ts
export type CoverEvidenceProviderPolicy = "default" | "cloud_api";
```

`cloud_api` policy のルール:

1. 対象 provider は `openai`, `azure-openai`, `bedrock`。
2. `local-llm` は除外する。
3. `auto` は初期版では除外する。`auto` が local を選ぶ可能性を排除できないため。
4. route ごとに `[route.provider, ...route.fallback]` を作り、cloud provider だけを残す。
5. 先頭を primary、残りを fallback として `resolveCoverEvidenceProviderRoute()` 相当へ渡す。
6. cloud provider が 1 件もない場合は `cloud_api_provider_unavailable` を返す。

擬似コード:

```ts
const cloudProviders = new Set(["openai", "azure-openai", "bedrock"]);

function resolveCloudApiRoute(route: RuntimeSettingsRoute) {
  const candidates = [route.provider, ...route.fallback].filter((provider) =>
    cloudProviders.has(provider),
  );
  if (candidates.length === 0) {
    throw new CoverEvidenceProviderPolicyError("cloud_api_provider_unavailable");
  }
  return {
    provider: candidates[0],
    fallback: candidates.slice(1),
  };
}
```

`providerOverride` との優先順位:

| 入力 | 優先 |
| --- | --- |
| target metadata に `providerPolicy: "cloud_api"` | cloud_api が優先 |
| CLI `--provider` のみ | 従来の provider override |
| 両方あり | candidate 単位の cloud_api が優先 |

理由:

- ユーザーが Candidate UI で `Premium再評価` を押した意図は candidate 固有のもの。
- worker 側の global provider override に負けると、UI 操作の意味が崩れる。

`providerFallbackMode`:

- `cloud_api_reprocess` では原則 fallback enabled。
- 既存 `--single-provider` が指定されていても、metadata に `providerFallbackMode: "fallback"` を保存し、対象 candidate では cloud fallback を使う。
- operator debugging で単一 cloud provider を使いたい場合は、将来の API body に `providerFallbackMode` を追加する。

### Phase 4: Pipeline runner の candidate filter / policy 適用

変更対象:

- `src/modules/distillationPipeline/runner.ts`
- `src/shared/schemas/distillation-target-metadata.schema.ts` または新規 parser
- `src/modules/coverEvidence/runner.ts`
- `src/modules/coverEvidence/domain.ts`

やること:

1. target metadata から `coverEvidenceReprocessRequest` を parse する。
2. `mode === "cloud_api"` かつ `status === "requested"` のとき、requested candidate ids を読む。
3. `runOrResumeCandidates()` 内の pending candidate selection で、requested ids を優先する。
4. requested ids がある場合、初期版ではその ids だけを処理する。
5. `runCoverEvidenceForCandidate()` に `providerPolicy: "cloud_api"` と `forceRefreshEvidence: true` を渡す。
6. 対象 candidate の処理完了後、target metadata の request status を `consumed` または `completed` に更新する。

`runCoverOnce()` の変更イメージ:

```ts
const reprocessRequest = parseCoverEvidenceReprocessRequest(target.metadata);
const providerPolicy = reprocessRequest.requestedIds.has(findCandidateId)
  ? "cloud_api"
  : "default";

coverResult = await runCoverEvidenceForCandidate({
  targetStateId: target.id,
  findCandidateId,
  provider: providerPolicy === "default" ? input.provider : undefined,
  providerPolicy,
  providerFallbackMode:
    providerPolicy === "cloud_api" ? "fallback" : input.providerFallbackMode,
  forceRefreshEvidence: providerPolicy === "cloud_api" ? true : input.forceRefreshEvidence,
  signal,
});
```

pending candidate selection の変更:

```ts
const requestedIds = reprocessRequest?.status === "requested"
  ? new Set(reprocessRequest.findCandidateResultIds)
  : null;

const pendingCandidateIds = requestedIds
  ? [...requestedIds].filter((id) => candidateIds.includes(id))
  : [...neverRunCandidateIds, ...retryableCandidateIds];
```

この filter により、ボタンを押した candidate だけを処理できる。

metadata cleanup:

- 処理が `knowledge_ready`, `insufficient`, `provider_failed`, `tool_failed`, `parse_failed` のいずれで終わっても、対象 request は `completed` として記録する。
- worker が途中で abort した場合は `requested` のまま残し、次回 claim で再試行する。
- target に複数の requested ids を持たせる余地は残すが、初期 UI は 1 candidate ずつ要求する。

### Phase 5: UI integration

変更対象:

- `web/src/modules/admin/repositories/admin.repository.ts`
- `web/src/modules/admin/components/candidates.page.tsx`
- 必要なら `web/src/modules/admin/components/candidates.page.shared.tsx`
- `test/components/admin/knowledge-candidates-page.test.tsx`

repository:

```ts
export type CandidatePremiumReprocessResponse = {
  result: {
    findCandidateResultId: string;
    coverEvidenceResultId: string;
    targetStateId: string;
    status: "queued" | "already_queued";
    mode: "cloud_api";
    previousStatus: string;
    previousReason: string | null;
  };
};

export async function requestCandidatePremiumReprocess(
  id: string,
): Promise<CandidatePremiumReprocessResponse> {
  return requestJson<CandidatePremiumReprocessResponse>(
    `/api/candidates/${encodeURIComponent(id)}/premium-reprocess`,
    "POST",
    { mode: "cloud_api", forceRefreshEvidence: true },
  );
}
```

UI:

- `useMutation` と `useQueryClient` を導入する。
- 成功時に `queryClient.invalidateQueries({ queryKey: ["candidates"] })` を実行する。
- ボタンは展開詳細の metadata block の上部または右側に配置する。
- label は `Premium再評価`。
- icon は lucide の `CloudCog`, `CloudLightning`, `RefreshCw` のいずれか。利用可能性を確認して選ぶ。
- ボタン押下時は `event.stopPropagation()`。
- mutation 中は disabled。
- `outcome === "rejected"` または `outcome === "retryable"` かつ `!item.knowledge` のときだけ enabled。
- `item.cover?.status === "reprocess_requested"` の場合は `再評価キュー済み` と表示する。

誤クリック対策:

- 初期版は expanded row 内にのみ表示し、一覧の通常行には出さない。
- さらに必要なら軽量 confirm modal を追加する。
- `window.confirm` は実装が簡単だが UI 一貫性は低い。既存 `AdminModalShell` を使う方が望ましい。

表示例:

```tsx
<Button
  type="button"
  size="sm"
  variant="outline"
  disabled={!canPremiumReprocess(item) || premiumReprocess.isPending}
  onClick={(event) => {
    event.stopPropagation();
    premiumReprocess.mutate(item.id);
  }}
>
  <CloudCog size={14} />
  Premium再評価
</Button>
```

### Phase 6: optional Settings 表示

初期版では必須ではない。

ただし、後続で Settings の Task Routing に `cloud_api` policy preview を出すと運用しやすい。

例:

- `coverEvidence.cloudApiPreview.sourceSupport`
- `coverEvidence.cloudApiPreview.externalEvidence`
- `coverEvidence.cloudApiPreview.mcpEvidence`
- local provider が混ざらないかを Doctor / Settings で確認

初期実装では route 設定を増やさず、既存 route の provider/fallback から cloud provider を抽出する方が変更範囲が小さい。

## 設計判断

### Cloud provider 未設定時

推奨: API 時点では 409 にする。

理由:

- Premium再評価はユーザーが明示的に押す操作であり、押した直後に「queued」と出るなら Cloud API 実行可能性が必要。
- queue 登録だけ成功して worker で失敗すると、ユーザーにはコスト操作をしたつもりなのに何も改善しない。
- 409 の reason を `cloud_api_provider_unavailable` にすれば、Settings / Doctor へ誘導できる。

ただし設定が worker 実行前に変わる可能性もあるため、API preflight は `ensureRuntimeSettingsLoaded()` と route 抽出だけに留め、実 provider の live connectivity test まではしない。

### 対象 status

初期版は `insufficient`, `provider_failed`, `tool_failed`, `parse_failed`, `reprocess_requested` に限定する。

`near_duplicate` / `duplicate` は別設計にする。重複判定を cloud provider で覆すと dedupe policy の意味が変わり、誤登録のリスクがあるため。

### target 内の sibling retryable

推奨: Premium再評価では requested ids のみに絞る。

理由:

- UI 操作は candidate 単位。
- sibling retryable まで cloud API に流すと、ユーザーが意図していないコストが発生する。
- 検証も対象 id のみの方が明確。

### `forceRefreshEvidence`

推奨: `cloud_api_reprocess` では常に `true`。

理由:

- 既存 result が retryable であっても、source/external/mcp evidence の取得や LLM 判定を cloud policy でやり直すことが目的。
- cache hit で既存 result を返すと、UI の「再評価」操作として成立しない。

### importance / confidence 保存

今回の機能とは分けるが、重要な隣接課題として残す。

現状、reject path で `candidate: null` になると importance / confidence が保存されない経路がある。高スコア候補の過剰 reject を後から発見しやすくするには、reject result にも `candidate` か `qualityAssessment` 相当を残す設計が必要。

この計画の実装後、次の改善候補として扱う。

- `insufficient` でも LLM が candidate を返しているなら importance / confidence を保持する。
- source support で LLM 前に落ちる場合は base candidate confidence / source support confidence を別 field に残す。
- Candidate UI で `rejected but high score` filter を追加する。

## Migration 要否

初期版では DB schema migration は不要。

理由:

- `cover_evidence_results.status` は既存 `reprocess_requested` を使う。
- `toolEvents` は JSONB array。
- `distillation_target_states.metadata` に JSONB metadata を追加できる。
- audit event type は既に存在する。

将来、複数 reprocess request の履歴や provider policy queue を強く扱うなら、専用 table が必要になる可能性がある。

候補:

```sql
create table cover_evidence_reprocess_requests (
  id uuid primary key default gen_random_uuid(),
  find_candidate_result_id uuid not null references find_candidate_results(id),
  cover_evidence_result_id uuid not null references cover_evidence_results(id),
  target_state_id uuid not null references distillation_target_states(id),
  mode text not null,
  status text not null,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);
```

ただし初期版では重い。既存 queue との整合を優先し、metadata で始める。

## テスト計画

### Service tests

追加候補:

- `test/cover-evidence-reprocess-candidate.service.test.ts`

ケース:

1. `insufficient` candidate を `cloud_api` で queue すると cover result が `reprocess_requested` になる。
2. target が `completed` でも `pending/selected` に戻る。
3. lock fields / heartbeat / nextRetryAt / completedAt / attemptCount が reset される。
4. metadata に `coverEvidenceReprocessRequest` が残る。
5. toolEvents に `cloud_api_cover_evidence_reprocess_requested` が append される。
6. audit event `COVER_EVIDENCE_REPROCESS_REQUESTED` が記録される。
7. 同じ candidate の再押下は `already_queued`。
8. knowledge 保存済み candidate は 409 相当の domain error。
9. running target は 409 相当の domain error。
10. `duplicate` / `near_duplicate` は初期版では reject。

### API tests

既存 candidates route test に追加、または `test/api.routes.candidates.test.ts` を新設する。

ケース:

1. `POST /api/candidates/:id/premium-reprocess` が service を呼び、`result` を返す。
2. body なしでも `mode: "cloud_api"` として扱う。
3. domain error が 409 / 404 と reason に変換される。
4. `id` は route param から取り、body id は受け付けない。

### Provider policy tests

追加候補:

- `test/cover-evidence-provider-policy.test.ts`

ケース:

1. route `[local-llm, azure-openai]` は `azure-openai` のみになる。
2. route `[local-llm, openai, bedrock]` は `openai` primary / `bedrock` fallback になる。
3. route `[local-llm]` は `cloud_api_provider_unavailable`。
4. `auto` は初期版では除外される。
5. provider policy ありの場合、CLI provider override より cloud policy が優先される。

### Pipeline tests

既存 `test/distillation-pipeline.tail.test.ts` 付近に追加する。

ケース:

1. target metadata の requested ids があると、その candidate だけ `runCoverEvidenceForCandidate()` に渡る。
2. requested candidate には `providerPolicy: "cloud_api"` と `forceRefreshEvidence: true` が渡る。
3. sibling retryable candidate は同じ tick では処理されない。
4. abort / timeout 時は request metadata が requested のまま残る。
5. 完了時は metadata status が completed になる。

### UI tests

既存:

- `test/components/admin/knowledge-candidates-page.test.tsx`

ケース:

1. rejected candidate の展開詳細に `Premium再評価` ボタンが出る。
2. stored knowledge candidate ではボタンが disabled または非表示。
3. retryable candidate でもボタンが出る。
4. ボタン押下で repository function が candidate id 付きで呼ばれる。
5. 成功後 candidates query が invalidate/refetch される。
6. `reprocess_requested` の場合は `再評価キュー済み` 表示になる。

### Verification commands

実装後の最低ライン:

```bash
bun run typecheck
bun run lint
bunx vitest run test/cover-evidence-reprocess-candidate.service.test.ts
bunx vitest run test/cover-evidence-provider-policy.test.ts
bunx vitest run test/distillation-pipeline.tail.test.ts
bunx vitest run test/components/admin/knowledge-candidates-page.test.tsx
```

最終ライン:

```bash
bun run verify
```

DB 絡みを integration で見る場合:

```bash
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/memory_router_test} \
MEMORY_ROUTER_RUN_DB_TESTS=1 \
bun test --timeout=30000 --max-concurrency=1 test/*.integration.test.ts
```

## 実装順序

1. Provider policy helper を実装する。
   - Cloud provider 抽出の contract を先に固定する。
   - ここがない UI button は意味が弱い。
2. Candidate reprocess service を実装する。
   - DB 更新、idempotency、audit を閉じる。
3. API route を追加する。
   - service の domain error を HTTP status / reason に変換する。
4. Pipeline runner に metadata parser / requested id filter / providerPolicy pass-through を入れる。
   - Cloud API で処理される保証を作る。
5. UI repository と Candidates page に mutation button を追加する。
   - 最初は expanded row のみ。
6. Tests を追加し、最後に `bun run verify`。

## 最小スライス

最初の PR / commit で狙う範囲:

- `cloud_api` provider policy helper
- Candidate 単位 reprocess service
- `POST /api/candidates/:id/premium-reprocess`
- runner の requested id filter
- Candidates expanded row の `Premium再評価` button
- unit / route / UI tests

含めないもの:

- Settings UI の新規 cloud route editor
- reprocess request 専用 table
- reject 時 importance / confidence 保存の大規模修正
- near_duplicate / duplicate の再評価

## Blockers / 先に決めること

1. Cloud provider 未設定時は API 409 でよいか。
   - 推奨は 409。
2. `auto` provider を cloud_api 対象に含めない方針でよいか。
   - 推奨は含めない。
3. running target は拒否でよいか。
   - 推奨は拒否。
4. UI 初期版は expanded row のみでよいか。
   - 推奨は expanded row のみ。
5. `near_duplicate` / `duplicate` を初期対象外にしてよいか。
   - 推奨は対象外。

## リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| Cloud API 指定が runner に届かない | 再び local LLM で reject される | providerPolicy を explicit に渡す test を置く |
| target 内 sibling candidate まで処理される | 想定外の cloud usage | requested ids filter を入れる |
| completed target requeue が既存 flow と衝突 | queue lifecycle が不安定になる | service test で completed -> pending を固定する |
| 二重押下 | 重複 toolEvents / metadata | `already_queued` idempotency |
| Cloud provider 未設定 | queued なのに処理不能 | API 409 preflight |
| UI 行クリックとボタン押下が競合 | 誤展開 / 操作ミス | `event.stopPropagation()` |
| reject 時 score が失われ続ける | 高価値候補の発見性が低い | 別計画で score retention を扱う |

## 完了条件

- `Premium再評価` ボタンから対象 candidate の reprocess request が登録できる。
- DB 上で対象 `cover_evidence_results.status` が `reprocess_requested` になる。
- target metadata に `coverEvidenceReprocessRequest.mode = "cloud_api"` が残る。
- pipeline 実行時に対象 candidate だけが `providerPolicy: "cloud_api"` で処理される。
- audit に `COVER_EVIDENCE_REPROCESS_REQUESTED` が記録される。
- UI は成功後に candidate list を更新する。
- provider policy / service / API / pipeline / UI の focused tests が通る。
- `bun run verify` が通る。

## 自己レビュー

### 初期案の弱点

評点: 7.2/10

- UI button と API は見えていたが、Cloud API provider を保証する runner 側の設計が弱かった。
- target 単位 queue と candidate 単位 UI の粒度差を十分に扱っていなかった。
- cloud provider 未設定時の挙動が曖昧だった。
- completed target の requeue と running target の扱いが未確定だった。

### 改善後

評点: 9.0/10

改善した点:

- `cloud_api` provider policy を独立した必須要件にした。
- requested candidate ids による runner filter を計画に入れ、sibling candidate の誤処理を防いだ。
- API/service/runner/UI/test の各実装対象ファイルと責務を分けた。
- metadata / audit / reason / outcome の durable contract を具体化した。
- cloud provider 未設定、running target、duplicate status の判断を明記した。
- 最小スライスと後続課題を分離した。

残る 1 点:

- 実 DB での cloud provider availability check は、実装時に runtime settings / doctor の現状態を再確認する必要がある。
- reject 時 importance / confidence 保存は隣接課題として残るため、この計画だけでは「高スコア候補の発見性」までは完全には解決しない。

この残課題は Premium再評価機能の第一スライスを妨げるものではないため、実装計画としては 9/10 と判断する。
