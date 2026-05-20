# finalizeDistille 実装計画（runner 接続 / finalize / MCP evidence）

作成日: 2026-05-20
対象リポジトリ: `memory-router`
前提ドキュメント: `docs/cover-evidence-plan.md`、`docs/select-distillation-target-plan.md`

---

## レビュー結果

この計画は実装に進めるが、元案のままだと次の点で現行コードとずれる。

| 修正点 | 理由 | 本計画での扱い |
|---|---|---|
| `distill:sources` / `distill:vibe-memory` へ直接混ぜない | 現行 CLI は `assertLegacyDistillationEnabled()` 配下の legacy distillation であり、staged pipeline と責務が違う | 新規 shared runner を作り、既存 CLI は必要なら薄く委譲する |
| `source_fragments` へ必ず解決できる前提を外す | `coverEvidence` の source reference は `tokens:<from>-<to>` locator で、wiki file / vibe memory から直接読まれる。既存 `source_fragments.locator` と一致しない場合がある | 全 references は `knowledge_items.metadata` に保存し、`knowledge_source_links` は解決できた source fragment のみ作る |
| duplicate 防止に hash を使わない | `cover_evidence_results.id` と `knowledge_items.metadata.sourceUri` で十分に一意化できる | `sourceUri = cover-evidence-result://<id>` を upsert key にする |
| `context7` / `deepwiki` を実装対象に含める | `CoverEvidenceReference.kind` には既に `context7` / `deepwiki` があるが、tool handler には未追加 | distillation agent の MCP evidence tools として adapter / availability check を追加する |

hash / fingerprint 系フィールドは追加しない。識別と冪等性は既存 DB id、`cover_evidence_results.id`、`distillation_target_states.id`、`knowledge_items.metadata.sourceUri` で処理する。

---

## 現行コード前提

| 領域 | 現状 |
|---|---|
| `finalizeDistille` | `src/modules/finalizeDistille/domain.ts` は scaffold のみ。`distill:domain` の smoke 対象には入っている |
| `coverEvidence` | `src/modules/coverEvidence/domain.ts` が `runCoverEvidence({ id, write })` を提供し、`cover_evidence_results.id` に保存する |
| candidate id | `coverEvidence` の `id` は `find_candidate_results.id` と同じ値として扱われている |
| target metadata | `getFindCandidateResultById()` で candidate と `distillation_target_states.targetKind/targetKey/sourceUri` を join 取得できる |
| source references | `readSourceEvidenceForCandidate()` は `uri = target.sourceUri`、`locator = tokens:<from>-<to>` を references に入れる |
| knowledge upsert | `upsertKnowledgeFromSource()` は `knowledge_items.metadata ->> 'sourceUri'` で既存行を探す |
| source link | `linkKnowledgeToSourceFragment()` は `knowledge_source_links(knowledge_id, source_fragment_id)` を重複防止して保存する |
| distillation tools | 現在の built-in tools は `search_web` / `fetch_content` / `read_source_segment` / `read_vibe_segment` のみ |

---

## 目的

`selectDistillationTarget` → `findCandidate` → `coverEvidence` → `finalizeDistille` を 1 つの staged pipeline として接続し、target を手動 CLI 操作なしで `completed` / `skipped` / `paused` まで進める。

`finalizeDistille` は `cover_evidence_results.status = 'knowledge_ready'` の候補だけを `draft` knowledge に変換する。HITL 昇格、`draft` から `active` への承認、backpressure policy の再設計はこの計画に含めない。

---

## ドメイン境界

```
selectDistillationTarget
  - target の inventory / claim / phase / heartbeat / finish / pause を管理

findCandidate
  - target_state_id から source を読み、候補を find_candidate_results に保存

coverEvidence
  - find_candidate_results.id から候補を読み、根拠・重複・外部 evidence を判定
  - 結果を cover_evidence_results に保存

finalizeDistille
  - knowledge_ready の cover evidence result だけを draft knowledge に upsert
  - embedding と source reference metadata を保存

distillationPipeline runner
  - 上記 module を順に呼び、target の phase / outcome を確定
```

`finalizeDistille` は target claim や retry 判定を持たない。runner が orchestration を担当する。

---

## Phase 1: staged runner の追加

### 方針

legacy distillation CLI の内部に staged pipeline の phase logic を直接入れない。まず shared runner を新設し、CLI はその runner を呼ぶだけにする。

### 実装対象

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/modules/distillationPipeline/runner.ts` | NEW | target claim から finish / pause までを行う shared runner |
| `src/cli/distill-pipeline.ts` | NEW | runner の CLI entrypoint |
| `package.json` | MODIFY | `"distill:pipeline": "bun run src/cli/distill-pipeline.ts"` を追加 |

必要なら後続で `distill:sources` / `distill:vibe-memory` に `--staged` を追加して runner へ委譲する。ただし legacy path の既存挙動はこの計画では壊さない。

### Runner input

```ts
export type DistillationPipelineInput = {
  kind?: "auto" | "wiki" | "vibe";
  limit?: number;
  worker?: string;
  provider?: DistillationProviderSetting;
  distillationVersion?: string;
  refresh?: boolean;
  forceRefreshEvidence?: boolean;
  write: true;
};
```

### Runner flow

```
1. refresh=true なら refreshDistillationTargetInventory()
2. recoverStaleDistillationTargets()
3. releaseRetryablePausedDistillationTargets()
4. claimNextDistillationTargetState()
5. phase -> finding_candidate
6. runFindCandidate({ targetStateId, callerMode: "storage" })
7. candidate が 0 件なら skipped(no_candidate)
8. phase -> covering_evidence
9. insertedIds の各 candidate に runCoverEvidence({ id, write: true })
10. retryable failure だけなら paused(cover_evidence_retryable)
11. phase -> finalizing
12. knowledge_ready の結果だけ runFinalizeDistille({ coverEvidenceResultId, write: true })
13. outcome matrix に従い completed / skipped / paused / failed を確定
```

`find-candidate.ts` 自体には coverEvidence 連鎖を入れない。単体 CLI は単体責務のままにする。

---

## Phase 2: coverEvidence runner wrapper

### 実装対象

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/modules/coverEvidence/runner.ts` | NEW | runner から呼ぶ薄い wrapper |

```ts
export type CoverEvidenceRunnerInput = {
  targetStateId: string;
  findCandidateId: string;
  provider?: DistillationProviderSetting;
  forceRefreshEvidence?: boolean;
};

export type CoverEvidenceRunnerResult = {
  coverEvidenceResultId: string;
  findCandidateId: string;
  status: CoverEvidenceStatus;
  stage: CoverEvidenceStage;
  retryable: boolean;
  reason: string | null;
};

export async function runCoverEvidenceForCandidate(
  input: CoverEvidenceRunnerInput,
): Promise<CoverEvidenceRunnerResult>;
```

### 分類

| `coverEvidence.status` | runner の扱い |
|---|---|
| `knowledge_ready` | finalize 対象 |
| `duplicate` / `near_duplicate` / `insufficient` | reject として集計。retry しない |
| `tool_failed` / `provider_failed` / `parse_failed` | retryable として `paused` 候補 |

`parse_failed` は prompt / provider 応答に依存するため retryable とする。恒久的に壊れる場合は target の `attemptCount` / stale recovery 側で failed に落とす。

---

## Phase 3: finalizeDistille 実装

### 入力契約

```ts
export type FinalizeDistilleInput = {
  coverEvidenceResultId: string;
  write?: boolean;
};

export type FinalizeDistilleResult = {
  coverEvidenceResultId: string;
  knowledgeId: string | null;
  status: "stored" | "dry_run" | "rejected";
  embeddingStatus: "stored" | "unavailable" | "failed";
  sourceReferenceCount: number;
  sourceLinkCount: number;
  reason: string | null;
};
```

`write=false` は DB 書き込みを行わず、保存予定の candidate / metadata / source reference counts を返す。

### 実装対象

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/modules/finalizeDistille/domain.ts` | MODIFY | scaffold を本実装に置換 |
| `src/modules/finalizeDistille/repository.ts` | NEW | finalize 専用の軽量 repository helper |
| `src/cli/finalize-distille.ts` | NEW | 単体 CLI |
| `package.json` | MODIFY | `"finalize-distille": "bun run src/cli/finalize-distille.ts"` を追加 |

### 実装フロー

1. `selectCoverEvidenceResultById(coverEvidenceResultId)` で row を取得する。
2. `coverEvidenceResultFromRow(row)` で domain result に戻す。
3. `getFindCandidateResultById(coverEvidenceResultId)` で元 candidate と target 情報を取得する。
4. `result.status !== "knowledge_ready"` または `result.candidate === null` の場合は `status: "rejected"` を返す。単体 CLI では non-zero exit にする。
5. `embedOne(`${title}\n${body}`, "passage")` を試す。失敗時は `embeddingStatus: "failed"` とし、knowledge 保存は継続する。
6. `upsertKnowledgeFromSource()` で `draft` knowledge を保存する。
7. 保存後、解決できる source fragment だけ `knowledge_source_links` に保存する。
8. audit log に finalize の成功 / embedding 失敗 / source link count を残す。

### Knowledge upsert

`upsertKnowledgeFromSource()` へ渡す `sourceUri` は次の固定形式にする。

```ts
const sourceUri = `cover-evidence-result://${coverEvidenceResultId}`;
```

metadata には最低限次を保存する。

```ts
{
  sourceUri: "cover-evidence-result://<coverEvidenceResultId>",
  coverEvidenceResultId: "<coverEvidenceResultId>",
  findCandidateResultId: "<coverEvidenceResultId>",
  targetStateId: "<targetStateId>",
  targetKind: "wiki_file" | "vibe_memory",
  targetKey: "<targetKey>",
  sourceDocumentUri: "<distillation_target_states.source_uri>",
  references: [...],
  duplicateRefs: [...],
  toolEvents: [...],
  finalizedBy: "finalizeDistille",
  finalizedAt: "<iso8601>"
}
```

`coverEvidenceResultId` で別途存在確認してもよいが、冪等性の主軸は `metadata.sourceUri` での `upsertKnowledgeFromSource()` に寄せる。hash / fingerprint は使わない。

### Source references と links

`cover_evidence_results.references` は全件 `knowledge_items.metadata.references` に残す。

`knowledge_source_links` は次を満たす場合だけ作る。

1. `reference.kind === "source"`
2. `reference.evidenceRole === "supports_candidate"`
3. `sources.uri === reference.uri` が見つかる
4. `source_fragments.locator === reference.locator` が見つかる

`locator` が `tokens:<from>-<to>` の場合、既存 `source_fragments.locator` と一致しないことがある。この場合は link を作らず、metadata reference として保持する。存在しない source fragment を finalize 側で新規作成しない。

`web` / `context7` / `deepwiki` / `knowledge` references は `knowledge_source_links` の対象外にし、metadata に保存する。将来、外部 evidence 用の link table が必要になったら別計画で追加する。

### Repository helper

```ts
export async function selectKnowledgeByFinalizeSourceUri(
  sourceUri: string,
): Promise<{ id: string } | null>;

export async function findSourceFragmentByReference(params: {
  uri: string;
  locator?: string;
}): Promise<{ sourceFragmentId: string } | null>;
```

`findSourceFragmentByReference()` は解決できない場合に `null` を返す。これを finalize failure にしない。

---

## Phase 4: runner outcome matrix

runner は candidate 単位の結果を集計し、target outcome を一度だけ確定する。

| 状況 | target status | outcomeKind | metadata |
|---|---|---|---|
| candidate 0 件 | `skipped` | `no_candidate` | `candidateCount: 0` |
| 全 candidate が `duplicate` / `near_duplicate` / `insufficient` | `skipped` | `all_rejected` | rejected counts / reasons |
| `knowledge_ready` が 1 件以上 finalize 成功 | `completed` | `knowledge_finalized` | `knowledgeIds`, status counts, embedding status counts |
| `knowledge_ready` があるが finalize が全件失敗 | `failed` | `finalize_failed` | finalize errors |
| ready がなく retryable failure がある | `paused` | `cover_evidence_retryable` | retryable ids / reasons |
| ready finalize 成功と retryable failure が混在 | `completed` | `knowledge_finalized_with_retryable_rejections` | finalized ids と retryable ids の両方 |

`completed` にするのは、少なくとも 1 件の draft knowledge が保存された場合だけにする。embedding failure は `completed` を妨げないが、metadata と audit log には残す。

---

## Phase 5: `context7` / `deepwiki` MCP evidence tools

`context7` / `deepwiki` は distillation agent の tool として組み込む。ただし、MCP サーバが存在しない環境でも通常の source / web evidence 判定は止めない。

### 実装対象

| ファイル | 種別 | 内容 |
|---|---|---|
| `src/modules/distillation/distillation-tools.service.ts` | MODIFY | tool name / definition / handler に `context7` / `deepwiki` を追加 |
| `src/modules/distillation/mcp-evidence-tools.service.ts` | NEW | MCP tool availability check と呼び出し adapter |
| `src/modules/coverEvidence/mcp-evidence.service.ts` | NEW | coverEvidence から MCP evidence を補助 stage として実行 |
| `src/modules/coverEvidence/domain.ts` | MODIFY | web evidence 後に MCP evidence を試す分岐を追加 |
| `src/modules/audit/audit-log.service.ts` | MODIFY | MCP evidence 用 audit event を追加 |
| `test/cover-evidence.test.ts` | MODIFY | MCP 有無と references 追加の回帰テスト |

### Tool contract

`distillationToolNames` に次を追加する。

```ts
export const distillationMcpToolNames = ["context7", "deepwiki"] as const;
```

tool result は既存 `DistillationToolResult` に合わせる。

```ts
{
  callId: string;
  name: "context7" | "deepwiki";
  ok: boolean;
  content: string;
  metadata?: {
    uri?: string;
    title?: string;
    locator?: string;
    server?: "context7" | "deepwiki";
    unavailable?: boolean;
  };
  error?: string;
}
```

MCP server が未設定または応答不可の場合は `ok: false`、`metadata.unavailable: true` を返し、`runCoverEvidence` 全体は失敗させない。

`recordDistillationToolAudit()` は現状 `distillationEvidenceToolNames` だけを audit 対象にしている。`context7` / `deepwiki` を tool event として追跡するため、`distillationMcpEvidence` のような audit event を追加し、MCP tool でも `toolName`、`ok`、`durationMs`、`uri`、`server`、`unavailable`、`error` が記録されるようにする。

### coverEvidence integration

`runMcpEvidence()` は次の条件で呼ぶ。

- candidate が外部 API / library / framework / public docs に依存する主張を含む
- web evidence だけでは confidence が不足する
- または provider が MCP evidence を tool call した

MCP stage で得た evidence は `references` に次の形で保存する。

```ts
{
  kind: "context7" | "deepwiki",
  uri: "<tool metadata uri or server-specific uri>",
  locator: "<optional locator>",
  title: "<optional title>",
  note: "mcp evidence verified external claim",
  evidenceRole: "external_verification"
}
```

`context7` / `deepwiki` の失敗だけを理由に `knowledge_ready` を `insufficient` へ落とさない。source support、dedupe、web evidence の既存判定を優先する。

---

## Phase 6: CLI / smoke

### `finalize-distille`

```bash
bun run finalize-distille -- --id <cover_evidence_result_id>
bun run finalize-distille -- --id <cover_evidence_result_id> --write
```

出力は JSON のみ。

```json
{
  "coverEvidenceResultId": "...",
  "knowledgeId": "...",
  "status": "stored",
  "embeddingStatus": "stored",
  "sourceReferenceCount": 2,
  "sourceLinkCount": 1
}
```

### `distill:pipeline`

```bash
bun run distill:pipeline -- --kind auto --limit 1 --write
bun run distill:pipeline -- --kind wiki --limit 5 --write
bun run distill:pipeline -- --kind vibe --limit 5 --write
```

`--write` なしの dry-run は最初の実装では不要。dry-run を入れる場合は全 module で DB write を確実に止める必要があるため、別 slice に分ける。

### domain smoke

既存 `bun run distill:domain -- --domain finalizeDistille` は scaffold message ではなく、次を確認する smoke に変える。

- `coverEvidenceResultId` が渡されていない場合は `prepared` を返す
- id が渡され、DB に `knowledge_ready` result がある場合は dry-run finalize を実行する
- non-ready result は `rejected` として報告する

---

## テスト計画

### Unit tests

| テスト | 期待値 |
|---|---|
| `finalizeDistille` stores draft knowledge | `knowledge_ready` から `draft` knowledge が作られる |
| finalize is idempotent | 同じ `coverEvidenceResultId` を 2 回処理しても同じ `knowledgeId` が返る |
| non-ready result is rejected | `duplicate` / `insufficient` は knowledge を作らない |
| embedding failure is non-blocking | embedding が失敗しても draft は保存され、`embeddingStatus: "failed"` |
| source refs are preserved | 全 references が `metadata.references` に残る |
| source links are optional | fragment が解決できる reference だけ `knowledge_source_links` が作られる |
| MCP unavailable is non-blocking | `context7` / `deepwiki` unavailable でも `coverEvidence` は通常完了する |
| MCP references are stored | MCP success 時に `kind: "context7"` / `"deepwiki"` reference が保存される |

### Integration / smoke

```bash
bun run test:unit
bun run distill:domain -- --domain finalizeDistille --input-json '{"coverEvidenceResultId":"<id>"}'
bun run distill:pipeline -- --kind wiki --limit 1 --write
bun run distill-target:status
bun run verify
```

DB が必要なケースは `MEMORY_ROUTER_RUN_DB_TESTS=1` の integration test に寄せる。CI / local verify で DB が使えない環境を壊さない。

---

## 受け入れ基準

- `bun run finalize-distille -- --id <id> --write` で `knowledge_ready` result が draft knowledge になる。
- 同じ id を再実行しても duplicate knowledge が作られない。
- `cover_evidence_results.status !== 'knowledge_ready'` は knowledge を作らない。
- `source` / `web` / `knowledge` / `context7` / `deepwiki` references が metadata に残る。
- 解決可能な source fragment だけ `knowledge_source_links` が作られる。
- `bun run distill:pipeline -- --kind auto --limit 1 --write` で target が `completed` / `skipped` / `paused` のいずれかに確定する。
- `tool_failed` / `provider_failed` / `parse_failed` だけの場合は `paused` になり、再試行できる。
- `context7` / `deepwiki` が存在しない環境でも通常判定が通る。
- `context7` / `deepwiki` が利用可能な環境では references に MCP evidence が残る。
- `bun run verify` が通る。

---

## 最初に避けること

- `finalizeDistille` で `draft` を `active` に昇格しない。
- embedding 保存失敗を理由に knowledge 保存を止めない。
- `tokens:<from>-<to>` locator から無理に `source_fragments` を作らない。
- `find-candidate.ts` に後続 step orchestration を入れない。
- legacy `distill:sources` / `distill:vibe-memory` の既存挙動を staged runner 実装で壊さない。
- MCP evidence の不在を pipeline 全体の失敗にしない。
- hash / fingerprint / 生 LLM 出力保存用の大きなフィールドを追加しない。
