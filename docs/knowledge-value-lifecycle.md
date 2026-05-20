# 知識価値ライフサイクル実装計画

> **ステータス**: Implementation Ready
> **作成日**: 2026-05-15
> **最終更新**: 2026-05-16
> **対象バージョン**: v0.2

---

## 1. 実装判断

実装推奨。対象は `memory-router` の中核価値である `context_compile` の品質を上げる変更であり、単なる管理 UI 機能ではない。

ただし一括実装は避ける。最初の実装単位は **参照カウント、動的スコア、陳腐化スコア、doctor/UI 可視化** までに限定する。明示フィードバックと名寄せ統合は、基礎指標が実データで安定してから別フェーズで入れる。

### この計画で解決する問題

- `knowledge_items.importance` / `confidence` は静的で、実際に使われた知識が自然に浮き上がらない。
- `context_pack_items` には選択履歴があるが、ranking に戻っていない。
- `lastVerifiedAt` はスキーマ上存在するが、陳腐化計算・doctor・UI に活かされていない。
- draft/active/deprecated の状態管理はあるが、active knowledge の運用品質を測る指標が弱い。

### 非ゴール

- `context_compile` の public MCP surface を増やして問題を隠さない。
- stale 判定だけで knowledge を自動 `deprecated` 化しない。
- raw transcript や source body を ranking に直接混ぜない。
- 名寄せ・クラスタリングを Phase 1 に含めない。
- `agentic_search` 的な大きな orchestrator は追加しない。

---

## 2. 現状コードの前提

### 既にある実装

| 領域 | 現状 | 主なファイル |
|---|---|---|
| Knowledge storage | `knowledge_items` に `type/status/scope/title/body/appliesTo/confidence/importance/lastVerifiedAt` がある | `src/db/schema.ts` |
| Compile history | `context_compile_runs` と `context_pack_items` が選択履歴を保存している | `src/modules/context-compiler/context-compiler.repository.ts` |
| Ranking | `rankAndDedupe` が text/vector score、importance、confidence、source refs、error hints を加味する | `src/modules/context-compiler/ranking.service.ts` |
| Compile flow | `compileContextPack` が retrieval、agentic refine、token budget、pack item insert を実行する | `src/modules/context-compiler/context-compiler.service.ts` |
| Knowledge API/UI | CRUD、bulk status、Knowledge page がある | `api/modules/knowledge/*`, `web/src/modules/admin/components/knowledge.page.tsx` |
| Doctor | DB、pgvector、embedding、MCP surface、compile health、draft backlog を診断する | `src/modules/doctor/*` |
| Quality gates | unit/build の `verify` と DB/MCP の `verify:mcp` がある | `package.json`, `.github/workflows/verify.yml` |

### 設計原則

- `context_pack_items` を実績の正本とし、`knowledge_items` のカウンタは ranking/UI 用の denormalized cache とする。
- 動的スコアは 0-100 scale で保存し、ranking では `toUnitKnowledgeScore` と同じ考え方で 0-1 に正規化する。
- 陳腐化係数は保存せず、ranking/doctor/UI 表示時に `lastVerifiedAt ?? updatedAt` から計算する。
- compile の主処理は、価値指標の更新に失敗しても失敗扱いにしない。ただし audit と doctor で検出可能にする。

---

## 3. データモデル

### 3.1 追加 migration

次の migration を追加する。

- `drizzle/0015_knowledge_value_lifecycle.sql`
- `drizzle/meta/_journal.json`
- `src/db/schema.ts`

`knowledge_items` に追加するカラム:

```sql
alter table knowledge_items
  add column compile_select_count integer not null default 0,
  add column last_compiled_at timestamp,
  add column agentic_accept_count integer not null default 0,
  add column explicit_upvote_count integer not null default 0,
  add column explicit_downvote_count integer not null default 0,
  add column dynamic_score real not null default 0;

create index knowledge_items_last_compiled_at_idx
  on knowledge_items (last_compiled_at);

create index knowledge_items_dynamic_score_idx
  on knowledge_items (dynamic_score);
```

補足:

- `last_verified_at` は既存カラムを使う。
- `dynamic_score` は 0-100 scale。0 は「使用実績なし」であり、品質が低いという意味ではない。
- `explicit_*_count` は Phase 1 では schema だけ入れてもよい。API/UI は Phase 3 で使う。

### 3.2 バックフィル

既存の `context_pack_items` から初期値を作る CLI を追加する。

- `src/cli/backfill-knowledge-value.ts`
- `package.json`: `backfill:knowledge-value`

仕様:

1. `context_pack_items.itemKind in ('rule', 'procedure')` を対象にする。
2. `context_pack_items.itemId` を `knowledge_items.id` として join する。
3. `compile_select_count = count(*)`
4. `last_compiled_at = max(context_pack_items.created_at)`
5. `dynamic_score = computeDynamicScore(...)`
6. `updated_at` は変更しない。これは knowledge 本文の更新ではなく派生値の更新であるため。

受け入れ条件:

- 同じ CLI を複数回実行しても同じ結果になる。
- 存在しない `itemId` や `file_hint` は無視される。
- 実行結果は JSON で `updatedCount`, `ignoredCount`, `dryRun` を返す。

---

## 4. Core Service

### 4.1 新規 service

追加ファイル:

- `src/modules/knowledge/knowledge-value.service.ts`
- 必要なら `src/modules/knowledge/knowledge-value.repository.ts`

公開する関数:

```typescript
export type KnowledgeValueSignals = {
  compileSelectCount: number;
  recentSelectCount30d: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
};

export function computeDynamicScore(signals: KnowledgeValueSignals): number;

export function computeDecayFactor(input: {
  type: "rule" | "procedure";
  scope: "repo" | "global";
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  now?: Date;
}): number;

export async function recordKnowledgeCompileSelectionSafe(input: {
  runId: string;
  selectedKnowledgeIds: string[];
  agenticAcceptedKnowledgeIds: string[];
}): Promise<void>;
```

### 4.2 dynamic score

初期実装は単純でよい。重要なのは、score scale を既存の `importance/confidence` と揃えること。

```typescript
dynamicScore =
  min(35, log1p(compileSelectCount) * 10)
  + min(25, recentSelectCount30d * 3)
  + min(20, agenticAcceptCount * 4)
  + min(20, explicitUpvoteCount * 10)
  - min(40, explicitDownvoteCount * 15)
```

最後に `0..100` へ clamp する。

理由:

- compile 回数は長期的には対数で効かせる。
- 直近 30 日の選択は freshness として強めに効かせる。
- agentic refine に残った回数は compile 選択より強い肯定シグナルとして扱う。
- downvote は上振れ抑制として強く効かせる。

### 4.3 decay factor

陳腐化係数は `0..1` で計算する。

```typescript
lambda =
  type === "procedure" ? 0.004 :
  type === "rule" ? 0.001 :
  0.001;

scopeFactor = scope === "global" ? 0.5 : 1.0;
days = now - (lastVerifiedAt ?? updatedAt);
decayFactor = exp(-lambda * scopeFactor * days);
```

この値は DB に保存しない。ranking と doctor/UI で都度計算する。

---

## 5. Compile Flow Integration

対象:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/context-compiler.repository.ts`
- `src/modules/knowledge/knowledge-value.service.ts`
- `test/context-compiler.service.test.ts`
- `test/context-compiler.integration.test.ts`

実装:

1. `compileContextPack` で `selectedPackItems` を作った後、knowledge item の ID だけを抽出する。
   - `item.itemKind in ('rule', 'procedure')`
   - `item.itemId` を knowledge ID として使う。
2. `agenticResult.agenticUsed === true` のときだけ、`finalKnowledge` の ID を `agenticAcceptedKnowledgeIds` として渡す。
3. `insertContextPackItems` の後に `recordKnowledgeCompileSelectionSafe` を呼ぶ。
4. 価値指標更新に失敗しても compile response は壊さない。
5. 失敗時は `audit_logs` に `KNOWLEDGE_VALUE_UPDATE_FAILED` を記録する。

更新 SQL の考え方:

```sql
update knowledge_items
set
  compile_select_count = compile_select_count + 1,
  agentic_accept_count = agentic_accept_count + case when id in (...) then 1 else 0 end,
  last_compiled_at = now(),
  dynamic_score = <recomputed score>,
  last_verified_at = coalesce(last_verified_at, now())
where id in (...);
```

注意:

- `updated_at` は変えない。本文・状態・metadata の更新ではないため。
- `last_verified_at` は初回 compile 選択時だけ埋める。毎回 compile で更新すると decay が働かなくなる。
- `status = deprecated` の item が compile に入った場合も記録はするが、ranking 側で強く下げる。

受け入れ条件:

- `context_compile` が active knowledge を pack に入れると `compile_select_count` が増える。
- `agenticRefine` が有効で選別した item は `agentic_accept_count` も増える。
- `file_hint` はカウントされない。
- カウンタ更新失敗時も `context_compile` は pack を返す。

---

## 6. Ranking Integration

対象:

- `src/modules/context-compiler/ranking.service.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/mcp/tools/knowledge.tool.ts`
- `test/ranking.service.test.ts`
- `test/context-compiler.test.ts`

実装:

1. `KnowledgeSearchResult` に以下を追加する。
   - `dynamicScore`
   - `compileSelectCount`
   - `agenticAcceptCount`
   - `explicitUpvoteCount`
   - `explicitDownvoteCount`
   - `lastCompiledAt`
   - `lastVerifiedAt`
   - `updatedAt`
   - `decayFactor`
2. text search / vector search の select に追加カラムを含める。
3. repository で `decayFactor` を計算して返す。
4. `Rankable` に `dynamicScore?: number` と `decayFactor?: number` を追加する。
5. `weightedScore` に次の要素を加える。

```typescript
const dynamicBoost = toUnitKnowledgeScore(item.dynamicScore, 0) * 0.12;
const decayPenalty = (1 - (item.decayFactor ?? 1)) * 0.12;
```

既存の `score`、`importance`、`confidence`、source refs、error hints は維持する。dynamic score は relevance を置き換えるものではなく、同程度に関連する候補の優先度を決める補助シグナルである。

受け入れ条件:

- 同じ text/vector score の候補では、使用実績のある item が上に来る。
- 古い procedure は同条件の新しい procedure より下がる。
- high-confidence/high-importance で source refs がある item は、使用回数が少なくても極端に沈まない。
- 0-1 scale と 0-100 scale の混在バグを再発させない。

---

## 7. Doctor / Diagnostics

対象:

- `src/shared/schemas/doctor.schema.ts`
- `src/modules/doctor/inspectors/database.inspector.ts`
- `src/modules/doctor/doctor.service.ts`
- `api/modules/doctor/doctor.service.ts`
- `web/src/modules/admin/components/overview.page.tsx`
- `test/doctor.service.test.ts`
- `test/schemas.test.ts`

追加する doctor section:

```typescript
knowledgeLifecycle: {
  activeCount: number;
  zeroUseActiveCount: number;
  staleByDecayCount: number;
  staleProcedureCount: number;
  dynamicScoreAvg: number | null;
  dynamicScoreP95: number | null;
  lastCompiledAt: string | null;
  lastCompiledAgeMinutes: number | null;
  thresholds: {
    staleDecayFactor: number; // default 0.5
    zeroUseWarningMinActiveCount: number; // default 10
  };
}
```

doctor reasons:

- `KNOWLEDGE_ZERO_USE_HIGH`
- `KNOWLEDGE_DECAY_STALE_HIGH`
- `KNOWLEDGE_VALUE_QUERY_FAILED`

初期しきい値:

- active knowledge が 10 件以上あり、その 70% 以上が `compile_select_count = 0` なら warning。
- `decayFactor < 0.5` の active knowledge が 10 件以上なら warning。
- しきい値は `groupedConfig.doctor` に追加する。

受け入れ条件:

- `bun run doctor` だけで、知識が使われているか、古すぎるか、最後に compile で使われた時刻が分かる。
- optional な lifecycle 指標の計算失敗は doctor 全体を failed にしない。
- schema と API/UI の型が一致する。

---

## 8. Knowledge API / UI

対象:

- `api/modules/knowledge/knowledge.repository.ts`
- `api/modules/knowledge/knowledge.routes.ts`
- `web/src/modules/admin/repositories/admin.repository.ts`
- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/admin/components/overview.page.tsx`
- `test/api.routes.test.ts`

### Phase 1 UI

Knowledge list に追加する表示:

- `compileSelectCount`
- `lastCompiledAt`
- `dynamicScore`
- `decayFactor`
- `lastVerifiedAt`

フィルタ:

- `unused active`: `status=active` かつ `compileSelectCount=0`
- `stale`: `decayFactor < 0.5`
- `high value`: `dynamicScore >= 60`

### Phase 3 feedback API

Phase 1/2 が安定した後に追加する。

Endpoint:

```http
POST /api/knowledge/:id/feedback
```

Input:

```json
{
  "direction": "up" | "down",
  "reason": "optional short note"
}
```

挙動:

- `explicit_upvote_count` または `explicit_downvote_count` を increment。
- `dynamic_score` を再計算。
- `audit_logs` に `KNOWLEDGE_FEEDBACK_RECORDED` を保存。
- upvote の場合のみ `last_verified_at = now()` に更新してよい。

MCP tool は初期追加しない。public MCP surface は contract test で固定されているため、agent からの feedback 専用 tool が必要になった時点で、`docs/mcp-tools.md` と `test/mcp.contract.test.ts` を同時に更新して判断する。

---

## 9. lastVerifiedAt 更新ルール

`lastVerifiedAt` は「実際に信頼できる確認が入った時」だけ更新する。

| トリガー | 更新するか | 理由 |
|---|---:|---|
| create knowledge | Yes | 人間/API/agent が新規登録した時点を初回確認日とする |
| draft -> active | Yes | 人間または明示操作による採用判断 |
| active -> deprecated | No | 確認ではなく廃止判断 |
| body/title 更新 | Yes | 内容を再確認したとみなす |
| metadata のみ更新 | No | 本文品質の確認ではない |
| compile に選ばれた | 初回 null の場合のみ Yes | 使用だけで毎回 fresh 扱いにしない |
| upvote | Yes | 明示的な肯定 |
| downvote | No | 肯定ではない |
| source/vibe 再蒸留で同じ knowledge が再採用された | Yes | 同じ知識が再検証されたとみなす |

対象:

- `api/modules/knowledge/knowledge.repository.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/mcp/tools/knowledge.tool.ts`
- distillation の保存経路

---

## 10. 実装フェーズ

### Phase 0: Preparation

- [ ] `docs/knowledge-value-lifecycle.md` をこの実装計画として確定する。
- [ ] 既存 tests の baseline を確認する。
- [ ] migration 番号が `0015` で衝突しないことを確認する。

検証:

```bash
git status --short
bun run verify
```

### Phase 1: Usage Signals

- [ ] `0015_knowledge_value_lifecycle.sql` を追加する。
- [ ] `src/db/schema.ts` に追加カラムと indexes を反映する。
- [ ] `knowledge-value.service.ts` を追加する。
- [ ] `computeDynamicScore` / `computeDecayFactor` の unit test を追加する。
- [ ] `recordKnowledgeCompileSelectionSafe` を実装する。
- [ ] `compileContextPack` から選択済み knowledge ID を記録する。
- [ ] `backfill:knowledge-value` CLI を追加する。

検証:

```bash
bun run verify
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
```

### Phase 2: Ranking + Doctor + UI

- [ ] `KnowledgeSearchResult` に lifecycle fields を追加する。
- [ ] text/vector repository select に lifecycle fields を追加する。
- [ ] `rankAndDedupe` に `dynamicScore` / `decayFactor` を反映する。
- [ ] doctor schema に `knowledgeLifecycle` を追加する。
- [ ] database inspector に lifecycle 集計を追加する。
- [ ] Overview / Knowledge UI に usage/decay/dynamic score を表示する。
- [ ] API repository / frontend repository の型を更新する。

検証:

```bash
bun run verify
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
bun run doctor
```

### Phase 3: Explicit Feedback

- [ ] `POST /api/knowledge/:id/feedback` を追加する。
- [ ] `KNOWLEDGE_FEEDBACK_RECORDED` audit event を追加する。
- [ ] Knowledge UI に up/down 操作を追加する。
- [ ] feedback 後の dynamic score 再計算を追加する。
- [ ] 必要性が確認できた場合だけ MCP feedback tool を検討する。

検証:

```bash
bun run verify
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
```

MCP tool を増やした場合のみ追加:

```bash
bun run verify:mcp
```

### Phase 4: Dedup Integration

このフェーズは本計画では実装しない。Phase 1-3 の実データを見てから別計画に分離する。

候補:

- `compile_select_count` が高い item を canonical 候補にする。
- duplicate item を `deprecated` 化する時に usage counters を canonical に移す。
- 自動統合は confidence 0.98 以上に限定し、それ以外は UI review にする。

---

## 11. 受け入れ基準

Phase 1-2 完了条件:

- `context_compile` が knowledge を選択すると、該当 item の `compile_select_count` と `last_compiled_at` が更新される。
- `agenticRefine` が実際に使われた場合のみ `agentic_accept_count` が更新される。
- `rankAndDedupe` が dynamic score と decay factor を考慮する。
- `doctor` が knowledge lifecycle health を返す。
- Knowledge UI で unused/stale/high value を見分けられる。
- 既存 MCP public surface は変わらない。
- `bun run verify` と DB integration が通る。

品質上の追加条件:

- 0-100 scale と 0-1 scale の混在が test で防がれている。
- 価値指標の更新失敗は compile を壊さず、audit/doctor で検出できる。
- migration は additive で、既存データを破壊しない。
- `updated_at` は価値指標の派生更新だけでは変えない。

---

## 12. ロールバック方針

コード rollback:

- ranking から `dynamicScore` / `decayFactor` の加点減点を外せば、既存の text/vector + quality ranking に戻せる。
- compile flow から `recordKnowledgeCompileSelectionSafe` 呼び出しを外せば、カウンタ更新は止まる。
- doctor/UI は追加 section を非表示にできる。

DB rollback:

- 追加カラムは ranking/UI 用 cache なので、残っていても既存機能を壊さない。
- 物理削除が必要な場合だけ rollback migration で追加 indexes と columns を drop する。

運用 rollback:

- `backfill:knowledge-value` は idempotent なので、誤実行時は再実行で復元できる。
- `dynamic_score` が不自然な場合は全件 0 に戻して再計算できる。

---

## 13. 変更対象一覧

必須:

- `drizzle/0015_knowledge_value_lifecycle.sql`
- `drizzle/meta/_journal.json`
- `src/db/schema.ts`
- `src/modules/knowledge/knowledge-value.service.ts`
- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/ranking.service.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/modules/doctor/inspectors/database.inspector.ts`
- `src/modules/doctor/doctor.service.ts`
- `src/shared/schemas/doctor.schema.ts`
- `api/modules/knowledge/knowledge.repository.ts`
- `web/src/modules/admin/repositories/admin.repository.ts`
- `web/src/modules/admin/components/knowledge.page.tsx`
- `web/src/modules/admin/components/overview.page.tsx`
- `package.json`

テスト:

- `test/ranking.service.test.ts`
- `test/context-compiler.service.test.ts`
- `test/context-compiler.repository.test.ts`
- `test/repositories.integration.test.ts`
- `test/doctor.service.test.ts`
- `test/api.routes.test.ts`
- `test/schemas.test.ts`

Phase 3 のみ:

- `api/modules/knowledge/knowledge.routes.ts`
- `src/modules/audit/audit-log.service.ts`
- feedback 用 UI components/tests
- MCP tool を増やす場合は `src/mcp/tools/*`, `docs/mcp-tools.md`, `test/mcp.contract.test.ts`

---

## 14. 実装時の検証コマンド

通常:

```bash
bun run verify
```

DB 変更を含むため必須:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
```

MCP surface または MCP response shape を変えた場合:

```bash
bun run verify:mcp
```

動作確認:

```bash
bun run doctor
bun run compile --goal "knowledge lifecycle の ranking を確認する" --intent review --json
```

UI を触った場合:

```bash
bun run test:e2e
```

e2e が実行できない環境では、代替として以下を実リクエストで確認する。

```bash
bun run dev
curl -s http://localhost:5173/api/doctor
curl -s "http://localhost:5173/api/knowledge?limit=5"
```
