# Context Field Eval MVP Plan

> Status: planning draft
> Scope: Knowledge Landscape を評価可能な知識場へ進めるための実行順
> Date: 2026-05-25

## 1. 背景

前提となる考え方は次である。

```txt
knowledge = saved text
```

ではなく、

```txt
knowledge = task state を特定の判断・手順へ収束させる地形
```

として扱う。

ただし、次の段階でいきなり production ranking を変えるべきではない。現在の Knowledge Landscape は observe / explain / replay まで進んでおり、rank / auto-mutate はまだ慎重に扱う段階である。

そのため、次に作るべきものは「地形を変形する機能」ではなく、「変形してよいかを測る評価系」である。

## 2. 目的

`context_compile` と Knowledge Landscape の改善を、感覚ではなく replay と feedback で判断できるようにする。

目指す状態:

- context pack の改善が定量的に比較できる
- used された baseline knowledge の損失を検出できる
- off_topic / wrong の再選出を検出できる
- dead zone repair の効果を確認できる
- ranking や appliesTo 修正を production へ入れる前に安全性を見られる

## 3. 非ゴール

- AGI 的な新しい推論エンジンを作らない
- `context_compile` と別の主経路を作らない
- production ranking を初期 MVP で変更しない
- auto-mutate / auto-merge / auto-apply をしない
- LLM による曖昧な後処理で評価結果を補正しない

## 4. 実行順

### Step 1: `eval:context` を read-only で作る

最初の成果物:

```txt
bun run eval:context --from-replay --window 30 --json
```

最初は DB へ書かない。既存の replay corpus と current retrieval dry-run だけを使う。

評価指標:

- `retentionScore`
  - 以前 `used` だった knowledge が現在も取得できるか
- `churnScore`
  - current retrieval の入れ替わりが過剰でないか
- `repulsionScore`
  - `wrong` / `off_topic` が再選出されにくくなっているか
- `reachabilityScore`
  - dead zone knowledge が到達可能になっているか
- `stabilityScore`
  - `degraded` / `no current match` / `no content` が増えていないか

実装上は、既存の `buildLandscapeReplayComparison` を評価レポートとして読み替えるところから始める。

### Step 2: `used_baseline_retention` を最初の ranking 実験候補にする

現在の replay comparison は、used baseline が current retrieval から落ちるケースを検出できる。

最初に試すべき実験は、negative repulsion より `used_baseline_retention` である。

理由:

- `used` は正の feedback として解釈しやすい
- off_topic / wrong が少ない状態では、負の repulsion より安全に評価できる
- retention は「過去に役立ったものを失わない」だけなので rollback しやすい

この段階でも production ranking には入れない。`eval:context` 上で before / after を比較するだけに留める。

### Step 3: feedback coverage を上げる

Landscape の分類は feedback が不足すると不安定になる。

必要な作業:

- context pack item 単位の `used` / `not_used` / `wrong` / `missing` を登録しやすくする
- Admin UI / MCP / CLI のうち、まず最小の registration path を決める
- feedback が入った run を `eval:context` の優先 corpus にする

ここで重要なのは、feedback を長文説明ではなく item 単位の軽い判定として集めることである。

### Step 4: dead zone repair を評価ループに入れる

dead zone は削除候補ではない。

まず次を切り分ける。

- 本当に不要
- source evidence はあるが retrieval が届いていない
- appliesTo が空、広すぎる、狭すぎる
- title / body が検索 query と噛み合っていない
- niche で該当タスクがまだ来ていない

実行順:

1. `dead_zone_reachability_risk` を review item として確認
2. appliesTo / title / body の repair candidate を作る
3. `eval:context` で repair 前後を replay 比較する
4. 改善があるものだけ approval flow に進める

### Step 5: production ranking はまだ変えない

ranking 変更は次が揃ってから扱う。

- `eval:context` が before / after を出せる
- feedback coverage が一定以上ある
- used baseline retention が replay 上で悪化しない
- dead zone repair の副作用が見える
- promotion gate が `review_required` の理由を説明できる

この条件を満たすまでは、Landscape 由来の intervention は observe-only または sandbox に留める。

## 5. MVP 成果物

### CLI

```txt
bun run eval:context
```

出力:

- summary
- scores
- risky runs
- used baseline lost
- high churn runs
- no current match runs
- recommended next action

### API

初期 MVP では API は必須ではない。

Overview に表示する場合は `/api/overview` に縮約 summary を追加する。

### UI

初期 MVP では `Overview` の Landscape Dashboard item と接続する。

表示するもの:

- replay overlap
- used baseline lost
- high churn
- promotion gate
- compile intervention strategy

詳細分析は Graph 画面へ送る。

## 6. 受け入れ条件

- `eval:context` が replay corpus から read-only report を出せる
- production ranking を変更しない
- used baseline loss が数値として見える
- high churn と no current match が数値として見える
- promotion gate の状態が report に含まれる
- Overview の Landscape item と同じ意味の指標を共有できる
- `bun run typecheck`
- 関連 unit test

## 7. 後続フェーズ

### Phase 2: 評価ケースの永続化

- JSONL または DB table で evaluation cases を保存
- expected / forbidden / missing knowledge を明示
- before / after を比較可能にする

### Phase 3: ranking sandbox

- used baseline retention
- negative repulsion
- diversity exploration
- basin-aware query expansion dry-run

すべて production off のまま比較する。

### Phase 4: approval workflow 連携

- eval で改善した repair candidate だけ approval に進める
- approval 後のみ finalize / apply 可能にする
- rollback / deprecate の理由も残す

## 8. 判断

次の一手は `eval:context` である。

Knowledge Landscape の思想を実装へ進めるには、まず地形を変形する力ではなく、地形の変形が本当に改善かどうかを測る計測器が必要である。

この MVP ができれば、以後の retention boost、dead zone repair、negative repulsion、basin-aware query expansion をすべて replay-backed に判断できる。
