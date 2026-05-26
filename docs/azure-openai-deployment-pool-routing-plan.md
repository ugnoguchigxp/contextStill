# Azure OpenAI Deployment Pool Routing Plan

> Status: implementation-ready planning draft
> Date: 2026-05-26
> Scope: Azure OpenAI の3 deployment を、タスクごとに「使う slot の集合」として選べるようにする。
> Non-goal: GPT-5.4 mini から nano へのモデル移行そのもの、Queue 再設計、Azure deployment 数の上限拡張は扱わない。

## 1. 背景

現状の Azure OpenAI 設定は最大3 deployment を持てる。

現在できること:

- Settings UI で Azure OpenAI deployment を最大3本登録できる。
- Runtime は設定済み deployment 全体を1つの pool として扱う。
- Azure provider は pool 全体を process-local cursor で round-robin する。
- rate limit を受けた deployment は cooldown され、残りの deployment へ fallback する。

現在できないこと:

- `findCandidate` は slot 1/2 だけ使い、slot 3 は別用途にする。
- `agenticCompile` だけ slot 3 を使う。
- `coverEvidence` の cloud fallback だけ slot 3 を使う。
- task route の `model` 値で Azure deployment を絞る。

このため、3本のうち1本だけ `gpt-5.4-nano` 検証用にしたくても、既存実装では Azure provider を選ぶ全タスクに混ざってしまう。

## 2. 目的

タスクごとに Azure OpenAI deployment slot の使用範囲を指定できるようにする。

目指す構成例:

```txt
Azure slot 1: gpt-5-4-mini, normal pool
Azure slot 2: gpt-5-4-mini, normal pool
Azure slot 3: gpt-5-4-nano, experimental/reserved pool
```

設定例:

- `findCandidate.source`: Azure slot 1/2
- `findCandidate.vibe`: Azure slot 1/2
- `finalizeDistille`: Azure slot 1/2
- `agenticCompile`: Azure slot 1/2
- `coverEvidence.externalEvidence` の cloud fallback 検証: Azure slot 3

重要な前提:

- 未指定時は従来どおり「設定済み Azure deployment 全部」を使う。
- operator が見る slot 番号は 1-based にする。
- 内部実装では既存の 0-based `deploymentIndex` を使ってよいが、設定 JSON と UI には出さない。

## 3. 非ゴール

- Azure deployment 上限を3から増やさない。
- OpenAI / Bedrock / local-llm の provider routing を作り替えない。
- Queue worker / distillation pipeline の大規模再設計をしない。
- deployment ごとの永続 round-robin cursor を DB に保存しない。
- mini / nano の品質評価ロジックを同時に作らない。
- task route の `model` を Azure deployment selector として流用しない。

`model` は表示・コスト集計・provider default として既に使われているため、deployment selection と混ぜると責務が曖昧になる。

## 4. 現状の実装境界

主な current truth:

- `src/modules/settings/settings.types.ts`
  - `RuntimeSettingsRoute` は `provider`, `model`, `fallback` だけを持つ。
  - `agenticCompile` は独自 shape で `provider`, `model`, `fallback`, `timeoutMs`, `maxTokens` を持つ。
- `src/modules/settings/settings.runtime-cache.ts`
  - settings document と secrets から `groupedConfig.azureOpenAi.deployments` を組み立てる。
- `src/modules/llm/providers/azure-openai-config.ts`
  - `configuredAzureOpenAiDeployments()` が全 deployment を返す。
  - `azureOpenAiDeploymentsForTask()` が全 deployment を round-robin 対象にする。
  - `azureOpenAiDeploymentAt(index)` は既に単一 slot 解決に使える。
- `src/modules/distillation/providers/azure-openai.ts`
  - distillation runtime 用 Azure client は常に全 deployment pool を使う。
- `src/modules/llm/providers/azure-openai.provider.ts`
  - agentic/provider health 用 Azure provider は `deploymentIndex` 指定を既に受けられる。

この計画では、runtime settings に「Azure deployment slot selection」を追加し、Azure provider pool 解決へ渡す。

## 5. 設計決定

### 5.1 設定フィールド

`RuntimeSettingsRoute` に optional field を追加する。

```ts
type RuntimeSettingsRoute = {
  provider: RuntimeProviderSetting;
  model?: string;
  fallback: RuntimeProviderName[];
  azureDeploymentSlots?: number[];
};
```

`agenticCompile` にも同じ field を追加する。

```ts
agenticCompile: {
  enabled: boolean;
  provider: RuntimeProviderName;
  model: string;
  fallback: RuntimeProviderName[];
  azureDeploymentSlots?: number[];
  timeoutMs: number;
  maxTokens: number;
};
```

Semantics:

- `undefined` または `[]`: all configured Azure deployments
- `[1, 2]`: slot 1 と slot 2 だけを round-robin
- `[3]`: slot 3 だけを使う
- 無効 slot は保存時に reject する
- 明示 selection 内に設定済み slot が1本もない場合は provider error にし、all へ silently fallback しない

`provider` が `azure-openai` でない場合も保存は許容する。fallback で Azure が選ばれた場合に同じ selection を使えるようにするため。

### 5.2 Runtime selection contract

新しい内部型を追加する。

```ts
type AzureOpenAiDeploymentSelection = {
  slots?: number[];
};
```

外向き設定は 1-based、内部処理は 0-based に変換する。

`azureOpenAiDeploymentsForTask` を次の形へ拡張する。

```ts
function azureOpenAiDeploymentsForTask(
  pinnedDeployment?: AzureOpenAiRuntimeDeployment | null,
  selection?: AzureOpenAiDeploymentSelection,
): AzureOpenAiRuntimeDeployment[];
```

処理順:

1. selection が空なら `configuredAzureOpenAiDeployments()` を使う。
2. selection があれば `azureOpenAiDeploymentAt(slot - 1)` で対象を解決する。
3. 未設定 slot は除外する。
4. 明示 selection の対象が空なら空配列を返し、caller は provider error として扱う。
5. pinned deployment が対象外なら selection 内で round-robin し直す。
6. cooldown は selection 後に適用する。

### 5.3 Distillation runtime integration

`DistillationRuntimeOptions` に Azure selection を渡す。

```ts
type DistillationRuntimeOptions = {
  providerSetting?: DistillationProviderSetting;
  fallbackOrder?: DistillationProviderName[];
  azureDeploymentSlots?: number[];
  ...
};
```

各 caller は route から `azureDeploymentSlots` を渡す。

- `findCandidate`: `resolveFindCandidateRoute()` の route selection を使う。
- `coverEvidence`: `resolveCoverEvidenceRoutes()` と provider policy 適用後の route selection を使う。
- `webSourceResearch`: `resolveWebSourceResearchRoute()` の selection を使う。
- `procedure-repair`: caller が route を持たない場合は未指定 all のままにする。

`createDefaultChatClient()` は Azure client を作るとき selection を受け取り、Azure provider 呼び出しだけに適用する。OpenAI / Bedrock / local-llm には影響させない。

### 5.4 Agentic compile integration

`agenticRefine` と `context-response-composer` は `getAgenticLlmProviders()` 経由で provider を作っている。

必要変更:

- `resolveAgenticCompileRouting()` から `azureDeploymentSlots` を取得する。
- `getAgenticLlmProviders()` の options に `azureDeploymentSlots` を追加する。
- `buildProvider("azure-openai")` のとき、slot selection が1件なら既存の `deploymentIndex` を使う。
- selection が複数件なら、agentic provider 側も selection 対応の Azure pool provider を使う。

実装を単純にするなら、agentic 側の `createAzureOpenAiProvider` も `deploymentSlots?: number[]` を受け、distillation 側と同じ selection helper を使う。

### 5.5 UI contract

Settings UI の task routing 各行に Azure deployment selector を追加する。

表示ルール:

- provider または fallback に `azure-openai` が含まれる route だけ selector を有効表示する。
- それ以外は disabled 表示にし、保存値は保持してよい。
- default は `All configured Azure deployments`。
- checkbox label は `#1 Primary`, `#2 Korea Central`, `#3 Deployment 3` のように slot と name を併記する。
- 未設定の deployment は disabled にする。

DOM state:

- route 行に `data-provider`, `data-has-azure-route`, `data-azure-selection-mode` を持たせる。
- checkbox は accessible label を持つ。
- UI test は raw text ではなく role/label を優先する。

### 5.6 Doctor / observability

Doctor と audit には「どの slot selection で動いたか」が見える必要がある。

追加する観測項目:

- health matrix は従来通り slot ごとに reachable を出す。
- `agenticLlm` は selected provider だけでなく configured route selection を出す。
- distillation audit の `providerRoute.selectedProviderDetails` に slot label と model を残す。
- LLM usage log は既存の provider/model に加え、completion metadata または prompt metadata へ Azure deployment label を残す。

最初の slice では DB schema 追加を避け、既存 audit payload JSON に入れるだけでよい。

## 6. 実装フェーズ

### Phase 1: Domain helpers と unit tests

対象:

- `src/modules/llm/providers/azure-openai-config.ts`
- `test/*azure*` または新規 unit test

作業:

1. `normalizeAzureDeploymentSlots()` を追加する。
2. `configuredAzureOpenAiDeploymentsForSlots(slots)` を追加する。
3. `azureOpenAiDeploymentsForTask(pinned, selection)` を selection 対応にする。
4. cooldown と pinned deployment の挙動を selection 内に閉じる。

テスト:

- 未指定なら全 deployment を返す。
- `[1, 2]` なら slot 1/2 だけを round-robin する。
- `[3]` なら slot 3 だけを返す。
- 未設定 slot だけ指定された場合は空 pool になり、provider error になる。
- pinned deployment が selection 外なら selection 内で再選択される。
- rate limited deployment は selection 後に除外される。

### Phase 2: Settings schema と defaults

対象:

- `src/modules/settings/settings.types.ts`
- `src/modules/settings/settings.defaults.ts`
- `src/modules/settings/settings.runtime-cache.ts`
- settings 関連 tests

作業:

1. `RuntimeSettingsRoute` に `azureDeploymentSlots?: number[]` を追加する。
2. `agenticCompile` に同 field を追加する。
3. zod schema で `1..3`, dedupe, max 3 を保証する。
4. default は `[]` にして existing settings document と互換にする。
5. clone / normalize / save path が field を落とさないようにする。

テスト:

- 古い settings document を parse しても `azureDeploymentSlots` が `[]` になる。
- 重複 slot は dedupe される。
- 0 / 4 / non-integer は reject または normalize 方針どおりになる。
- save/reload 後に route selection が保持される。

### Phase 3: Distillation runtime wiring

対象:

- `src/modules/distillation/types.ts`
- `src/modules/distillation/distillation-runtime.service.ts`
- `src/modules/distillation/providers/azure-openai.ts`
- `src/modules/findCandidate/domain.ts`
- `src/modules/coverEvidence/domain.ts`
- `src/modules/sources/web/source-research.service.ts`
- `src/modules/coverEvidence/procedure-repair.service.ts`

作業:

1. `DistillationRuntimeOptions` に `azureDeploymentSlots` を追加する。
2. Azure chat client factory が selection を受け取れるようにする。
3. route を読む caller から selection を渡す。
4. fallback で Azure が選ばれた場合も同じ selection を使う。
5. audit payload に `azureDeploymentSlots` を入れる。

テスト:

- `findCandidate` route `[1, 2]` が Azure client に渡る。
- `coverEvidence` の `cloud_api` policy 後も selection が消えない。
- fallback で local-llm 失敗後に Azure へ進む場合、route selection が使われる。
- selection 未指定の既存 tests は全 deployment のまま通る。

### Phase 4: Agentic compile wiring

対象:

- `src/modules/llm/agentic-llm.service.ts`
- `src/modules/llm/providers/azure-openai.provider.ts`
- `src/modules/context-compiler/agentic-refine.service.ts`
- `src/modules/context-compiler/context-response-composer.service.ts`
- agentic tests

作業:

1. agentic routing から `azureDeploymentSlots` を読む。
2. `getAgenticLlmProviders()` へ selection を渡す。
3. Azure provider が selection pool を使えるようにする。
4. health check matrix は slot 単位表示を維持しつつ、route selection 対象を selected として示す。

テスト:

- `agenticCompile.azureDeploymentSlots=[3]` で slot 3 のみを試す。
- `[1,2]` の場合は slot 1/2 を round-robin する。
- fallback の local-llm には selection が影響しない。

### Phase 5: Settings UI

対象:

- `web/src/modules/admin/components/settings.page.tsx`
- `test/components/admin/settings-page.test.tsx`

作業:

1. Azure deployment checkbox group component を作る。
2. task routing 各 route に selector を表示する。
3. provider/fallback が Azure を含まない場合は disabled 表示にする。
4. save payload に `azureDeploymentSlots` を含める。
5. existing settings load 時に missing field を `[]` として表示する。

テスト:

- Settings UI で `findCandidate.source` の slot 1/2 を選べる。
- `agenticCompile` で slot 3 だけを選べる。
- provider が local-llm で fallback に Azure がある route は selector が有効。
- provider/fallback に Azure がない route は selector が disabled。
- 保存後に reload して selection が残る。

### Phase 6: Doctor / smoke / docs

対象:

- `src/modules/doctor/doctor.service.ts`
- `api/modules/queue/queue.repository.ts`
- README または settings docs が必要なら最小追記

作業:

1. Doctor に route selection summary を追加する。
2. Queue/Admin 表示で provider/model に加えて Azure slot selection を必要なら表示する。
3. smoke 用に1 route だけ `[3]` を設定して health が通ることを確認する。

検証:

```bash
bun run typecheck
bun run lint
bun test test/settings-runtime-cache.test.ts
bun test test/distillation-runtime.test.ts
bun test test/agentic-llm.service.test.ts
bun test test/components/admin/settings-page.test.tsx
bun run doctor
```

最終確認:

- Doctor の Azure #1/#2/#3 は reachable のまま。
- route selection 未指定時の挙動は現状と同じ。
- `[1,2]` route から slot 3 が呼ばれない。
- `[3]` route から slot 1/2 が呼ばれない。

## 7. 互換性と移行

既存 settings document には `azureDeploymentSlots` が存在しない。

互換方針:

- parse 時に missing field は `[]` とする。
- `[]` は all configured deployments と同義にする。
- 既存の provider/model/fallback の意味は変えない。
- UI save 後だけ field が settings document に現れる。

推奨移行手順:

1. 実装後、まず全 route を `All` のまま deploy する。
2. Doctor と通常 distillation が従来どおり動くことを確認する。
3. Azure slot 3 を nano または検証用 deployment に変える。
4. 低リスク route だけ `[3]` にする。
5. 問題なければ対象 route を広げる。

安全な初期割当:

```txt
findCandidate.source: [1, 2]
findCandidate.vibe: [1, 2]
finalizeDistille: [1, 2]
agenticCompile: [1, 2]
coverEvidence.sourceSupport: All or [1, 2]
coverEvidence.externalEvidence: All or [3] for explicit experiment
coverEvidence.mcpEvidence: All or [1, 2]
webSourceResearch: All
```

`finalizeDistille` と `agenticCompile` は品質劣化の影響が大きいため、nano 検証用 slot 3 へ最初から寄せない。

## 8. Rollback

コード rollback なしで戻す方法:

- 各 route の `azureDeploymentSlots` を `[]` に戻す。
- または UI で `All configured Azure deployments` に戻す。

設定 rollback で戻らない場合:

- settings document の該当 field を削除しても、parser が `[]` として扱う。
- Azure slot 3 自体を使わせたくない場合は、deployment 3 の model/base URL/secret を空にする。

実装 rollback が必要な場合:

- `azureDeploymentSlots` は optional field なので、古い code が無視しても provider/model/fallback は残る。
- DB migration は不要な計画なので、schema rollback は発生しない。

## 9. 受け入れ条件

- 既存設定のままでは Azure deployment round-robin が従来どおり全 slot を使う。
- task route ごとに Azure deployment slot を `All`, `[1]`, `[2]`, `[3]`, `[1,2]`, `[1,3]`, `[2,3]`, `[1,2,3]` から選べる。
- `findCandidate`, `coverEvidence`, `webSourceResearch`, `finalizeDistille`, `agenticCompile` に selection が反映される。
- fallback で Azure が選ばれた場合も route selection が反映される。
- Doctor または audit で、実際に使われた Azure deployment slot を追跡できる。
- Settings UI で selection を保存・再読込できる。
- `bun run typecheck`, `bun run lint`, 関連 unit/component tests, `bun run doctor` が通る。

## 10. 実装時の注意

- runtime settings を使う処理は、先に `ensureRuntimeSettingsLoaded()` を呼ぶ。
- route の `model` を Azure deployment selection に使わない。
- slot 番号は UI/API/settings では 1-based に統一する。
- `azureOpenAiDeploymentKey()` は apiKey を含むため、audit/log へ key 文字列を出さない。
- selection 内の全 deployment が cooldown の場合は、従来どおり `Azure OpenAI deployments are cooling down` を返す。
- selection 外の deployment へ silently fallback しない。selection が明示されている場合、別用途 reserved slot を守ることを優先する。

## 11. 判断

この機能は新機能として実装する価値がある。

理由:

- 3本全体 round-robin のままでは mini/nano の A/B ができない。
- deployment 3 を reserved にできれば、品質リスクのある nano 検証を低リスク route に限定できる。
- optional field + empty means all にすれば、既存 runtime settings との後方互換を保てる。
- DB schema を増やさず settings JSON と provider selection helper で閉じられるため、実装範囲が比較的小さい。

最初の実装単位は Phase 1 から Phase 3 までに絞るのがよい。UI は Phase 5 で追えばよいが、operator が手で安全に切り替えるには最終的に UI selector が必要になる。
