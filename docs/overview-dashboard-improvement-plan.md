# Overview Dashboard 改修 実装計画

作成日: 2026-05-20
対象リポジトリ: `memory-router`
対象画面: `web/src/modules/admin/components/overview.page.tsx`

## レビュー結果

実装推奨。現行 Overview は運用判断に使う画面としては No-Go。

理由は、表示値の一部が DB の実数ではなく、ページ表示用 API の取得件数や graph snapshot の可視ノード数に依存しているため。`Vibe Memory` は `fetchVibeMemories()` の default limit 120 件をそのまま表示しており、実 DB 総数ではない。`Graph Nodes` も現在は `334` で総 knowledge 数と一致しているが、`fetchGraphSnapshot()` の limit を超えると可視ノード数に化ける。

この計画では Overview 専用 read model API を追加し、KPI と chart をすべて同じ DB snapshot から返す。UI はその read model だけを正として表示する。

## 現状確認

### 画面上の問題

`overview.page.tsx` は次の endpoint を個別に呼び、返却配列や既存診断 report をそのままカード化している。

| 表示 | 現在の取得元 | 問題 |
|---|---|---|
| Knowledge | `GET /api/knowledge?limit=1` の `total` | 総数としては正しいが、status/type breakdown はない |
| Sources | `GET /api/sources/tree` の `items.length` | wiki working tree のページ数であり、DB indexed source / fragment / link 数とは別物 |
| Vibe Memory | `GET /api/vibe-memory?limit=120` の配列長 | 総数ではなく取得上限件数 |
| Graph Nodes | `GET /api/graph?limit=120` の `nodes.length` | graph 可視ノード数であり、総 knowledge 数ではない |
| Draft / Active / Dynamic Score | `GET /api/doctor` | 運用診断としては有用だが、Overview の全体集計と責務が混ざっている |

### 2026-05-20 時点の実 DB 例

ローカル DB で確認した実数:

| 項目 | 実数 |
|---|---:|
| Knowledge total | 334 |
| Knowledge active / draft / deprecated | 334 / 0 / 0 |
| Rules / procedures | 302 / 32 |
| Embedded knowledge | 334 |
| Active zero-use knowledge | 327 |
| Sources documents / fragments / links | 40 / 1235 / 254 |
| Knowledge with source links / without links | 254 / 80 |
| Vibe memory records / sessions | 1072 / 118 |
| Vibe memories with diffs / diff entries | 963 / 10462 |
| Compile runs total / ok / degraded / failed | 52 / 1 / 51 / 0 |
| Distillation targets total / pending / running / completed | 140 / 117 / 1 / 22 |

Dynamic Score は平均値だけでは読めない。現状は active knowledge 334 件中、327 件が `0`、7 件が `10+` であり、分布表示が必要。

## 目的

Overview を「DB 実態に合った運用ダッシュボード」にする。

この画面で答える問い:

- Knowledge は何件あり、active / draft / deprecated と rule / procedure はどう分かれているか。
- Source は wiki page 数だけでなく、DB indexed document / fragment / link coverage として健全か。
- Vibe Memory は総 record 数、session 数、diff 付き record 数がどう増えているか。
- Compile は直近で成功しているか、degraded がどの程度多いか。
- Dynamic Score と usage は偏っていないか。
- Doctor degraded の理由は何で、次に見るべき領域はどこか。

## 非目的

- Knowledge ranking、retrieval、distillation pipeline のロジック変更。
- `doctor` の診断判定基準変更。
- Graph 画面の layout / force graph 改修。
- Vibe Memory 画面の session 表示変更。
- KPI のためだけの denormalized table 追加。初期実装は DB aggregate query で十分。
- live refresh / WebSocket。初期版は TanStack Query の手動 refresh または短い refetch interval で足りる。

## 方針

### 1. Overview 専用 API を追加する

新規 API module:

| ファイル | 種別 | 内容 |
|---|---|---|
| `api/modules/overview/overview.repository.ts` | NEW | Overview 用 read model を DB から集計する |
| `api/modules/overview/overview.routes.ts` | NEW | `GET /api/overview` を提供する |
| `api/app.ts` | MODIFY | `/api/overview` を mount する |
| `src/shared/schemas/overview.schema.ts` | NEW | API response schema と frontend 共有型 |
| `web/src/modules/admin/repositories/admin.repository.ts` | MODIFY | `fetchOverviewDashboard()` を追加する |
| `web/src/modules/admin/components/overview.page.tsx` | MODIFY | 複数 query を専用 query 1 本に置き換える |
| `web/src/styles.css` | MODIFY | dashboard / chart layout の CSS を追加する |
| `test/api.routes.test.ts` | MODIFY | route contract test を追加する |

`doctor` は runtime health の正本として残す。ただし Overview 画面は `GET /api/overview` 経由で doctor summary を受け取る。画面側が `doctor` と各種 list API を直接合成しない。

### 2. 表示値の命名を正確にする

KPI のラベルは「何を数えているか」が分かる名前にする。

| 旧表示 | 新表示 | 正本 |
|---|---|---|
| Knowledge | Knowledge Items | `knowledge_items count(*)` |
| Sources | Wiki Pages / Indexed Sources | wiki tree pages と `sources` を分ける |
| Vibe Memory | Vibe Records | `vibe_memories count(*)` |
| Graph Nodes | Knowledge Graph Coverage | `knowledge total / embedded / source-linked` |
| Dynamic Score Avg | Dynamic Score Distribution | bucketed histogram |
| Active Knowledge unused | Active Usage Coverage | `compile_select_count > 0` と `= 0` |

`Graph Nodes` というカードは削除する。Overview では graph snapshot の描画対象数ではなく、knowledge graph coverage を見る方が実用的。

### 3. Recharts を導入する

`recharts` は現在 package に入っていない。実装時に dependency として追加する。

```bash
bun add recharts
```

使う chart は次に限定する。

| Chart | Component | 理由 |
|---|---|---|
| Knowledge status/type | `BarChart` stacked | active/draft/deprecated と rule/procedure を同時に見られる |
| Dynamic score buckets | `BarChart` | 現状の `0` 偏重を明示できる |
| Compile run health by day | `ComposedChart` or stacked `BarChart` | ok/degraded/failed と avg duration を同時に追える |
| Vibe memory daily records | `LineChart` or `BarChart` | ingestion spike と停滞が分かる |
| Source link coverage | `PieChart` or two-value `BarChart` | linked / unlinked knowledge を即座に見られる |

初期版では chart component を増やしすぎない。KPI cards + 4 charts + health panel までに絞る。

## API response 設計

```ts
export const overviewDashboardSchema = z.object({
  checkedAt: z.string().datetime(),
  health: z.object({
    status: z.enum(["ok", "degraded", "failed"]),
    reasons: z.array(z.string()),
    nextActions: z.array(z.string()),
  }),
  kpis: z.object({
    knowledgeTotal: z.number().int().nonnegative(),
    activeKnowledge: z.number().int().nonnegative(),
    draftKnowledge: z.number().int().nonnegative(),
    deprecatedKnowledge: z.number().int().nonnegative(),
    rules: z.number().int().nonnegative(),
    procedures: z.number().int().nonnegative(),
    embeddedKnowledge: z.number().int().nonnegative(),
    zeroUseActiveKnowledge: z.number().int().nonnegative(),
    wikiPages: z.number().int().nonnegative(),
    indexedSources: z.number().int().nonnegative(),
    sourceFragments: z.number().int().nonnegative(),
    sourceLinks: z.number().int().nonnegative(),
    linkedKnowledge: z.number().int().nonnegative(),
    unlinkedKnowledge: z.number().int().nonnegative(),
    vibeRecords: z.number().int().nonnegative(),
    vibeSessions: z.number().int().nonnegative(),
    vibeRecordsWithDiffs: z.number().int().nonnegative(),
    agentDiffEntries: z.number().int().nonnegative(),
    compileRuns: z.number().int().nonnegative(),
    compileOkRuns: z.number().int().nonnegative(),
    compileDegradedRuns: z.number().int().nonnegative(),
    compileFailedRuns: z.number().int().nonnegative(),
  }),
  charts: z.object({
    knowledgeByStatusType: z.array(z.object({
      status: z.string(),
      rule: z.number().int().nonnegative(),
      procedure: z.number().int().nonnegative(),
    })),
    dynamicScoreBuckets: z.array(z.object({
      bucket: z.string(),
      count: z.number().int().nonnegative(),
    })),
    compileRunsByDay: z.array(z.object({
      day: z.string(),
      ok: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      avgDurationMs: z.number().nullable(),
    })),
    vibeRecordsByDay: z.array(z.object({
      day: z.string(),
      records: z.number().int().nonnegative(),
    })),
    sourceCoverage: z.array(z.object({
      label: z.enum(["linked", "unlinked"]),
      count: z.number().int().nonnegative(),
    })),
    distillationQueue: z.array(z.object({
      targetKind: z.enum(["wiki_file", "vibe_memory"]),
      pending: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      paused: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })),
  }),
});
```

補足:

- `day` は `YYYY-MM-DD` の日付文字列に正規化する。
- 日別 series は直近 14 日を default にする。
- `knowledgeByStatusType` は存在しない status/type の組み合わせも 0 で返し、chart の系列が揺れないようにする。
- `health.nextActions` は doctor の `mcp.nextActions` と distillation next actions を短く集約する。

## DB 集計方針

### Knowledge

`knowledge_items` を正本にする。

- status/type breakdown
- embedded count
- active zero-use count
- source link coverage
- dynamic score bucket

Dynamic Score bucket:

| bucket | 条件 |
|---|---|
| `0` | `dynamic_score = 0` |
| `0-1` | `0 < dynamic_score <= 1` |
| `1-5` | `1 < dynamic_score <= 5` |
| `5-10` | `5 < dynamic_score <= 10` |
| `10+` | `dynamic_score > 10` |

### Sources

2 種類を分ける。

- wiki pages: `listPages(groupedConfig.sourceContent.root)` の件数。
- indexed sources: `sources`, `source_fragments`, `knowledge_source_links` の件数。

Overview では `Sources` という単一カードにまとめない。`Wiki Pages` と `Indexed Sources` を別カードにする。

### Vibe Memory

`vibe_memories` と `agent_diff_entries` を正本にする。

- total records
- distinct sessions
- records with diffs
- diff entries
- daily records

既存 `GET /api/vibe-memory` は一覧取得 API として残し、Overview では使わない。

### Compile Runs

`context_compile_runs` を正本にする。

- total / ok / degraded / failed
- recent 14 day counts
- avg duration per day
- doctor の直近 window stats は health panel に表示する

全期間の total と doctor の window stats を混同しない。

### Distillation Queue

`distillation_target_states` を正本にする。

- target kind 別 status breakdown
- queued/running の operational pressure
- candidate page への導線

## UI 設計

### Layout

Overview は中央寄せカード一覧ではなく、full-width dashboard にする。`AppShell` の `full-width` 対象に `/` または Overview 専用判定を入れるか、Overview page 内で dashboard width を広げる。ただし既存 `/compile`、`/vibe-memory` と同様、横幅を使う画面として扱う。

構成:

1. Header
   - title: `Overview`
   - status badge
   - checkedAt
   - refresh button
2. KPI strip
   - 6-8 個に絞る
   - 各 card は primary value + secondary split を持つ
3. Chart grid
   - Knowledge lifecycle
   - Dynamic score distribution
   - Compile health
   - Vibe memory ingestion
   - Source coverage
   - Distillation queue
4. Health panel
   - doctor reasons
   - next actions
   - runtime reachability

### KPI 初期案

| Card | Primary | Secondary |
|---|---|---|
| Knowledge Items | total | active / draft / deprecated |
| Knowledge Types | rules | procedures |
| Usage Coverage | used active | unused active |
| Sources | wiki pages | indexed docs / fragments |
| Vibe Records | records | sessions / records with diffs |
| Compile Health | degraded rate | ok / degraded / failed |
| Source Coverage | linked knowledge | unlinked knowledge |
| Distillation Queue | queued/running | completed / failed |

### Visual Tone

- Operational dashboard として、密度高め、余白控えめにする。
- グラフは装飾ではなく比較のために使う。
- 色は status semantic に寄せる。
  - ok: green
  - degraded / warning: amber
  - failed: red
  - neutral series: slate / blue / cyan 程度
- 一色テーマに寄せない。
- chart legend と tooltip は必須。

## 実装順序

### Phase 1: API read model

1. `src/shared/schemas/overview.schema.ts` を追加する。
2. `api/modules/overview/overview.repository.ts` を追加する。
3. `api/modules/overview/overview.routes.ts` を追加する。
4. `api/app.ts` に `/api/overview` を mount する。
5. `test/api.routes.test.ts` に contract test を追加する。

受け入れ条件:

- `GET /api/overview` が schema valid な JSON を返す。
- `Vibe Records` は limit 付き一覧ではなく DB total を返す。
- `Graph Nodes` 的な可視件数は KPI に含めない。
- 日別 series は日付昇順で返る。

### Phase 2: Frontend repository + charts

1. `bun add recharts`。
2. `admin.repository.ts` に `OverviewDashboard` type と `fetchOverviewDashboard()` を追加する。
3. `overview.page.tsx` を `useQuery(["overview-dashboard"], fetchOverviewDashboard)` に置き換える。
4. chart component を同一 file か `overview-charts.tsx` に切り出す。
5. loading/error/empty state を追加する。

受け入れ条件:

- Overview の表示値は `/api/overview` response だけから出る。
- `Vibe Memory 120` のような limit 由来の表示が消える。
- Dynamic Score が平均だけでなく bucket chart で読める。
- Doctor reasons が見える。

### Phase 3: Layout / polish

1. Overview を full-width dashboard として扱う。
2. `web/src/styles.css` に dashboard grid / chart card CSS を追加する。
3. desktop では chart 2 columns、mobile では 1 column にする。
4. 長い reason / next action がカード外にはみ出ないようにする。
5. Playwright で desktop / mobile screenshot を確認する。

受け入れ条件:

- 1440px 幅で chart grid が画面幅を使う。
- 390px mobile でも KPI と chart text が重ならない。
- card 内に card を入れない。
- tooltip / legend の文字がはみ出ない。

## テスト計画

### Unit / API

- `test/api.routes.test.ts`
  - `/api/overview` の 200 response と schema shape。
  - repository mock が 0 件を返しても valid response。
- 可能なら `test/repositories.integration.test.ts`
  - seeded rows から knowledge breakdown、vibe total、source coverage、daily series を検証。

### Frontend

- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run build:web`
- `bun run test:ui` または既存 UI test が重ければ targeted test。

### Visual

dev server または preview server で確認する。

- `/` desktop 1440x900
- `/` mobile 390x844

確認点:

- `Vibe Records` が DB total と一致する。
- Dynamic score bucket chart が表示される。
- Compile health chart が degraded 偏重を見せる。
- Runtime health reason が読める。

## ロールバック

- API 追加は既存 endpoint を壊さない。
- Overview UI が問題を起こした場合は `overview.page.tsx` を旧実装に戻すだけで既存画面に戻せる。
- `recharts` 追加で bundle size が問題になった場合は、Phase 2 の chart component を CSS-only mini bars に差し替えられるよう、`OverviewDashboard` API response は chart library 非依存にする。

## 完了条件

- Overview の KPI が DB 実数または明示された診断 window のどちらかに分類され、表示上も混同しない。
- `Vibe Memory` の表示が取得 limit に依存しない。
- `Graph Nodes` が可視件数ではなく coverage として表現される。
- Dynamic Score が平均値だけでなく分布で読める。
- Doctor degraded reasons と next actions が Overview から確認できる。
- `bun run verify` が通る。DB integration が必要な確認は `MEMORY_ROUTER_RUN_DB_TESTS=1` の targeted test で実施する。

## 実装前セルフレビュー

### 指摘 1: API と doctor の責務が重複する

改善: Overview API は doctor を置き換えない。doctor は health 判定の正本、Overview API は dashboard read model の正本とする。Overview API が doctor の reasons / next actions を短く含むのは UI 表示のためで、判定ロジックは doctor に残す。

### 指摘 2: Wiki page 数と indexed source 数が別物で混乱する

改善: `Wiki Pages` と `Indexed Sources` を別 KPI にする。Sources という単一ラベルを避ける。

### 指摘 3: Recharts 導入で依存と bundle size が増える

改善: 初期 chart は 4-6 個に絞る。response は chart library 非依存の単純配列にし、問題があれば CSS mini chart に戻せるようにする。

### 指摘 4: 日別 series の timezone が曖昧

改善: 初期実装では DB timestamp を `date_trunc('day', created_at)` で集計し、API response に `timezone: "database"` を含めない代わりに tooltip で日付だけを表示する。将来 JST 固定が必要なら query param ではなく server config で統一する。

### 指摘 5: すべてを一度に UI 実装するとレビューが難しい

改善: Phase 1 API read model と tests を先に作り、response fixture を見てから Phase 2 UI に進む。UI 実装前に `/api/overview` の数字を DB spot check と照合する。

このレビュー後の残課題は実装時の検証に落とし込まれており、計画としての不足はない。
