# Knowledge Landscape Overview Dashboard Plan

> Status: planning draft
> Scope: Overview に Landscape 指標を追加するための実装計画
> Date: 2026-05-25

## 1. 背景

Knowledge Landscape はすでに Graph 画面で詳細確認できるが、Overview ではまだ状態を把握できない。

現状の Overview は次の 3 領域で構成されている。

- `Knowledge Assets`
- `System Quality & Health`
- `LLM Resources & Cost`

Landscape 指標は `Knowledge Assets` の詳細そのものではなく、knowledge corpus が実運用でどの程度「使える地形」になっているかを見る指標である。そのため Overview では、Graph の詳細 UI を移植するのではなく、運用判断に必要なサマリーだけを表示する。

## 2. 目的

Overview で次を一目で判断できるようにする。

- knowledge corpus に有効な attractor があるか
- dead zone や over-selected not used が増えていないか
- replay comparison 上、現在の retrieval が安定しているか
- production ranking 変更に進んでよい状態か、まだ review が必要か

この Dashboard アイテムは、Graph 画面の代替ではない。Graph に入る前の health summary として扱う。

## 3. 非ゴール

- Graph 画面の Landscape パネルを Overview にそのまま移植しない
- node / edge / trajectory の詳細表示はしない
- production ranking の変更はしない
- auto-mutate / auto-merge / auto-apply はしない
- Overview 初期表示を重くするための全 run 詳細取得はしない

## 4. 表示方針

既存 Overview と違和感を出さないため、独立した派手な可視化ではなく、既存の domain section と同じ構造を使う。

推奨配置は `Knowledge Assets` の下である。

```txt
左カラム
  Knowledge Assets
  Knowledge Landscape Health

右カラム
  System Quality & Health
  LLM Resources & Cost
```

理由:

- Landscape は knowledge corpus の運用品質なので `Knowledge Assets` に近い
- `System Quality` は runtime / queue / API health を扱っており、Landscape を混ぜると意味がぼやける
- Graph への導線を持つため、左カラムで knowledge 系のまとまりとして読む方が自然

## 5. Dashboard アイテム案

### 5.1 セクション名

表示名:

```txt
Knowledge Landscape Health
```

サブタイトル:

```txt
Attractor, reachability, and replay stability
```

アクセント色:

- 既存 `Knowledge Assets` と近い emerald 系を使う
- ただし完全に同一ではなく、補助的に sky / amber / red を使う
- 画面全体が単色に見えないよう、メインは slate text と小さな状態色に留める

アイコン:

- `Network`, `Orbit`, `Activity`, `Map` のいずれか
- Graph 詳細ではなく health summary なので、第一候補は `Activity` または `Map`

### 5.2 ヘッダーバッジ

右上 badge は総合状態を出す。

候補:

```txt
Replay stable: 92.0%
```

または review が必要な場合:

```txt
Gate: review required
```

優先順位:

1. `promotionGateSummary.gateMode === "review_required"` なら `Gate: review required`
2. それ以外は `Replay stable: {averageOverlapRate}`
3. replay comparison が未取得なら `Observe only`

### 5.3 上段 3 指標

既存 Overview の 3 等分スタッツに合わせる。

```txt
Attractors
Dead zones
Replay overlap
```

具体値:

- `Attractors`: `strongAttractorCount + usefulAttractorCount`
- `Dead zones`: `deadZoneReachabilityCount + deadZoneStaleCount`
- `Replay overlap`: `averageOverlapRate`

補足:

- `Attractors` は緑
- `Dead zones` は amber、閾値超過時だけ red
- `Replay overlap` は通常 slate、低下時 amber/red

### 5.4 中段 breakdown

既存 `Status:` / `Content:` の行に近い密度で表示する。

```txt
Landscape:
  Strong: 9 | Useful: 31 | Negative: 0 | Over-selected: 7

Replay:
  Runs: 20 | Used lost: 2 | Churn: 18 | Gate: review_required
```

表示は折り返し前提にし、横スクロールを作らない。

### 5.5 下段 progress / risk bar

1 本目:

```txt
Field Health Mix
```

構成:

- strong/useful attractor
- neutral/feedback insufficient
- dead zone
- negative/over-selected

2 本目:

```txt
Replay Stability
```

構成:

- retained
- missing from current
- newly retrieved

ただし Overview では細かい内訳を全部読ませない。バーは傾向把握用にし、詳細は Graph への導線に任せる。

### 5.6 導線

セクション下部に軽いリンクまたはボタンを置く。

```txt
Open Graph Landscape
```

この導線は Graph 画面へ移動するだけでよい。Overview 内で review item の編集や candidate creation は行わない。

## 6. API 計画

### 6.1 追加先

初期実装では `/api/overview` の payload に `landscape` を追加する。

理由:

- Overview 画面はすでに `/api/overview` を 1 回取得する構成
- Dashboard item のために Graph API を複数回叩くと初期表示が不安定になる
- schema で Overview 用の縮約 shape を固定できる

### 6.2 追加 shape

概念上の shape:

```ts
landscape: {
  windowDays: number;
  generatedAt: string;
  snapshot: {
    totalCommunities: number;
    strongAttractorCount: number;
    usefulAttractorCount: number;
    negativeCandidateCount: number;
    overSelectedNotUsedCount: number;
    deadZoneReachabilityCount: number;
    deadZoneStaleCount: number;
    feedbackInsufficientCount: number;
    topRiskCount: number;
  };
  replay: {
    comparedRunCount: number;
    averageOverlapRate: number;
    usedBaselineLostItemCount: number;
    highChurnRunCount: number;
    currentNoMatchRunCount: number;
    promotionGateMode: "normal" | "review_required";
  };
}
```

### 6.3 データソース

使用する既存 service:

- `buildLandscapeSnapshot`
- `buildLandscapeReplayComparison`

Overview では detailed runs や candidates は含めない。

推奨パラメータ:

- `windowDays: 30`
- `limit: 1000`
- `status: "active"`
- `runStatus: "all"`
- `currentLimit: 12`
- `includeRuns: false`

### 6.4 性能境界

Landscape は重くなりやすいため、次のどちらかを必須にする。

1. snapshot cache が有効なら cache を使う
2. cache が無効でも Overview 用は縮約結果だけ返す

初期実装では、Overview のために run 詳細や trajectory candidates を取得しない。

## 7. UI 実装計画

### Phase 1: backend summary

対象:

- `src/shared/schemas/overview.schema.ts`
- `api/modules/overview/overview.repository.ts`
- 必要に応じて `src/modules/landscape/*`

作業:

- `overviewDashboardSchema` に `landscape` を追加
- `fetchOverviewDashboardForApi` で Landscape snapshot と replay comparison を取得
- Overview 専用に数値を縮約
- landscape 取得失敗時は Overview 全体を落とさず、`landscape.status = "unavailable"` のような fallback を検討する

### Phase 2: frontend component

対象:

- `web/src/modules/admin/components/overview.page.tsx`
- `web/src/modules/admin/components/overview/landscape-health-domain.tsx`
- `web/src/modules/admin/repositories/admin.repository.ts`

作業:

- `LandscapeHealthDomain` を新規作成
- `KnowledgeAssetsDomain` の下へ配置
- 既存 typography、badge、3 等分 stat、progress bar の密度に合わせる
- Graph への導線を付ける

### Phase 3: chart integration

初期実装では Recharts の大型 chart は不要。

必要になった場合だけ、`overview-charts.tsx` に次を追加する。

- `Landscape Health Mix`
- `Replay Stability Mix`

ただし 1 枚目は compact progress bar で十分であれば、chart card は増やさない。

### Phase 4: tests

対象:

- overview API schema test
- Overview page smoke test
- component test for `LandscapeHealthDomain`

確認:

- landscape summary が存在する場合に表示される
- replay comparison が review required の場合に badge が変わる
- landscape unavailable でも Overview 全体が壊れない
- mobile 幅で横スクロールしない

## 8. 受け入れ条件

- Overview に `Knowledge Landscape Health` が表示される
- `Attractors`, `Dead zones`, `Replay overlap` が 1 画面で把握できる
- `strong/useful/negative/over-selected` と `runs/used lost/churn/gate` が compact に見える
- Graph 詳細と役割が重複しない
- `/api/overview` の schema validation を通る
- landscape 取得失敗時に Overview 全体が error にならない
- `bun run typecheck`
- `bun run build:web`
- 関連 unit/component test

## 9. 表示優先度

最初に出すべき指標:

1. `strongAttractorCount + usefulAttractorCount`
2. `deadZoneReachabilityCount + deadZoneStaleCount`
3. `averageOverlapRate`
4. `usedBaselineLostItemCount`
5. `highChurnRunCount`
6. `promotionGateMode`

後回しにする指標:

- 全 risk list
- individual community table
- trajectory stage table
- contradiction overlay
- candidate draft creation

## 10. 判断

Overview に Landscape 指標を入れる価値はある。ただし、表示すべきなのは Graph 画面の詳細ではなく、knowledge corpus の health summary である。

実装は `Knowledge Assets` の下に compact domain section として追加するのが最も自然で、既存 Overview の情報設計とも衝突しない。
