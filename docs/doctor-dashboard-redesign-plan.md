# Doctor Dashboard Redesign Plan

> 作成日: 2026-05-21
> 対象画面: `http://localhost:5173/doctor`
> 目的: 既存の Doctor 画面を、Overview と同じ密度・見通しで運用状態を把握できる Dashboard へ刷新する。

---

## 1. 背景

`DoctorReport` は DB、Embedding、Agentic LLM、MCP surface、Agent Log Sync、Vibe/Source Distillation、Compile run health、Knowledge lifecycle まで広い診断情報を返している。一方で現在の `/doctor` 画面は、古いカードとテーブルでレポートを直列に表示しており、現在の運用上重要な問いにすぐ答えにくい。

特に現在の実データでは、Doctor は `degraded` であり、以下のような原因が同時に出ている。

- `KNOWLEDGE_ZERO_USE_HIGH`
- `VIBE_DISTILLATION_NEVER_RAN`
- `VIBE_DISTILLATION_PIPELINE_LOCK_STALE`
- `SOURCE_DISTILLATION_PIPELINE_LOCK_STALE`
- `ANTIGRAVITY_LOGS_SYNC_STALE`

これらは単独のテキストリストでは優先順位や規模感が見えにくい。Doctor 画面は「詳細な診断ログ」ではなく「運用判断の入口」として再設計する。

---

## 2. 現状コード

### Frontend

- `web/src/modules/admin/components/doctor.page.tsx`
  - 現在の Doctor 画面本体。
  - `Runtime`、`Embedding`、`Agent Log Sync`、`Vibe Distillation`、`Source Distillation`、`Reasons`、`HITL Backlog` を表示する。
  - Recharts は未使用。
- `web/src/modules/admin/components/overview.page.tsx`
  - Overview の Dashboard レイアウト。
  - KPI カード、Refresh、Doctor status badge、chart section を持つ。
- `web/src/modules/admin/components/overview-charts.tsx`
  - Recharts の利用パターン。
  - `BarChart`、`ComposedChart`、`LineChart`、`Tooltip`、`Legend` を使う。
- `web/src/modules/admin/components/app-shell.tsx`
  - `full-width` レイアウト対象に `/doctor` が含まれていない。
  - Dashboard 化する場合は `/doctor` を full-width に含める。
- `web/src/styles.css`
  - Overview 用の `overview-layout`、`overview-chart-grid`、`overview-chart-frame` がある。
  - Doctor 用は `doctor-distillation-grid`、`doctor-run-strip`、`doctor-meta-grid` が中心で、Dashboard 用の広い情報配置には不足している。

### API / Schema

- `api/modules/doctor/doctor.routes.ts`
  - `GET /api/doctor` を提供する。
- `api/modules/doctor/doctor.repository.ts`
  - `src/modules/doctor/doctor.service.ts` の `runDoctor()` を呼ぶ薄い repository。
- `src/shared/schemas/doctor.schema.ts`
  - `DoctorReport` の共有 contract。
  - Chart 化できる値は既に多く含まれているため、初期実装では API contract の拡張は必須ではない。

### Tests

- `test/components/admin/doctor-page.test.tsx`
  - 現在は古い画面の文字列表示を広く検証している。
  - Dashboard 化後はテスト期待値を更新する必要がある。

---

## 3. 設計方針

### 3.1 画面の役割

Doctor Dashboard は次の問いに 1 画面で答える。

1. 今システムは使える状態か。
2. degraded / failed の主要因は何か。
3. Compile は直近でどの程度 usable か。
4. Distillation queue は詰まっているか、動いているか。
5. Agent Log Sync は新鮮か。
6. 次に実行すべき確認・修復アクションは何か。

### 3.2 Overview との関係

Overview はプロダクト全体の DB 実態と利用状況を俯瞰する画面とし、Doctor は runtime / automation / diagnostic に寄せる。

重複してよい情報:

- Doctor status
- Compile health
- Distillation queue

Doctor でより詳しく見せる情報:

- LaunchAgent / lock / freshness
- degraded reason
- next actions
- Agent Log Sync state
- Embedding / Agentic LLM reachability
- stale source / stale knowledge / unused knowledge signals

### 3.3 Reason は人間向けに翻訳する

`KNOWLEDGE_ZERO_USE_HIGH` や `VIBE_DISTILLATION_PIPELINE_LOCK_STALE` のような内部コードをそのまま主表示にしない。Doctor の利用者が知りたいのはコード名ではなく、「何が起きているか」「影響は何か」「次に何を見るべきか」である。

UI では reason を次の形に変換して表示する。

| 表示要素 | 内容 |
|---|---|
| Label | 人間が読める短い名前 |
| Severity | `critical` / `warning` / `info` |
| Area | `Knowledge` / `Distillation` / `Sync` / `Runtime` / `MCP` |
| Description | 何が起きているか |
| Impact | 放置した場合の影響 |
| Suggested action | 次に確認・実行すべきこと |
| Raw code | 詳細表示のみ。コピーや検索用に残す |

初期実装では API contract を変えず、Frontend 側に reason catalog を持つ。将来的に reason severity や action priority を API 側で返す場合でも、最初は UI の catalog で十分に運用できる。

---

## 4. 新画面構成

### 4.1 Header

既存の Overview と同じ操作感にする。

- Title: `Doctor`
- Description: `Runtime、automation、compile、distillation の診断状態を確認します。`
- `checkedAt`
- Refresh button
- status badge: `ok` / `degraded` / `failed`

### 4.2 Top KPI Grid

`metric-grid` 系を再利用し、4〜8 個の KPI を表示する。

| KPI | 値 | Hint |
|---|---:|---|
| System Status | `report.status` | `reasons.length` |
| Compile Usable | `runs.usableRate` | `ok/degraded/failed` ではなく実利用可否を優先 |
| Blocking Rate | `runs.blockingRate` | `blockingRuns / totalRuns` |
| DB Latency | `db.durationMs` | reachable / missing tables |
| Knowledge Usage | `activeCount - zeroUseActiveCount` | unused active count |
| HITL Drafts | `hitl.draftCount` | oldest draft age |
| Queue Pending | Vibe + Source queued | running / paused / failed |
| Sync Freshness | max sync age | stale state count |

`runs.usableRate` など optional な値は、未定義時に `-` を表示する。

### 4.3 Chart Grid

`doctor-charts.tsx` を新設し、Overview と同じ Recharts のパターンで実装する。

#### Chart 1: Compile Health Mix

Source:

- `runs.usableRuns`
- `runs.warningOnlyRuns`
- `runs.blockingRuns`
- `runs.noContentRuns`

Chart:

- `BarChart`
- data: 1 row or category rows
- 色:
  - usable: green
  - warning: amber
  - blocking: red
  - no content: slate

目的:

- degraded 率だけではなく、実際に使える compile がどれくらいあるかを見せる。

#### Chart 2: Compile Latency

Source:

- `runs.durationMsP50`
- `runs.durationMsP95`
- `runs.durationMsAvg`

Chart:

- `BarChart`
- p50 / avg / p95 を並べる。

目的:

- runtime 劣化が速度由来か、品質由来かを切り分ける。

#### Chart 3: Distillation Queue

Source:

- `vibeDistillation.jobs`
- `sourceDistillation.jobs`

Chart:

- `BarChart`
- target: `vibe` / `source`
- stacked bars: `queued`, `running`, `paused`, `failed`

目的:

- どちらの queue が詰まっているかを即座に見る。

#### Chart 4: Distillation Outcomes

Source:

- `vibeDistillation.runs.outcomeKindCounts`
- `sourceDistillation.runs.outcomeKindCounts`

Chart:

- `BarChart`
- top 8 outcomes を表示。
- `knowledge_created` / `knowledge_deduped` は success 系、error / timeout / unparseable 系は risk 系として色分けする。

目的:

- 直近の distillation が知識化に到達しているか、候補生成や検証で止まっているかを把握する。

#### Chart 5: Knowledge Lifecycle Signals

Source:

- `knowledgeLifecycle.activeCount`
- `knowledgeLifecycle.zeroUseActiveCount`
- `knowledgeLifecycle.staleByDecayCount`
- `knowledgeLifecycle.staleProcedureCount`
- `mcp.staleKnowledgeCount`
- `mcp.staleSourceCount`

Chart:

- `BarChart`
- signal ごとの count。

目的:

- runtime ではなく、データ品質・メンテナンス由来の degraded を分離する。

#### Chart 6: Sync Freshness

Source:

- `agentLogSync.states[].lastSyncedAgeMinutes`
- `agentLogSync.states[].cursorFiles`

Chart:

- `ComposedChart`
- bar: cursor files
- line: sync age minutes

目的:

- Codex / Antigravity の同期が止まっているか、単に対象が多いだけかを見る。

### 4.4 Detail Panels

Chart ではなく、判断材料としてテキストや状態を残す。

#### Runtime Matrix

表示項目:

- Database reachable / duration
- pgvector installed
- required tables missing count
- Embedding provider / daemon / CLI
- Agentic LLM provider / reachability
- MCP missing primary tools

#### Automation Matrix

表示項目:

- Agent Log Sync LaunchAgent
- Distillation LaunchAgent
- Vibe lock status
- Source lock status
- Vibe oldest queued / running age
- Source oldest queued / running age

#### Doctor Signals

表示項目:

- `reasons`
- `mcp.nextActions`
- `agentLogSync.nextActions`
- `vibeDistillation.nextActions`
- `sourceDistillation.nextActions`

`nextActions` は action list としてまとめ、理由リストとは別カードにする。

#### Human-readable Reason Cards

`reasons` は raw code の箇条書きではなく、カードまたは compact list として表示する。

現在確認されている reason の初期表示は次の通り。

| Raw code | Label | Severity | Area | Description | Suggested action |
|---|---|---|---|---|---|
| `KNOWLEDGE_ZERO_USE_HIGH` | 未使用の active knowledge が多い | warning | Knowledge | active な knowledge の多くが compile で選ばれていない。知識が多すぎる、スコープが広すぎる、または検索対象として弱い可能性がある。 | Knowledge 画面で未使用 active を確認し、不要なものを deprecated 化する。必要なら appliesTo / technology / changeType を見直す。 |
| `VIBE_DISTILLATION_NEVER_RAN` | 会話ログの蒸留がまだ成功していない | warning | Distillation | Vibe Memory 由来の distillation run が成功していない。会話ログは取り込まれていても、knowledge 化まで進んでいない可能性がある。 | `bun run distill:pipeline -- --write --limit 1 --kind vibe` を実行し、候補生成から finalize まで進むか確認する。 |
| `VIBE_DISTILLATION_PIPELINE_LOCK_STALE` | 会話ログ蒸留のロックが古い | critical | Distillation | distillation pipeline の lock が古く、Vibe Memory の処理が止まっている可能性がある。 | worker log と lock file を確認する。次回 run で解除されない場合は stale lock の原因を調べる。 |
| `SOURCE_DISTILLATION_PIPELINE_LOCK_STALE` | Source 蒸留のロックが古い | critical | Distillation | wiki/source 側の distillation lock が古く、source から knowledge への更新が止まっている可能性がある。 | running job、worker log、lock file を確認する。source queue が進んでいるかも併せて見る。 |
| `ANTIGRAVITY_LOGS_SYNC_STALE` | Antigravity ログ同期が古い | warning | Sync | Antigravity ログの最終同期から時間が経っている。Antigravity 側の作業ログが Vibe Memory に反映されていない可能性がある。 | Agent Log Sync の LaunchAgent と `sync_states` を確認し、必要なら sync job を手動実行する。 |

未知の reason は以下の fallback で表示する。

- Label: raw code を `_` 区切りから title case に変換する。
- Severity: `warning`
- Area: `Other`
- Description: `Doctor returned an unmapped diagnostic reason.`
- Suggested action: `Raw code を検索し、doctor.service.ts の reason 追加箇所を確認する。`

---

## 5. 実装ステップ

### Step 1: Layout を Dashboard 化

対象:

- `web/src/modules/admin/components/app-shell.tsx`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/styles.css`

作業:

1. `/doctor` を `full-width` レイアウト対象に追加する。
2. Doctor root に `overview-layout` 相当の class を付ける。
3. Header に `checkedAt` と Refresh button を追加する。
4. `doctor.isError` 時の error card を追加する。

完了条件:

- `/doctor` が Overview と同じ横幅で表示される。
- API 読み込み失敗時に空白画面にならない。

### Step 2: KPI Grid を実装

対象:

- `web/src/modules/admin/components/doctor.page.tsx`

作業:

1. `Metric` 相当の小コンポーネントを Doctor 側に追加する。
2. `formatNumber`、`formatPercent`、`formatDurationMs`、`formatCheckedAt` を追加する。
3. Top KPI 8 件を作る。

完了条件:

- Doctor の主要状態がスクロールなしで読める。
- optional 値が欠けても `-` で安定表示される。

### Step 3: `doctor-charts.tsx` を追加

対象:

- `web/src/modules/admin/components/doctor-charts.tsx`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/styles.css`

作業:

1. `DoctorCharts` コンポーネントを新設する。
2. `DoctorReport` から chart data を作る pure helper を同ファイル内に置く。
3. Chart 6 種を追加する。
4. CSS は Overview の `overview-chart-grid` / `overview-chart-frame` を流用しつつ、必要なら `doctor-chart-grid` を追加する。

完了条件:

- Chart が report の値から描画される。
- `outcomeKindCounts` が空でも layout が崩れない。

### Step 4: Detail Panels を再編

対象:

- `web/src/modules/admin/components/doctor.page.tsx`

作業:

1. 既存 `Runtime` と `Embedding` を `Runtime Matrix` に統合する。
2. `Agent Log Sync` と Distillation lock / queue freshness を `Automation Matrix` に統合する。
3. `Reasons` と各 `nextActions` を `Doctor Signals` / `Next Actions` に分離する。
4. 既存の `DistillationPanel` は削除または縮小する。詳細テーブルを残す場合も下段に置く。
5. reason catalog を追加し、raw code ではなく label / severity / area / description / action を表示する。
6. raw code は詳細行または monospace の補助テキストとして残し、主見出しには使わない。

完了条件:

- stale lock や stale sync が chart と action list の両方から見つけられる。
- 旧画面の重要情報が失われない。
- `KNOWLEDGE_ZERO_USE_HIGH` のような内部コードだけを見ても意味が分からない状態を解消する。

### Step 5: Tests を更新

対象:

- `test/components/admin/doctor-page.test.tsx`

作業:

1. mock report を schema に近い形へ更新する。
2. `status` は `ok | degraded | failed` に修正する。現在の test mock の `warning` は contract 外。
3. 新しい主要セクションを検証する。
   - `Doctor`
   - `System Status`
   - `Compile Usable`
   - `Distillation Queue`
   - `Runtime Matrix`
   - `Automation Matrix`
   - `Next Actions`
   - `未使用の active knowledge が多い`
   - `会話ログの蒸留がまだ成功していない`
4. empty reasons / empty outcomes / failed status の分岐を残す。
5. 未知 reason の fallback 表示を検証する。

完了条件:

- 古いテーブル依存の脆いアサーションを減らす。
- 新 Dashboard の情報設計を守るテストになる。
- reason の人間向け表記が regress しない。

### Step 6: Visual Verification

対象:

- `http://localhost:5173/doctor`
- `http://localhost:5173/`

作業:

1. dev server を起動済みならそのまま使う。未起動なら `bun run dev`。
2. Browser で `/doctor` を開く。
3. desktop と mobile 幅で確認する。
4. Overview に視覚 regressions がないことを確認する。

完了条件:

- Chart が空白にならない。
- Header / KPI / Chart / Detail panels が重ならない。
- モバイル幅でカード内テキストがはみ出さない。

---

## 6. API 拡張の判断

初期実装では `GET /api/doctor` の contract 拡張は不要。現在の `DoctorReport` だけで Dashboard は組める。

ただし、以下を追加したくなった場合は API 拡張を検討する。

| 追加したい表現 | 現状 | 拡張候補 |
|---|---|---|
| compile health の時系列 | `DoctorReport` は window summary のみ | `/api/overview` の `compileRunsByDay` を併用するか、doctor に recent series を追加 |
| distillation outcome の時系列 | 現状なし | `distillation_runs_by_day` 相当を追加 |
| reason severity | reason は string 配列 | reason classifier を API 側で返す |
| next action priority | action は string 配列 | `{ label, source, severity }` 形式にする |

今回のスコープでは、まず Frontend の情報設計を刷新し、API 拡張は避ける。

API 側に拡張する場合でも、まず UI 側 reason catalog で運用に必要な表現を固め、その後に shared schema へ移す。最初から API を変えると、MCP の `doctor` tool や既存 tests に不要な波及が出る。

---

## 7. リスクと対策

| リスク | 内容 | 対策 |
|---|---|---|
| Recharts の jsdom テストが不安定 | SVG / Responsive chart は unit test で扱いにくい | Chart の細部ではなく section title と主要 data label を検証する |
| optional field の欠落 | `runs.usableRate` などは optional | formatter で `null` / `undefined` を吸収する |
| 画面が重くなる | Doctor API は runtime check を含み応答に時間がかかる | loading / error state を明示し、Refresh は手動操作にする |
| Overview と責務が重複する | Compile / queue が両画面に出る | Overview は全体俯瞰、Doctor は診断・修復判断に寄せる |
| 色が意味不明になる | status と chart 色がバラつく | success=green、warning=amber、failure=red、neutral=slate に統一する |

---

## 8. 検証コマンド

最小検証:

```bash
bunx vitest run test/components/admin/doctor-page.test.tsx
bun run typecheck
bun run build:web
```

余裕がある場合:

```bash
bun run test:unit
bun run verify
```

ライブ確認:

```bash
bun run dev
```

確認 URL:

- `http://localhost:5173/doctor`
- `http://localhost:5173/`

---

## 9. 完了定義

- `/doctor` が Overview と同等の full-width Dashboard として表示される。
- runtime、compile、distillation、sync、knowledge lifecycle の状態が上段 KPI と chart で把握できる。
- degraded reason と next action が分離され、次に何を見るべきかが分かる。
- 既存の DoctorReport contract を維持したまま実装できる。
- `doctor-page.test.tsx`、`typecheck`、`build:web` が通る。
- Browser で desktop / mobile の表示崩れがないことを確認済み。
