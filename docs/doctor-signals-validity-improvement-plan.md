# Doctor Signals 妥当性改善 実装計画

> 作成日: 2026-05-22
> 対象: `web/src/modules/admin/components/doctor.page.tsx` の `Doctor Signals` セクション
> 目的: Doctor Signal の判定・説明・優先度を現行実装と一致させ、レガシー化した表示を解消する

---

## 1. 背景と課題

現状の `Doctor Signals` は、`report.reasons` を UI 側のローカルカタログで説明文に変換して表示している。

- UI カタログ定義: `web/src/modules/admin/components/doctor-reasons.ts`
- backend reason 生成: `src/modules/doctor/doctor.service.ts` + `inspectors/*`

2026-05-22 時点の確認では、次の乖離がある。

1. UI の明示カタログは 5 code のみ
2. backend で生成されうる reason code は 40+（動的展開含む）
3. 多くの reason が fallback 表示になり、説明・優先度が粗い

結果として、Doctor Signals が「表示できるが運用判断には弱い」状態になっている。

---

## 2. 改善ゴール

1. Doctor reason code と表示定義を単一ソース化する
2. UI が fallback に依存せず、主要 reason を意味付き表示できるようにする
3. reason 追加時に検知できるテストを導入し、再レガシー化を防ぐ
4. lock 系 signal の誤判定を減らし、critical の妥当性を上げる

---

## 3. 対象範囲

### 対象

- `src/modules/doctor/doctor.service.ts`
- `src/modules/doctor/inspectors/distillation-run.inspector.ts`
- `src/shared/schemas/doctor.schema.ts`
- `api/modules/doctor/*`
- `web/src/modules/admin/components/doctor.page.tsx`
- `web/src/modules/admin/components/doctor-reasons.ts`（置き換えまたは縮小）

### 非対象

- compile / distillation 自体のアルゴリズム変更
- doctor 以外の画面仕様変更

---

## 4. 実装方針

## 4.1 Reason 定義の単一ソース化

`src/shared/doctor/doctor-reason-catalog.ts`（新規）を作成し、以下を定義する。

- `DoctorReasonCode`
- `DoctorReasonDetail`
- `doctorReasonCatalog`（code -> detail）
- `resolveDoctorReasonDetail(code)`（fallback 含む）

このカタログを backend / frontend 双方で使用する。

---

## 4.2 API 返却の拡張（後方互換）

`DoctorReport` に additive で `reasonDetails` を追加する。

- 既存の `reasons: string[]` は維持
- `reasonDetails: DoctorReasonDetail[]` を追加
- backend 側で `reasons` から `reasonDetails` を生成して返却

これにより UI が独自推定をしなくても、server-side の確定値で表示できる。

---

## 4.3 Frontend の移行

`doctor.page.tsx` は次の順でデータを解決する。

1. `report.reasonDetails` があればそれを表示
2. ない場合のみ `resolveDoctorReasonDetail(report.reasons[i])` を使用

`doctor-reasons.ts` の重複カタログは削除または薄いラッパー化する。

---

## 4.4 lock 系 signal の妥当性補強

`*_PIPELINE_LOCK_STALE` の判定を次へ寄せる。

- 現在: lock file の `createdAt` 経過秒で stale 判定
- 改善後: `createdAt` stale に加えて、少なくとも以下いずれかを満たすときに critical 扱い
  - 対応 pid が生存していない
  - `queueHealth.staleRunning > 0`
  - launch agent が loaded でない

運用中の長寿命 worker が lock を保持しているだけの状態で、critical 誤検知しにくくする。

---

## 5. 実装ステップ

1. shared catalog 新設
2. `doctor.schema.ts` に `reasonDetails` 追加
3. `runDoctor()` で `reasonDetails` を構築して返却
4. `distillation-run.inspector.ts` に lock 妥当性判定の補助情報を追加
5. `doctor.page.tsx` を `reasonDetails` 優先表示へ移行
6. `doctor-reasons.ts` の重複ロジック削減
7. テスト追加・更新

---

## 6. テスト計画

### Unit

- `doctor.service`:
  - `reasons` と `reasonDetails.code` の一致
  - 未定義 code 時の fallback detail
- `distillation-run.inspector`:
  - lock stale だが pid alive のケース
  - staleRunning > 0 のケース
  - launch agent unloaded のケース

### Contract

- `doctorReportSchema` で `reasonDetails` 追加後も parse 成功
- 既存 consumer が `reasons` のみでも壊れないことを確認

### UI

- `/doctor` で `Doctor Signals` が `reasonDetails` を描画
- unknown reason の fallback カード描画

---

## 7. 受け入れ基準

1. 現行 backend が返す主要 reason が fallback ではなく定義済み detail で表示される
2. `Doctor Signals` の severity/area/description が backend 判定と矛盾しない
3. `*_PIPELINE_LOCK_STALE` が、実際の停滞リスク時のみ critical で上がる
4. `bun run doctor` の出力で `reasonDetails.length === reasons.length` を満たす

---

## 8. ロールアウト手順

1. まず backend + schema を入れて API 互換運用
2. frontend を `reasonDetails` 優先に切り替え
3. 1日運用で unknown/fallback 発生有無を確認
4. 問題なければ重複した旧 catalog ロジックを削除

---

## 9. リスクと対策

- リスク: reason code 追加時に catalog 更新漏れ
  - 対策: reason coverage テストを CI に追加
- リスク: UI/CLI で reason 文言の差分混乱
  - 対策: shared catalog を唯一の定義源にする
- リスク: lock 判定の緩和で検知遅延
  - 対策: `staleRunning` と launch agent 状態を併せて判定し、next action は維持

