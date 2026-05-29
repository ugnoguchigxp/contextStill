# Implementation Plan: Synchronous Registration of Provided Candidates to Covering Queue

## 1. 目的とゴール
`mcp register-candidate`（`provided_candidate`）は、ユーザーやMCPツールから直接提供された「確定済みの候補（Candidate）」をシステムに登録する処理です。
そのため、LLMを呼び出して生のドキュメントから候補を抽出する「探索（finding）」フェーズは実質的に不要です。

しかし、旧設計ではデータフローの画一的な一貫性のために、このジョブを一旦 `pending` 状態で `finding_candidate_queue` に登録し、非同期のバックグラウンドワーカーがデキューして `covering` に転送する非同期モデルを採用していました。このモデルは以下のような大きなデメリットをもたらしていました。

* **無駄な順番待ち（ブロッキング）:** 他の重い探索ジョブ（Vibe Memoryなど数千件）がキューに詰まっていると、一瞬で終わるはずのMCP登録ジョブの転送処理すらも順番待ちが発生し、即座に次の検証フェーズ（`covering`）へ移れませんでした。
* **無駄なワーカー処理:** ワーカーがわざわざキューを CLAIM し、探索をスキップしてレコードを移し替えるだけの無駄なプロセスがバックグラウンドで発生していました。

本計画のゴールは、`provided_candidate` の登録処理をリクエスト時点で **完全に同期的かつ瞬時に `covering_evidence_queue` に直接投入する** ようにリファクタリングし、登録完了までの待ち時間を **完全ゼロ化** することです。

---

## 2. 変更内容とアプローチ

### 2.1 データベース制約の考慮
`found_candidates` テーブル of `finding_job_id` には `notNull()` 制約（UUID型）が設定されているため、ジョブID自体は必須です。
スキーマ変更（マイグレーション）という大掛かりな変更を避け、最も安全かつ破壊的変更の少ない手段をとるため、**「最初から完了状態 (`status = 'completed'`) のジョブとして `finding_candidate_queue` に同期登録し、そのIDを紐づけて同期的に `covering` キューへ直投入する」** アプローチを採用します。

これにより、非同期のワーカーがこの `finding` ジョブをデキューして処理することは物理的になくなり、中継の待ち時間とオーバーヘッドが完全にゼロ化されます。

### 2.2 ユニーク制約の衝突ハンドリング
`finding_candidate_queue` には `finding_candidate_queue_unique_idx`（`inputKind`, `sourceKind`, `sourceKey`, `distillationVersion`）のユニーク制約が存在します。同一の候補が再登録された場合に備え、以下の `onConflict` 戦略を採用します：

| テーブル | ユニーク制約 | 戦略 | 理由 |
|----------|-------------|------|------|
| `finding_candidate_queue` | `(inputKind, sourceKind, sourceKey, distillationVersion)` | `onConflictDoUpdate` → `status = 'completed'`, 各フィールド上書き | 再登録時にも最新のペイロードで完了状態を維持する |
| `found_candidates` | `(findingJobId, candidateIndex)` | `onConflictDoUpdate` → 各フィールド上書き | 既存の `upsertFoundCandidateRow` パターンと一致 |
| `covering_evidence_queue` | `(foundCandidateId)` | `onConflictDoUpdate` → `status = 'pending'` にリセット | 再登録時に covering を再処理させる |

---

## 3. 具体的な実装変更点

### 3.1 `register-candidate.service.ts` のリファクタリング
ファイルパス: [register-candidate.service.ts](file:///Users/y.noguchi/Code/memoryRouter/src/modules/registerCandidate/register-candidate.service.ts)

`registerCandidate` 関数のデータベーストランザクション（`legacy`）を拡張し、新キューのデータ構築もすべてトランザクション内で同期的に処理します。

#### 【変更前】
1. トランザクション内でレガシーな `distillationTargetStates` と `findCandidateResults` をインサート。
2. トランザクションの外で、非同期に `enqueueFindingJob` を実行（`status = 'pending'`, `priority = 90`）。

#### 【変更後】
データベーストランザクション内で、以下をすべて同期的に実行します。

1. **レガシー状態のインサート**（互換性維持）。
2. **`finding_candidate_queue` への同期インサート:**
   * `status` は最初から `'completed'`
   * `completedAt` は `now`
   * `lastOutcomeKind` は `'provided_candidate_registered'`
   * `priority` は `90`
   * 重複時: `onConflictDoUpdate` で `status = 'completed'` に上書き
3. **`found_candidates` への同期インサート:**
   * 上記で生成したジョブIDを `findingJobId` にセット。
   * 重複時: `onConflictDoUpdate` で内容を上書き
4. **`covering_evidence_queue` への同期インサート:**
   * `status` は `'pending'`
   * `priority` は `90` (最優先)
   * `providerPolicy` は `'default'`
   * 重複時: `onConflictDoUpdate` で `status = 'pending'` にリセット（再処理）
5. **`appendQueueEvent` による監査ログ記録:**
   * Finding ジョブの同期完了イベント
   * Covering ジョブの投入イベント

トランザクションの外にあった非同期 `enqueueFindingJob` の呼び出しは完全に削除され、関数全体のインポートからも排除します。

#### 【インポート変更】
```diff
-import { enqueueFindingJob } from "../queue/core/index.js";
+import {
+  findingCandidateQueue,
+  foundCandidates,
+  coveringEvidenceQueue,
+} from "../../db/schema.js";
+import { appendQueueEvent } from "../queue/core/events.js";
```

---

### 3.2 変更コードイメージ（トランザクション内部）
```typescript
  const result = await db.transaction(async (tx) => {
    // 1. レガシー用状態の作成
    const [target] = await tx.insert(distillationTargetStates).values({ ... }).returning();
    const [candidate] = await tx.insert(findCandidateResults).values({ ... }).returning();

    // 2. Queue V2用の finding ジョブを完了状態で作成（重複時は上書き）
    const [findingJob] = await tx
      .insert(findingCandidateQueue)
      .values({
        inputKind: "provided_candidate",
        sourceKind: "knowledge_candidate",
        sourceKey: candidateId,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        payload: {
          title: normalized.title,
          body: normalized.body,
          type: normalized.type,
          origin: compactOrigin(parsed, normalized),
          legacyTargetStateId: target.id,
          legacyFindCandidateResultId: candidate.id,
        },
        metadata: {
          source: "mcp_register_candidate",
          registeredAt: now.toISOString(),
          legacyTargetStateId: target.id,
          legacyFindCandidateResultId: candidate.id,
        },
        priority: 90,
        status: "completed",       // 最初から完了状態
        completedAt: now,          // 完了日時をセット
        lastOutcomeKind: "provided_candidate_registered",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          findingCandidateQueue.inputKind,
          findingCandidateQueue.sourceKind,
          findingCandidateQueue.sourceKey,
          findingCandidateQueue.distillationVersion,
        ],
        set: {
          sourceUri,
          payload: { ... },       // 上記と同じ payload
          metadata: { ... },      // 上記と同じ metadata
          priority: 90,
          status: "completed",
          completedAt: now,
          lastOutcomeKind: "provided_candidate_registered",
          updatedAt: now,
        },
      })
      .returning();

    if (!findingJob) throw new Error("failed to create V2 finding job");

    // 3. Queue V2用の found_candidates を作成（重複時は上書き）
    const [foundCandidate] = await tx
      .insert(foundCandidates)
      .values({
        findingJobId: findingJob.id,
        candidateIndex: 0,
        type: normalized.type,
        title: normalized.title,
        content: normalized.body,
        origin: compactOrigin(parsed, normalized),
        metadata: {
          sourceKind: "knowledge_candidate",
          sourceKey: candidateId,
          sourceUri,
        },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [foundCandidates.findingJobId, foundCandidates.candidateIndex],
        set: {
          type: normalized.type,
          title: normalized.title,
          content: normalized.body,
          origin: compactOrigin(parsed, normalized),
          metadata: {
            sourceKind: "knowledge_candidate",
            sourceKey: candidateId,
            sourceUri,
          },
          updatedAt: now,
        },
      })
      .returning();

    if (!foundCandidate) throw new Error("failed to create V2 found candidate");

    // 4. Queue V2用の covering ジョブを直接投入（重複時は pending にリセット）
    const [coveringJob] = await tx
      .insert(coveringEvidenceQueue)
      .values({
        foundCandidateId: foundCandidate.id,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",          // pendingとして開始
        priority: 90,               // 最優先
        providerPolicy: "default",
        payload: {},
        metadata: {},
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: coveringEvidenceQueue.foundCandidateId,
        set: {
          status: "pending",       // 再処理のため pending にリセット
          priority: 90,
          completedAt: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          lastError: null,
          lastOutcomeKind: null,
          updatedAt: now,
        },
      })
      .returning();

    if (!coveringJob) throw new Error("failed to create V2 covering job");

    return { target, candidate, findingJob, foundCandidate, coveringJob };
  });

  // 5. 監査ログ: キューイベントの記録（トランザクション外）
  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: result.findingJob.id,
    eventType: "completed",
    message: "provided candidate registered synchronously (finding skipped)",
    metadata: {
      sourceKind: "knowledge_candidate",
      sourceKey: candidateId,
      inputKind: "provided_candidate",
      foundCandidateId: result.foundCandidate.id,
    },
  });

  await appendQueueEvent({
    queueName: "coveringEvidence",
    queueJobId: result.coveringJob.id,
    eventType: "enqueued",
    message: "covering job enqueued from synchronous register-candidate",
    metadata: {
      foundCandidateId: result.foundCandidate.id,
      findingJobId: result.findingJob.id,
    },
  });
```

---

## 4. 影響範囲と互換性の確認
* **ワーカー (`worker.ts`) の影響:**
  非同期のワーカーは `pending` や `paused` のジョブのみをCLAIM対象とするため、最初から `completed` として登録されたこのジョブを誤ってCLAIMすることはありません。既存のワーカーロジックは一切変更せずにそのまま正常に動作し続けます。
* **管理UI（Dashboard）への影響:**
  `finding_candidate_queue` に `completed` 状態で登録されるため、UIの「Finding」タブなどの履歴一覧にも、「MCPから登録されたジョブが完了した」という実績履歴として正しく残り、これまでの表示と一貫性が保たれます。
* **ワーカー内の `provided_candidate` 分岐パス:**
  `worker.ts` の L280–L319 にある `provided_candidate` 分岐は、本変更後は `completed` 状態のジョブしか存在しないため到達不能になります。ただし、本計画ではワーカー側のコードは変更せず、安全な dead code として残します（将来的な削除は別タスク）。

---

## 5. テスト更新計画

### 5.1 テストファイルの具体的変更

#### [register-candidate.service.test.ts](file:///Users/y.noguchi/Code/memoryRouter/test/register-candidate.service.test.ts)

**モック構成の変更:**
```diff
-const mockEnqueueFindingJob = vi.fn().mockResolvedValue({ id: "finding-job-1" });
+const mockAppendQueueEvent = vi.fn().mockResolvedValue(undefined);

-vi.mock("../src/modules/queue/core/index.js", () => ({
-  enqueueFindingJob: (...args: any[]) => mockEnqueueFindingJob(...args),
-}));
+vi.mock("../src/modules/queue/core/events.js", () => ({
+  appendQueueEvent: (...args: any[]) => mockAppendQueueEvent(...args),
+}));
```

**mockInsert のチェーン追加:**
各テストケースで、トランザクション内の insert 呼び出しが2回（レガシー）→5回（レガシー2 + finding + foundCandidate + covering）に増えるため、`mockInsert` の `mockReturnValueOnce` を追加：
```typescript
mockInsert
  .mockReturnValueOnce(makeChain([{ id: "target-1" }]))       // distillationTargetStates
  .mockReturnValueOnce(makeChain([{ id: "candidate-1" }]))    // findCandidateResults
  .mockReturnValueOnce(makeChain([{ id: "finding-job-1" }]))  // findingCandidateQueue
  .mockReturnValueOnce(makeChain([{ id: "found-1" }]))        // foundCandidates
  .mockReturnValueOnce(makeChain([{ id: "covering-1" }]));    // coveringEvidenceQueue
```

**新規追加アサーション:**
1. `covering_evidence_queue` に `pending` / `priority: 90` でジョブが作成されることの検証
2. `appendQueueEvent` が2回呼ばれることの検証（finding 完了 + covering enqueued）
3. `enqueueFindingJob` がもう呼ばれないことの検証（インポート自体削除のため）

**既存アサーションの変更:**
- `mockEnqueueFindingJob` を参照する全てのアサーションを削除（L295, L296, L297, L314-315, L324-326）
- bulk テストの `mockEnqueueFindingJob.toHaveBeenCalledTimes(2)` を `mockInsert` ベースのアサーションに変更

#### [register-candidate.integration.test.ts](file:///Users/y.noguchi/Code/memoryRouter/test/register-candidate.integration.test.ts)
- `finding_candidate_queue` のジョブが `status = 'completed'` で作成されていることを確認するアサーション追加
- `covering_evidence_queue` にジョブが即座に投入されていることを確認するアサーション追加

#### [mcp.tools.test.ts](file:///Users/y.noguchi/Code/memoryRouter/test/mcp.tools.test.ts)
- `register_candidate` ツール経由のテストで、レスポンスに `coveringJobId` が含まれるか確認（返り値型の拡張が必要な場合）

### 5.2 自動テストの実行
リファクタリングの適用後、以下のテスト群を実行してデグレーションがないか検証します。

1. **`register-candidate.service.test.ts` の実行:**
   * `mcp register-candidate` に関する機能テストであり、同期的に `covering` まで登録される新しいアサーションを満たすか検証。
2. **全ユニットテストの実行:**
   * `bun run test:unit`
3. **型チェックの実行:**
   * `bun run typecheck`

### 5.3 手動検証
API起動後、実際に MCP から `register_candidate` を呼び出し、直後に `covering_evidence_queue` に対象ジョブが優先度 `90` で即時挿入されることを確認します。
