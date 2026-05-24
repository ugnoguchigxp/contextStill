# Knowledge Landscape Safe Completion 実装計画

> Status: implementation draft
> Date: 2026-05-24 JST
> Last reviewed: 2026-05-24 JST
> Based on:
> - `docs/knowledge-landscape-concept-design.md`
> - `docs/knowledge-landscape-trajectory-contradiction-implementation-plan.md`

## 0. セルフレビュー結果

初版自己評価は **7.5 / 10**。

良い点:

- production ranking / auto-mutate を対象外にしている
- read-only observability と manual approval workflow に寄せている
- phase ごとの目的と対象ファイルがある

不足:

- 各 phase の API / schema / UI contract が薄く、実装時に scope creep しやすい
- 「危険なので放置するもの」と「安全に実装するもの」の境界が testable ではない
- Query / task embedding は privacy / storage / backfill の扱いが曖昧
- Snapshot cache operation は purge / audit / status の contract が曖昧
- Rollout の stop condition と verification matrix が不足している

改善後の自己評価は **9 / 10**。残リスクは Graph UI の複雑化と review queue noise だが、component 分割、source filter、confidence threshold、phase gate で制御する。

## 1. 方針

この計画は、Knowledge Landscape の残件のうち **やり切ってよいもの**だけを対象にする。

ここでの「やり切る」は、production ranking や canonical knowledge を自動変更することではない。対象は read-only observability、review workflow、manual approval、cache operation、sandbox comparison の完成度向上である。

安全性の固定条件:

- `context_compile` の production selection order を変えない
- `knowledge_items` の `title/body/appliesTo/status` を自動更新しない
- `knowledge_candidate` の finalize は manual approval gate を維持する
- sandbox comparison から canonical corpus へ直接 write-back しない
- query / task embedding は retrieval input に使わない
- snapshot cache は default off のままにする

## 2. 実装するもの / しないもの

### 2.1 実装する

- Trajectory playback の説明 UI 強化
- Contradiction overlay とノイズ制御
- Dead zone / AppliesTo repair の review workflow 完成
- Sandbox comparison の比較 UI 強化
- Snapshot cache の運用化
- Query / task embedding の分析用永続化

### 2.2 実装しない

以下は危険なので、この計画では放置する。

- Production ranking boost / repulsion
- Production path の Basin-aware query expansion
- Dead zone / AppliesTo repair の自動適用
- Automatic candidate generation の自動 finalize
- Sandbox から canonical corpus への直接 write-back
- Snapshot cache の default on 化

これらに関わるコードを触る場合でも、実装は diagnostics / dry-run / UI 表示までに限定する。runtime path に接続する変更は別計画に分離する。

## 3. 優先度

| Priority | Task | 判断 |
|---|---|---|
| P0 | SC-1 Trajectory playback explain UI | read-only で低リスク。debug / review 価値が高い |
| P0 | SC-2 Contradiction overlay / noise control | read-only。review queue の運用品質を上げる |
| P1 | SC-3 Dead zone / AppliesTo review workflow | manual approval 前提なら安全 |
| P1 | SC-4 Snapshot cache operation | default off のまま運用面を整える |
| P2 | SC-5 Sandbox comparison ergonomics | write-back なしなら安全 |
| P2 | SC-6 Query / task embedding observability | ranking 非接続なら安全 |

## 3.1 共通 contract

全 phase で守る contract:

- API は既存 `/api/graph/landscape/*` 配下に置く
- UI は `graph.page.tsx` に直書きしすぎず、既存 component を拡張または新規 component に分割する
- CLI は `src/cli/landscape.ts` に追加し、JSON 出力を必ず用意する
- schema は `src/shared/schemas/*` を source of truth にする
- DB migration が必要な場合は `drizzle/00xx_*.sql` と `drizzle/meta/_journal.json` を同時に更新する
- write operation は review item / candidate draft / cache operation の既存境界に限定する

## 3.2 Stop conditions

以下が発生した phase は一旦止め、計画を見直す。

- `context_compile` の selected knowledge が変わる
- `knowledge_items` の active row が自動更新される
- Graph page が単一 component にさらに肥大化し、差分の主処理が `graph.page.tsx` に集中する
- contradiction materialize の dry-run で低 confidence 候補が大半を占める
- snapshot cache の payload size が status で見えないまま default on が必要になる
- query / task embedding が retrieval query に参照される

## 4. SC-1: Trajectory Playback Explain UI

### 4.1 目的

`context_compile` run が、どの候補をどの段階で残し、どの候補を落としたかを Graph UI で読めるようにする。

### 4.2 実装内容

- `trajectory-panel.tsx` を stage selector 付きに拡張する
- stage は `text`, `vector`, `merged`, `final`, `selected`, `suppressed` とする
- stage ごとに Graph node highlight を切り替える
- candidate row に以下を追加表示する
  - `why selected`
  - `why suppressed`
  - `agenticDecision`
  - `candidateEvidence`
- trace unavailable / truncated / query limit truncated を UI 上で明示する

API / schema contract:

- `LandscapeTrajectoryCandidate` に `evidence` を追加する
- `evidence.candidateEvidence` は object として返すが、body text は返さない
- `stage` query は追加しない。stage filtering は UI 側で行う
- `limit` は既存の trajectory query limit を維持する

UI contract:

- stage selector は trajectory panel 内に閉じる
- Graph highlight は selected trajectory の candidate IDs から計算する
- stage highlight class は既存の `landscape-trajectory-highlight` と競合しない命名にする
- mobile では table を横スクロールではなく wrapping / compact columns で表示する

### 4.3 対象ファイル

- `web/src/modules/admin/components/trajectory-panel.tsx`
- `web/src/modules/admin/components/graph.page.tsx`
- `web/src/modules/admin/repositories/admin.repository.ts`
- `web/src/styles.css`
- `test/components/admin/graph-page.test.tsx`

### 4.4 対象外

- animation timeline のための新規 DB event stream
- ranking score の再計算
- production compile output の変更

### 4.5 完了条件

- risky run から trajectory を開き、stage ごとの候補状態を確認できる
- selected / suppressed / missing trace の違いが UI 上で分かる
- Graph node highlight が stage selector と同期する
- component test が stage 切替を検証する
- API schema test が `evidence` の body text 非保存を検証する

## 5. SC-2: Contradiction Overlay / Noise Control

### 5.1 目的

read-only contradiction 候補を Graph 上でも確認できるようにし、review queue のノイズを制御できる状態にする。

### 5.2 実装内容

- contradiction review item から Graph overlay 用 edge を生成する
- overlay edge は knowledge node 間または community 間に表示する
- confidence / priority / source marker を tooltip または side panel に表示する
- Graph UI に contradiction overlay toggle を追加する
- Action Queue に contradiction filter を追加する
- CLI に contradiction dry-run summary を追加する
  - candidate count
  - confidence distribution
  - top noisy marker pair
  - materialize skipped count

API / schema contract:

- overlay source は persisted review item を primary とする
- dry-run detection は CLI / materialize API のみで使い、Graph render のたびに heavy detection を走らせない
- `GET /api/graph/landscape/contradictions` を追加する場合は query を `status`, `confidenceMin`, `limit` に限定する
- payload は `leftKnowledgeId`, `rightKnowledgeId`, `pairKey`, `confidence`, `evidence`, `communityKey` を返す

Noise control:

- default は `pending` / `reviewing` item のみ表示する
- low confidence は overlay default off または muted 表示にする
- dismissed / resolved item は filter で明示選択した場合だけ表示する
- materialize は既存 `materializeLimit` と confidence threshold を維持する

### 5.3 対象ファイル

- `api/modules/graph/graph.routes.ts`
- `api/modules/graph/graph.repository.ts`
- `src/modules/landscape/landscape-contradiction.service.ts`
- `src/modules/landscape/landscape-review-items.service.ts`
- `src/cli/landscape.ts`
- `web/src/modules/admin/components/graph.page.tsx`
- `web/src/modules/admin/components/contradiction-review-list.tsx`
- `test/graph.routes.test.ts`
- `test/landscape-contradiction.service.test.ts`
- `test/components/admin/graph-page.test.tsx`

### 5.4 対象外

- contradiction による automatic suppression
- contradiction からの automatic candidate draft
- LLM-only contradiction 判定
- knowledge body rewrite / merge / split

### 5.5 完了条件

- Graph UI で contradiction overlay を on/off できる
- contradiction edge から pair evidence と confidence を確認できる
- materialize 前に dry-run でノイズ傾向を確認できる
- confidence threshold / materialize limit による抑制が test されている
- dismissed / resolved contradiction が default overlay に出ないことを test する

## 6. SC-3: Dead Zone / AppliesTo Review Workflow

### 6.1 目的

Dead zone / reachability risk / AppliesTo refine を、自動修復ではなく review workflow として完結させる。

### 6.2 実装内容

- review item detail に repair preview を追加する
- candidate draft の差分表示を追加する
  - title
  - body
  - appliesTo
  - evidence
- source evidence / replay evidence を同じ画面で確認できるようにする
- candidate approval の前に review item status と candidate link status を整合させる
- duplicate candidate draft の表示を整理する
- dismissed item から draft 作成されないことを明示的に test する

Workflow contract:

- preview は existing candidate draft または deterministic draft generator の結果を表示する
- preview から `knowledge_items` へ直接 write しない
- approved candidate link だけが finalize eligibility を満たす
- review item status と candidate link status が矛盾した場合は UI に warning を出す
- contradiction source は candidate draft 対象外のまま維持する

UI contract:

- Graph Action Queue から candidate detail へ遷移できる
- Candidates page では landscape origin、review item reason、approval status を一画面で確認できる
- diff は `title`, `body`, `appliesTo`, `evidence` の順で表示する

### 6.3 対象ファイル

- `src/modules/landscape/landscape-review-candidate.service.ts`
- `src/modules/landscape/landscape-review-candidate.repository.ts`
- `api/modules/graph/graph.routes.ts`
- `web/src/modules/admin/components/candidates.page.tsx`
- `web/src/modules/admin/components/graph.page.tsx`
- `test/landscape-review-candidate*.test.ts`
- `test/components/admin/graph-page.test.tsx`

### 6.4 対象外

- repair の自動適用
- approved candidate の自動 finalize
- active knowledge の自動 rewrite

### 6.5 完了条件

- Dead zone / AppliesTo refine item から candidate draft の差分を確認できる
- manual approval なしで finalize できない
- dismissed / resolved item の扱いが明確に test されている
- contradiction review item から candidate draft が作られないことを regression test する

## 7. SC-4: Snapshot Cache Operation

### 7.1 目的

default off のまま、snapshot cache を運用可能にする。

### 7.2 実装内容

- stale / expired cache purge を CLI に追加する
- cache status に以下を追加する
  - total payload size estimate
  - oldest generatedAt
  - expired ready count
  - last purge result
- Admin indicator を compact summary + detail table に分ける
- cache read/write failure を audit log に残す
- `LANDSCAPE_SNAPSHOT_CACHE_ENABLED` が false の時も status で理由が分かるようにする

API / CLI contract:

- CLI:
  - `--snapshot-cache-status`
  - `--snapshot-cache-refresh`
  - `--snapshot-cache-purge`
  - `--snapshot-cache-type`
  - `--json`
- API:
  - `GET /api/graph/landscape/cache-status`
- status fields:
  - `enabled`
  - `ttlSeconds`
  - `readyCount`
  - `staleCount`
  - `expiredReadyCount`
  - `oldestGeneratedAt`
  - `latestGeneratedAt`
  - `estimatedPayloadBytes`
  - `lastPurge`

Storage contract:

- payload size は exact でなく estimate でよい
- purge は stale / expired rows を対象にし、ready non-expired rows は削除しない
- read/write failure は caller を fail させず audit log に残す
- default off の挙動を変えない

### 7.3 対象ファイル

- `src/modules/landscape/landscape-snapshot-cache.service.ts`
- `src/modules/landscape/landscape-snapshot-cache.repository.ts`
- `src/shared/schemas/landscape-snapshot-cache.schema.ts`
- `src/cli/landscape.ts`
- `api/modules/graph/graph.routes.ts`
- `web/src/modules/admin/components/graph.page.tsx`
- `test/landscape-snapshot-cache.service.test.ts`
- `test/graph.routes.test.ts`

### 7.4 対象外

- default on 化
- daemon / cron purge
- daily snapshot generation

### 7.5 完了条件

- CLI で status / refresh / purge ができる
- Admin UI で ready/stale/expired/size estimate を確認できる
- cache failure は compile / graph API を失敗させない
- verify が通る
- default off でも status が取得できる
- purge が non-expired ready cache を消さないことを test する

## 8. SC-5: Sandbox Comparison Ergonomics

### 8.1 目的

Sandbox を canonical corpus へ書き戻さず、比較・レビューのために使いやすくする。

### 8.2 実装内容

- sandbox comparison panel に run selector を追加する
- added / removed / retained の filter を追加する
- changed knowledge id から node detail / candidate detail へ移動できるようにする
- comparison summary を JSON copy / CLI 出力できるようにする
- affected community highlight を legend に追加する

UI / API contract:

- run selector は `landscapeReplayComparison.runs` の範囲だけを対象にする
- changed item list は knowledge id のみを表示し、body text は detail fetch まで遅延する
- JSON copy は current UI state の summary に限定する
- write endpoint は追加しない

### 8.3 対象外

- sandbox rule editing
- ranking parameter editing
- canonical corpus write-back

### 8.4 完了条件

- risky run ごとの差分を UI で絞り込める
- affected community と changed knowledge ids の関係が追える
- write API は追加しない
- added / removed / retained filter が component test されている

## 9. SC-6: Query / Task Embedding Observability

### 9.1 目的

将来の basin analysis のために、task state の観測データを保存する。ただし retrieval / ranking には使わない。

### 9.2 実装内容

- compile run ごとに normalized task facets を保存する
- query embedding 保存の要否を schema 上で分ける
  - `facets only`
  - `embedding available`
  - `embedding unavailable`
- embedding provider / model / dimensions を metadata に保存する
- privacy / size を考慮し、raw goal の重複保存は避ける
- trajectory / replay から task similarity を read-only に表示する

Data model contract:

- 新規 table を作る場合は `context_compile_task_traces` とする
- 保存するもの:
  - `run_id`
  - normalized `technologies`, `changeTypes`, `domains`
  - `repoPath` / `repoKey`
  - `retrievalMode`
  - `embeddingStatus`
  - `embeddingProvider`
  - `embeddingModel`
  - `embeddingDimensions`
  - `embedding` nullable
  - `goalHash`
- 保存しないもの:
  - raw goal duplicate
  - full prompt
  - source document body

Migration / backfill contract:

- migration は nullable-first にする
- historical backfill は CLI dry-run から始める
- embedding unavailable でも run persistence は成功させる
- task similarity UI は embedding がない場合 facets-only 表示に fallback する

### 9.3 対象外

- query expansion
- ranking boost
- task similarity による automatic retrieval change

### 9.4 完了条件

- task state が replay / trajectory で説明用途に使える
- production compile output は変わらない
- embedding なしでも既存動作は維持される
- raw goal duplicate が保存されないことを test する
- ranking / retrieval service が新 table を参照していないことを review で確認する

## 10. Test Matrix

| Phase | Unit | API | Component | Regression |
|---|---|---|---|---|
| SC-1 | trajectory schema / stage grouping | trajectory response evidence | stage selector / highlight | trace unavailable / truncated |
| SC-2 | contradiction noise summary | contradiction overlay list | overlay toggle / edge detail | dismissed/resolved hidden by default |
| SC-3 | candidate draft status rules | approval/link endpoints | diff preview / warning | contradiction source excluded |
| SC-4 | cache status / purge | cache-status endpoint | Admin cache detail | default off / failure safe |
| SC-5 | changed item grouping | no new write API | filters / run selector | added/removed/retained counts |
| SC-6 | task trace normalization | task trace read-only endpoint if added | trajectory/replay task similarity | no raw goal duplicate / no ranking reference |

## 11. Verification Commands

各 phase で最低限以下を実行する。

```bash
bun run typecheck
bunx vitest run test/graph.routes.test.ts test/components/admin/graph-page.test.tsx
bun run verify
```

対象 module を変更した場合は個別 test を追加する。

```bash
bunx vitest run test/landscape-contradiction.service.test.ts
bunx vitest run test/landscape-snapshot-cache.service.test.ts
bunx vitest run test/landscape-review-items.test.ts
```

DB migration を追加した phase では以下も確認する。

```bash
bun run typecheck
bun run verify
```

## 12. Rollout

1. SC-1 Trajectory playback explain UI
2. SC-2 Contradiction overlay / noise control
3. SC-4 Snapshot cache operation
4. SC-3 Dead zone / AppliesTo review workflow
5. SC-5 Sandbox comparison ergonomics
6. SC-6 Query / task embedding observability

SC-1 / SC-2 / SC-4 は production output を変えないため先に進める。SC-3 は candidate / approval workflow に触るため、SC-1 / SC-2 で review surface を整えた後に実装する。

Phase gate:

- SC-1 完了後: trajectory を使って selection / suppression を説明できる
- SC-2 完了後: contradiction queue の noise を dry-run で測れる
- SC-4 完了後: cache を default off のまま運用できる
- SC-3 完了後: repair workflow が draft / approval で止まる
- SC-5 完了後: sandbox comparison が review input として使える
- SC-6 完了後: task state が analysis-only で残る

## 13. 完了条件

- Graph UI で trajectory / contradiction / sandbox の read-only explain ができる
- Dead zone / AppliesTo repair は draft + review + manual approval までで止まる
- Snapshot cache は default off のまま status / refresh / purge できる
- Query / task embedding は analysis-only で、retrieval / ranking に接続されない
- Production ranking、query expansion、auto repair、auto finalize、sandbox write-back は未実装のまま維持される
- `bun run verify` が通る
