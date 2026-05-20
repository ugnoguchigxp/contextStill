# Candidate 一覧 UI 実装計画

作成日: 2026-05-20
対象リポジトリ: `memory-router`
前提ドキュメント: `docs/find-candidate-plan.md`、`docs/cover-evidence-plan.md`、`docs/finalize-distille-plan.md`

## レビュー結果

実装着手は可能。ただし、初版は「candidate が存在する行の監査 UI」に絞る。

この計画は staged pipeline の正本テーブル、read-only 方針、Knowledge 紐付けの正本を正しく押さえている。一方で、最初の版で target-only queue まで扱うと API response が candidate row と target row の union になり、UI / pagination / stats が一段複雑になる。初期実装では `find_candidate_results` 起点を維持し、candidate がまだ生成されていない target はこの画面に出さない。

このレビューで実装前に固定した点:

- `target_pending` は「candidate row はあるが、target が `pending` / `running` で cover result がまだない」状態に限定する。candidate 未生成 target の一覧は対象外。
- table の `Updated` は `latestUpdatedAt` として API read model で算出する。
- summary stats は `query` / `targetKind` / `hasKnowledge` / `targetStateId` を反映するが、`outcome` filter は反映しない。outcome タブを切り替えても分母が読めるようにする。
- Knowledge join は `distillation_target_states.knowledgeIds` ではなく、`knowledge_items.metadata` の `coverEvidenceResultId` / `sourceUri` を使う。複数 hit は `updated_at desc` の 1 件に正規化する。
- JSONB metadata lookup index は migration だけでなく `src/db/schema.ts` の index 定義にも追加する。
- 実装完了判定には `bun run verify` に加え、DB join / migration を覆う safe DB integration test を含める。

## 目的

distillation pipeline が生成した candidate を UI で一覧できるようにする。

この UI は Knowledge 編集画面ではなく、candidate がどのように評価され、どの candidate が Knowledge 化され、Knowledge 化までに内容がどう変わったかを追跡する監査ビューとして作る。

この画面で答える問い:

- どの target から、どの candidate が生成されたか。
- どの candidate が Knowledge 化されたか。
- Knowledge 化されなかった candidate は、どの stage / reason で止まったか。
- 元 candidate から evidence coverage 後、最終 Knowledge までに title / body / type / score がどう変わったか。
- 既に Knowledge 化済みの candidate が、現在どの Knowledge item に対応しているか。

## 非目的

初期実装では read-only にする。

- candidate の手動編集はしない。
- Knowledge の直接編集 UI はこの画面に持ち込まない。
- requeue、rerun coverEvidence、finalize の mutation は初期実装に含めない。
- inline diff の高機能 editor は作らない。
- legacy な `distillation_candidates` 互換層は追加しない。
- candidate がまだ生成されていない target-only 行は表示しない。
- target queue / pipeline timeline はこの画面に持ち込まない。

mutation は運用上便利だが、誤操作で pipeline 状態を壊しやすい。まずは観測と監査に閉じる。

## 現行コード上の前提

現行の staged pipeline は次のテーブルを正本にしている。

| 段階 | 正本 | 役割 |
|---|---|---|
| target | `distillation_target_states` | source / memory の処理状態、phase、retry、outcome を持つ |
| original candidate | `find_candidate_results` | `findCandidate` が抽出した最小 candidate を持つ |
| covered candidate | `cover_evidence_results` | 根拠補強、dedupe、type、score、reason、tool events を持つ |
| final knowledge | `knowledge_items` | `finalizeDistille` が保存した Knowledge を持つ |

関連実装:

- `src/modules/findCandidate/repository.ts` は `find_candidate_results` と `distillation_target_states` を join して candidate と target 情報を返せる。
- `src/modules/coverEvidence/repository.ts` は `cover_evidence_results.id = find_candidate_results.id` を前提に candidate 単位の evidence result を扱う。
- `src/modules/finalizeDistille/domain.ts` は `sourceUri = cover-evidence-result://<coverEvidenceResultId>` を使い、Knowledge metadata に `coverEvidenceResultId`、`findCandidateResultId`、`targetStateId` を保存する。
- `src/modules/knowledge/knowledge.repository.ts` の `upsertKnowledgeFromSource()` は `knowledge_items.metadata ->> 'sourceUri'` を upsert key にする。
- `api/app.ts` は Hono router を `/api/<domain>` に mount する構成で、各 API module は `zValidator("query", schema)` で query を検証している。
- frontend は TanStack Router / TanStack Query / TanStack Table と `web/src/components/ui/*` の shadcn-style base component を使っている。
- wide table 系 admin page は `web/src/modules/admin/components/app-shell.tsx` の `full-width` 判定に route prefix を足す。

このため、Candidate UI の Knowledge 紐付けは `distillation_target_states.knowledgeIds` ではなく、`knowledge_items.metadata` を正とする。

## ドメイン境界

Candidate UI は次の lineage を表示する。

```text
distillation_target_states
  -> find_candidate_results
  -> cover_evidence_results
  -> knowledge_items
```

表示上の用語:

| UI 用語 | DB / domain | 意味 |
|---|---|---|
| Original Candidate | `find_candidate_results.title/content` | LLM が元 source から抽出した最初の候補 |
| Covered Candidate | `cover_evidence_results.title/body` | evidence / dedupe / score 判定後の候補 |
| Final Knowledge | `knowledge_items.title/body` | Knowledge として保存された現在の内容 |
| Outcome | API read model で算出 | stored / rejected / retryable など、一覧向けの集約状態 |
| Diff | API read model + UI rendering | Original から Covered / Knowledge への差分 |

Knowledge 化済みの判定は、該当 candidate に紐づく `knowledge_items` が存在することとする。対象 target の `knowledgeIds` に含まれるかどうかだけでは candidate 単位の対応が曖昧になるため、一覧 UI の正本には使わない。

## API 設計

新規 API module を追加する。

| ファイル | 種別 | 内容 |
|---|---|---|
| `api/modules/candidates/candidates.repository.ts` | NEW | candidate 一覧用 read model を DB から組み立てる |
| `api/modules/candidates/candidates.routes.ts` | NEW | query validation と JSON response を提供する |
| `api/app.ts` | MODIFY | `/api/candidates` を mount する |
| `src/db/schema.ts` | MODIFY | `knowledge_items.metadata` lookup 用 index を schema に定義する |
| `drizzle/0026_knowledge_candidate_metadata_indexes.sql` | NEW | JSONB metadata lookup 用 index migration |
| `drizzle/meta/_journal.json` | MODIFY | migration journal に `0026_knowledge_candidate_metadata_indexes` を追加する |

### Endpoint

```http
GET /api/candidates
```

Query:

| param | 型 | default | 内容 |
|---|---|---:|---|
| `page` | integer | `1` | ページ番号 |
| `limit` | integer | `50` | 1-200 |
| `query` | string | `""` | target key、candidate title/body、knowledge title/body を検索 |
| `targetKind` | `all \| wiki_file \| vibe_memory` | `all` | target 種別 |
| `outcome` | `all \| stored \| ready_not_finalized \| rejected \| retryable \| candidate_only \| target_pending` | `all` | 一覧向け状態 |
| `hasKnowledge` | `all \| yes \| no` | `all` | Knowledge 紐付けの有無 |
| `targetStateId` | string | optional | target 単位に絞り込む |

初期版では sort は `latestUpdatedAt desc, candidateIndex asc` に固定する。追加 sort は UI 利用が見えてから増やす。

`updatedAt` は単一カラムではなく、API read model の `latestUpdatedAt` を指す。

```ts
latestUpdatedAt = max(
  target.updatedAt,
  original.updatedAt,
  cover?.updatedAt,
  knowledge?.updatedAt,
)
```

`query` は trim 後 200 文字までに制限し、空文字は未指定と同じ扱いにする。

`stats` は `outcome` 以外の filter を反映した件数にする。`items` / `total` は `outcome` も含む全 filter を反映する。

### Response

```ts
type CandidateListResponse = {
  items: CandidateListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  stats: CandidateListStats;
};

type CandidateListStats = {
  total: number;
  stored: number;
  readyNotFinalized: number;
  rejected: number;
  retryable: number;
  targetPending: number;
  candidateOnly: number;
};

type CandidateListItem = {
  id: string;
  targetStateId: string;
  candidateIndex: number;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  /** target source document / source memory URI */
  sourceUri: string;
  /** sourceUri used by finalizeDistille / knowledge metadata */
  finalizeSourceUri: string;
  targetStatus: string;
  targetPhase: string;
  targetOutcomeKind: string | null;
  targetLastError: string | null;
  latestUpdatedAt: string;

  original: {
    title: string;
    body: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };

  cover: null | {
    status: string;
    stage: string;
    type: "rule" | "procedure" | null;
    title: string | null;
    body: string | null;
    importance: number | null;
    confidence: number | null;
    reason: string | null;
    referencesCount: number;
    duplicateRefsCount: number;
    toolEventsCount: number;
    updatedAt: string;
  };

  knowledge: null | {
    id: string;
    type: string;
    status: string;
    scope: string;
    title: string;
    body: string;
    importance: number | null;
    confidence: number | null;
    updatedAt: string;
  };

  outcome:
    | "stored"
    | "ready_not_finalized"
    | "rejected"
    | "retryable"
    | "candidate_only"
    | "target_pending";

  diff: {
    originalToCover: CandidateDiffSummary | null;
    coverToKnowledge: CandidateDiffSummary | null;
    originalToKnowledge: CandidateDiffSummary | null;
  };
};

type CandidateDiffSummary = {
  titleChanged: boolean;
  bodyChanged: boolean;
  typeChanged: boolean;
  importanceDelta: number | null;
  confidenceDelta: number | null;
  bodySimilarity: number;
  summary: string[];
};
```

### Outcome 算出

| 条件 | outcome |
|---|---|
| `knowledge` が存在する | `stored` |
| `cover.status = knowledge_ready` かつ `knowledge` がない | `ready_not_finalized` |
| `cover.status in duplicate, near_duplicate, insufficient` | `rejected` |
| `cover.status in tool_failed, provider_failed, parse_failed` | `retryable` |
| `cover` がなく target が `pending` / `running` 中 | `target_pending` |
| `cover` がなく target が停止・完了済み | `candidate_only` |

`target_pending` と `candidate_only` が両方成立しそうに見える場合は、target が `pending` / `running` なら `target_pending` を優先する。停止・完了済み target に cover がない場合は `candidate_only` とする。

candidate がまだ 1 件もない target はこの API では返さない。`target_pending` は target queue 全体の pending 数ではなく、candidate 行を持つ target の未 cover 状態だけを表す。

### DB query 方針

基本 query は `find_candidate_results` 起点にする。

```sql
with candidate_base as (
  select
    f.id,
    f.target_state_id,
    f.candidate_index,
    f.title as original_title,
    f.content as original_body,
    f.status as original_status,
    f.created_at as original_created_at,
    f.updated_at as original_updated_at,
    t.target_kind,
    t.target_key,
    t.source_uri,
    t.status as target_status,
    t.phase as target_phase,
    t.last_outcome_kind,
    t.last_error,
    t.updated_at as target_updated_at,
    c.status as cover_status,
    c.stage as cover_stage,
    c.type as cover_type,
    c.title as cover_title,
    c.body as cover_body,
    c.importance as cover_importance,
    c.confidence as cover_confidence,
    c.references as cover_references,
    c.duplicate_refs as cover_duplicate_refs,
    c.tool_events as cover_tool_events,
    c.reason as cover_reason,
    c.updated_at as cover_updated_at
  from find_candidate_results f
  join distillation_target_states t on t.id = f.target_state_id
  left join cover_evidence_results c on c.id = f.id
),
candidate_with_knowledge as (
  select b.*, k.*
  from candidate_base b
  left join lateral (
    select
      id as knowledge_id,
      type as knowledge_type,
      status as knowledge_status,
      scope as knowledge_scope,
      title as knowledge_title,
      body as knowledge_body,
      importance as knowledge_importance,
      confidence as knowledge_confidence,
      updated_at as knowledge_updated_at
    from knowledge_items
    where metadata ->> 'coverEvidenceResultId' = b.id::text
       or metadata ->> 'sourceUri' = concat('cover-evidence-result://', b.id::text)
    order by updated_at desc
    limit 1
  ) k on true
)
select *
from candidate_with_knowledge
```

実装ではこの CTE に filter / pagination / stats を重ねる。Drizzle の typed select で `left join lateral` が扱いづらい場合は、この read-only repository に限って ``db.execute(sql`...`)`` の raw SQL を使ってよい。その場合も query param は zod validation 後に bind し、文字列連結で SQL を組み立てない。

`latestUpdatedAt` は SQL 側で `greatest(...)` により算出する。`cover` / `knowledge` がない場合は `original_updated_at` を fallback にする。

Knowledge との join は JSONB metadata lookup になるため、実装時に migration と schema index を追加する。

```sql
create index if not exists knowledge_items_cover_evidence_result_id_idx
on knowledge_items ((metadata ->> 'coverEvidenceResultId'));

create index if not exists knowledge_items_metadata_source_uri_idx
on knowledge_items ((metadata ->> 'sourceUri'));
```

重複で複数 Knowledge が見つかる場合は、`updated_at desc` で最新 1 件を表示する。ただし通常は `sourceUri` upsert により 1 件に収束する想定。

`count` / `stats` は同じ CTE から算出する。`stats` 用 query では `outcome` filter だけ外し、`query` / `targetKind` / `hasKnowledge` / `targetStateId` は維持する。

## 差分設計

差分は 3 つに分ける。

| 差分 | 目的 |
|---|---|
| Original -> Covered | evidence coverage / dedupe / scoring で何が変わったかを見る |
| Covered -> Knowledge | finalize 後に保存内容が変わったかを見る |
| Original -> Knowledge | ユーザーが知りたい最終的な before / after を見る |

最初の実装では server 側で軽量な summary を作り、UI は summary と本文比較を表示する。

summary の算出:

- `titleChanged`: trim 後の完全一致で判定。
- `bodyChanged`: trim 後の完全一致で判定。
- `typeChanged`: `cover.type` と `knowledge.type`、または original の type なしからの付与を判定。
- `importanceDelta`: `knowledge.importance - cover.importance`。片方がなければ `null`。
- `confidenceDelta`: `knowledge.confidence - cover.confidence`。片方がなければ `null`。
- `bodySimilarity`: token bigram または単語集合 Jaccard による 0-1 の deterministic score。
- `summary`: UI badge 用の短い文言配列。

Original には type / importance / confidence がないため、`Original -> Covered` と `Original -> Knowledge` の score delta は `null` にする。代わりに summary へ `quality assigned` のような短い badge 文言を入れる。

本文の inline diff は初期実装では必須にしない。まずは 3 ペイン比較と changed badge で十分に使えるようにする。inline diff が必要になったら、frontend に小さな token diff helper を追加する。

## UI 設計

新規 page を追加する。

| ファイル | 種別 | 内容 |
|---|---|---|
| `web/src/modules/admin/components/candidates.page.tsx` | NEW | Candidate 一覧画面 |
| `web/src/modules/admin/repositories/admin.repository.ts` | MODIFY | API response 型と `fetchCandidateItems()` を追加 |
| `web/src/modules/admin/components/app-shell.tsx` | MODIFY | nav に `Candidates` を追加し、full-width 対象にする |
| `web/src/App.tsx` | MODIFY | `/candidates` route を追加 |
| `e2e/ui-smoke.spec.ts` | MODIFY | `/api/candidates` mock と Candidates page smoke を追加 |

画面は既存の Knowledge / Sources と同じ admin tool の密度にする。説明文や landing page は作らず、最初の画面から一覧・絞り込み・比較ができる状態にする。

UI は既存の `Button` / `Input` / `Select` / `Table` / `Badge` を使う。read-only 画面なので action button は refresh と row expansion だけにする。

### 画面構成

上部 summary:

- total candidates
- stored knowledge
- ready not finalized
- rejected
- retryable
- target pending

filter toolbar:

- search input
- target kind select
- outcome select
- has knowledge select
- refresh button

main table:

| column | 内容 |
|---|---|
| Target | `targetKind`、`targetKey`、candidate index |
| Candidate | original title と短い body preview |
| Coverage | cover status、stage、reason |
| Knowledge | knowledge status、type、id link |
| Quality | importance / confidence |
| Diff | title/body/type/score changed badge |
| Updated | `latestUpdatedAt` |

row expansion:

- `Original Candidate` pane
- `Covered Candidate` pane
- `Final Knowledge` pane
- `Lineage` pane: `targetStateId`、`findCandidateResultId`、`coverEvidenceResultId`、`knowledgeId`、`sourceUri`
- `Evidence` pane: references count、duplicateRefs count、toolEvents count、reason

初期版では row expansion を default closed にする。candidate body は長くなり得るため、table 行の高さを固定し、展開時だけ全文を出す。

`sourceUri` は target の source document / source memory URI、`finalizeSourceUri` は `cover-evidence-result://<candidateId>` として分けて表示する。

### Knowledge への導線

Knowledge が存在する candidate には、`knowledge.id` を表示し、既存 Knowledge 画面へ遷移できる導線を用意する。

初期実装で既存 `/knowledge` が item id query を受け取れない場合は、まず copyable id 表示だけにする。Knowledge page 側の id focus 機能は別改善でよい。

## 実装フェーズ

### Phase 0: schema / migration

実装対象:

- `src/db/schema.ts`
- `drizzle/0026_knowledge_candidate_metadata_indexes.sql`
- `drizzle/meta/_journal.json`

作業:

1. `knowledgeItems` の table definition に `metadata ->> 'coverEvidenceResultId'` と `metadata ->> 'sourceUri'` の index を追加する。
2. `CREATE INDEX IF NOT EXISTS` の migration を追加する。
3. migration journal に `0026_knowledge_candidate_metadata_indexes` を追加する。

完了条件:

- `bun run db:migrate` を safe DB に対して実行できる。
- schema と migration の index 名が一致している。

### Phase 1: API read model

実装対象:

- `api/modules/candidates/candidates.repository.ts`
- `api/modules/candidates/candidates.routes.ts`
- `api/app.ts`

作業:

1. query schema を zod で定義する。
2. `find_candidate_results` 起点の read-only CTE を作る。
3. `outcome` を repository 層で算出する。
4. `CandidateDiffSummary` を deterministic に算出する。
5. `latestUpdatedAt` を API read model で算出する。
6. `items` / `total` は全 filter、`stats` は `outcome` 以外の filter から返す。
7. 複数 Knowledge hit は `updated_at desc` の 1 件に正規化する。

完了条件:

- `/api/candidates` が pagination 付きで candidate を返す。
- Knowledge 化済み candidate が `knowledge !== null` になる。
- `ready_not_finalized`、`rejected`、`retryable` が区別できる。

### Phase 2: frontend repository / route

実装対象:

- `web/src/modules/admin/repositories/admin.repository.ts`
- `web/src/modules/admin/components/app-shell.tsx`
- `web/src/App.tsx`

作業:

1. `CandidateListItem` / `CandidateListResponse` 型を追加する。
2. `fetchCandidateItems(input)` を追加する。
3. nav に `Candidates` を追加する。
4. `/candidates` route を追加する。

完了条件:

- React Router で `/candidates` が開ける。
- API fetcher が型エラーなく使える。

### Phase 3: Candidate 一覧 UI

実装対象:

- `web/src/modules/admin/components/candidates.page.tsx`

作業:

1. TanStack Query で `/api/candidates` を読む。
2. summary metrics を表示する。
3. filter toolbar を作る。
4. table を作る。
5. row expansion で 3 ペイン比較を出す。

完了条件:

- Candidate 一覧で Knowledge 化済み / 未 Knowledge 化を一目で区別できる。
- row expansion から Original / Covered / Final Knowledge を比較できる。
- rejected / retryable の reason が見える。

### Phase 4: diff 表示の調整

作業:

1. diff badge の文言を整理する。
2. body similarity の表示を 0-100% に丸める。
3. title/body/type/score の変化を badge として出す。
4. 長文 body は scroll area に入れ、table layout を崩さない。

完了条件:

- 「元候補から Knowledge 化で何が変わったか」が、展開行だけで判断できる。
- `cover` がない candidate、`knowledge` がない candidate でも表示が壊れない。

### Phase 5: smoke / verification wiring

実装対象:

- `test/api.routes.test.ts`
- `test/candidates.repository.integration.test.ts`
- `e2e/ui-smoke.spec.ts`

作業:

1. API route test で query default、invalid enum、pagination response を確認する。
2. repository integration test で candidate / cover / knowledge / target の seed data を作り、join と outcome を確認する。
3. Playwright smoke に `/api/candidates` mock を追加し、nav から Candidates page が開けて row expansion が表示できることを確認する。

完了条件:

- route-level mock test が DB なしで通る。
- safe DB integration test が JSONB metadata join と stats を実データで検証する。
- UI smoke が Candidates nav、summary、table、row expansion を確認する。

## テスト計画

API:

- candidate だけ存在する行が `candidate_only` になる。
- candidate row はあるが target が `pending` / `running` で cover がない行が `target_pending` になる。
- candidate がない target-only row は `/api/candidates` に出ない。
- `cover.status = knowledge_ready` で Knowledge がない行が `ready_not_finalized` になる。
- Knowledge metadata の `coverEvidenceResultId` で join できる。
- Knowledge metadata の `sourceUri = cover-evidence-result://<id>` で join できる。
- `coverEvidenceResultId` / `sourceUri` の両方に hit する場合も、1 candidate につき Knowledge は 1 件だけ返る。
- `duplicate` / `near_duplicate` / `insufficient` が `rejected` になる。
- `tool_failed` / `provider_failed` / `parse_failed` が `retryable` になる。
- `query`、`targetKind`、`hasKnowledge`、`outcome` filter が効く。
- `stats` は `outcome` filter を外した件数、`total` は `outcome` filter 込みの件数になる。
- `latestUpdatedAt` は target / original / cover / knowledge の最大時刻になる。

frontend:

- `/candidates` route が render できる。
- loading / error / empty state が表示できる。
- Knowledge あり / なしの行で table と row expansion が崩れない。
- long body で layout が横に破綻しない。
- `/candidates` が nav に出て、`app-content.full-width` で表示される。

品質ゲート:

```sh
bun run verify
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run db:migrate
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test MEMORY_ROUTER_RUN_DB_TESTS=1 bunx vitest run test/candidates.repository.integration.test.ts
```

## 実装時の注意

- `distillation_target_states.knowledgeIds` は補助情報として扱い、candidate と Knowledge の主 join には使わない。
- candidate UI は read-only から開始する。状態変更 API は後続計画に分ける。
- diff summary は LLM に作らせない。UI の監査情報なので deterministic に計算する。
- `cover_evidence_results.reason` は短い machine-readable reason として扱い、UI で過度に自然文補完しない。
- `toolEvents` や `references` の全文表示は初期実装では避け、まず count と compact preview にする。
- API response は巨大化しやすいので、一覧では body 全文を返すが `limit <= 200` を守る。将来必要なら detail endpoint を分ける。

## 後続改善

初期実装後に検討する機能:

- `/api/candidates/:id` の detail endpoint。
- Knowledge page で `?id=<knowledgeId>` を受け取り、対象 item を focus する。
- candidate 単位の rerun coverEvidence。
- `knowledge_ready` だが未 finalize の candidate を手動 finalize する admin action。
- inline token diff。
- duplicate / near_duplicate の対応 Knowledge をクリックして比較する UI。
- target 単位の pipeline timeline 表示。
