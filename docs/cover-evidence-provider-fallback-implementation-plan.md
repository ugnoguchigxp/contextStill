# Cover Evidence provider fallback 実装計画

> 作成日: 2026-05-25
> スコープ: 計画のみ。この文書では実装コードを変更しない。

## 目的

Cover Evidence で `local-llm` が timeout した場合に、`provider_failed` のまま止まらず、リモート provider へ fallback できるようにする。

ただし fallback 先は単一の OpenAI API 直叩きではなく、抽象化された `azure-openai` provider adapter とする。`azure-openai` adapter の内側で、設定済みの複数 Azure OpenAI deployment を round-robin と cooldown 付きで使う。

目指す挙動は次の通り。

1. Cover Evidence は設定上の primary provider から開始する。通常は `local-llm`。
2. primary provider が timeout や通信エラーなどの技術的理由で失敗した場合、設定済み fallback provider へ進む。
3. fallback 先が `azure-openai` の場合、Cover Evidence は `azure-openai` adapter だけを呼ぶ。
4. どの Azure OpenAI deployment を使うかは adapter 側が決める。Cover Evidence は個別 deployment を知らない。
5. audit と UI/API 診断から、どの provider route が使われ、なぜ fallback したか追えるようにする。

## レビュー用サマリ

この計画で実装上の意味を変えるのは、`--provider` と Cover Evidence の `input.provider` の扱いである。

現在:

- `--provider local-llm` は `input.provider = "local-llm"` として Cover Evidence に渡る
- Cover Evidence は `input.provider` があると fallback を空にする
- 結果として `local-llm` timeout 後に `azure-openai` へ進めない

変更後:

- `--provider local-llm` は「primary provider を `local-llm` にする」という意味にする
- settings route の fallback は既定で維持する
- fallback を消す場合だけ、明示的に `--no-provider-fallback` または `--single-provider` を指定する
- `azure-openai` は単一 endpoint ではなく provider adapter として扱う
- `azure-openai` adapter の内側で Azure OpenAI #1 / #2 / #3 を round-robin 対象にする

レビュー時に最も重要な判断点:

- `provider override` と `fallback disable` を別概念として扱えているか
- Cover Evidence が Azure deployment の詳細を知らない境界になっているか
- local timeout が候補全体 timeout を使い切らず、fallback attempt に時間が残るか
- audit から「fallback が設定されていたか」「試されたか」「どこで失敗したか」が追えるか

## 決定事項

- Cover Evidence の既定は fallback enabled とする
- `--provider` は primary override とする
- single-provider 実行は明示 opt-in とする
- fallback 先は `azure-openai` provider adapter とする
- `azure-openai` の deployment pool は 3 deployment 構成を前提にする
- Deployment3 は round-robin 対象に含める
- Cover Evidence は Azure OpenAI の個別 endpoint / API key / deployment slot を直接扱わない
- audit には secret を含めず、安全な provider/deployment label のみを残す

## スコープ外

- OpenAI API 直叩き fallback の新規実装
- Azure OpenAI deployment を Cover Evidence 側で直接選ぶ実装
- 全 provider を一括で大きく adapter 化するリファクタ
- 既存の retryable `provider_failed` 全件を同じ変更で一括 reprocess する運用作業
- Azure API key や secret の文書化、ログ出力、fixture 化

## 確認済みの事実

今回の `provider_failed` は、Cover Evidence の value assessment が `local-llm` で timeout し、fallback せずに失敗として保存された形だった。

対象例:

- source: `vibe_memory`
- source id: `13bb8555-60c4-4b85-8c72-f1e2d631d42c`
- result: `provider_failed`
- reason: `value_provider_failed`
- audit 上の provider: `local-llm`
- fallbackOrder: `[]`
- errorKind: `timeout`
- duration: 約 300 秒

現在の runtime 設定上、Cover Evidence の route は `local-llm` primary、`azure-openai` fallback を持つ形に解決されている。

```json
{
  "sourceSupport": { "provider": "local-llm", "fallback": ["azure-openai"] },
  "externalEvidence": { "provider": "local-llm", "fallback": ["azure-openai"] },
  "mcpEvidence": { "provider": "local-llm", "fallback": ["azure-openai"] }
}
```

また、Azure OpenAI deployment pool は 3 枠すべてが configured / reachable になっている。

- Azure OpenAI #1: configured / reachable
- Azure OpenAI #2: configured / reachable
- Azure OpenAI #3: configured / reachable

`configuredAzureOpenAiDeployments()` は 3 deployment を返し、`azureOpenAiDeploymentsForTask()` は開始位置を #1 -> #2 -> #3 の順で rotate する。したがって、Cover Evidence から `azure-openai` adapter に fallback できれば、Deployment3 も round-robin 対象になる。

2026-05-25 時点の確認では、`bun run doctor` でも Azure OpenAI #1 / #2 / #3 は configured / reachable として報告されている。LaunchAgent も reload 済みで、以降の worker は更新後の runtime settings を読む前提にできる。

一方で、`src/modules/coverEvidence/domain.ts` では `input.provider` が渡された場合に fallback を空配列にしている。

```ts
const sourceSupportFallbackOrder = input.provider
  ? []
  : [...routes.sourceSupport.fallback];
```

distillation pipeline は CLI / automation の provider 指定を Cover Evidence に渡している。

- `src/cli/distill-pipeline.ts` が `--provider` を parse する
- `src/cli/distill-pipeline-automation.ts` が `MEMORY_ROUTER_DISTILL_PIPELINE_PROVIDER` を `--provider` に変換する
- `src/modules/distillationPipeline/runner.ts` が `input.provider` を `runCoverEvidenceForCandidate()` に渡す

つまり現在は、`--provider local-llm` が「local-llm を primary にする」ではなく、「local-llm 単体で実行し fallback を消す」という意味になっている。

## 現在ある仕組み

`src/modules/distillation/distillation-runtime.service.ts` の `createDefaultChatClient()` には provider-level fallback の仕組みがある。

- `resolveDistillationProviderOrder(providerSetting, fallbackOrder)` で provider の試行順を作る
- provider setting が `auto`、または provider order が複数なら fallback を許可する
- provider ごとに client を作り、失敗したら次の provider へ進む

`src/modules/distillation/providers/azure-openai.ts` には Azure OpenAI deployment pool を扱う仕組みがある。

- `createAzureOpenAiChatClient()` が Azure OpenAI 用 chat client を作る
- `callAzureOpenAiChatWithDeploymentPool()` が deployment 候補を順に試す
- retryable な Azure エラーでは別 deployment を試せる

`src/modules/llm/providers/azure-openai-config.ts` には deployment pool の状態管理がある。

- `configuredAzureOpenAiDeployments()` が設定済み deployment を組み立てる
- `azureOpenAiDeploymentsForTask()` が round-robin 順に deployment を返す
- `markAzureOpenAiDeploymentRateLimited()` が 429 deployment を cooldown する
- `markAzureOpenAiDeploymentSucceeded()` が成功後に round-robin cursor を進める

したがって、作るべきものは「OpenAI API への別実装」ではない。Cover Evidence が既存の distillation runtime fallback と `azure-openai` adapter を正しく使えるようにする整理でよい。

## 問題の整理

### 問題 1: provider override が fallback を消している

本来は `--provider local-llm` を「primary provider の上書き」として扱いたい。

しかし現在は `input.provider` があるだけで fallback が空になり、`local-llm` timeout 後に `azure-openai` へ進めない。

この挙動は手動実行や automation で provider が指定されたときに再発しやすい。

### 問題 2: timeout budget の境界が曖昧

provider fallback が設定されていても、`local-llm` の 1 attempt が候補全体の timeout budget を使い切ると、fallback 先を試す時間が残らない。

「provider attempt の timeout」と「candidate 全体の timeout」を分ける必要がある。

### 問題 3: fallback の観測性が弱い

現状の `provider_failed` だけでは、次の判断がしにくい。

- fallback が設定されていたのか
- fallback が消されたのか
- fallback は試されたが失敗したのか
- Azure OpenAI adapter のどの deployment label まで進んだのか

運用上、audit と UI/API に fallback route の情報を出す必要がある。

## 失敗分類と fallback 方針

provider fallback は「provider が技術的に応答できなかった場合」に限定する。候補そのものの品質判断や JSON の意味的な不正を、別 provider で自動的に覆す目的には使わない。

| 失敗種別 | 例 | fallback | 理由 |
| --- | --- | --- | --- |
| provider attempt timeout | `local-llm` が attempt timeout に到達 | する | provider 側の可用性問題として扱う |
| provider network error | connection refused, DNS, socket timeout | する | provider 側の通信問題として扱う |
| provider HTTP retryable error | 408, 409, 429, 5xx | する | 一時的な provider 障害として扱う |
| provider not configured | API key / endpoint / model 欠落 | する | 次の configured provider を試す |
| Azure deployment 429 | deployment 単位の rate limit | adapter 内で別 deployment を試す | provider fallback ではなく Azure adapter 内の pool retry |
| Azure deployment 5xx / 408 / 409 | deployment 単位の一時障害 | adapter 内で別 deployment を試す | provider fallback ではなく Azure adapter 内の pool retry |
| parent candidate abort | candidate 全体 timeout, user/system abort | しない | 上位の処理中断であり、次 provider を試すべきではない |
| final JSON parse / schema error | LLM 応答の構造不備 | しない | 今回の provider fallback 対象外。repair/retry の別設計で扱う |
| Cover Evidence tool loop / tool limit | tool call 上限、reader/search 上限 | しない | 今回の provider fallback 対象外。provider 変更で解決するとは限らない |
| source unsupported / insufficient | evidence が候補を支えない | しない | 正常な品質判定であり provider_failed ではない |

この分類により、`provider_failed/value_provider_failed` のような技術失敗だけを fallback 対象にし、`unsupported_by_source` や `rule_body_not_actionable` のような品質判定はそのまま維持する。

## 設計方針

### 方針 1: Cover Evidence は raw provider ではなく provider route を解決する

Cover Evidence 内で、各処理に使う provider を次のような route として解決する。

```ts
type ProviderRoute = {
  primary: DistillationProviderSetting;
  model: string;
  fallbackOrder: DistillationProviderName[];
  mode: "fallback" | "single";
  source: "settings" | "override";
};
```

`input.provider` は既定で primary-provider override として扱う。

例:

```json
{
  "primary": "local-llm",
  "fallbackOrder": ["azure-openai"],
  "mode": "fallback"
}
```

fallback を明示的に止めたい場合だけ、別の opt-out を追加する。

- CLI: `--single-provider` または `--no-provider-fallback`
- runtime input: `providerFallbackMode?: "fallback" | "single"`

background pipeline の既定は `fallback` とする。

### 方針 2: Azure OpenAI は provider adapter として扱う

Cover Evidence は `azure-openai` の個別 deployment を知らない。

Cover Evidence から distillation runtime へ渡す情報は、あくまで provider route だけにする。

```ts
providerSetting: "local-llm",
fallbackOrder: ["azure-openai"]
```

deployment の選択、round-robin、cooldown、retryable error の切り替えは `azure-openai` adapter の責務にする。

adapter interface は初期実装の必須条件ではない。`createDefaultChatClient()` の provider 分岐が複雑になり、重複削減が明確に必要になった場合だけ、distillation runtime 内に軽量な interface を置く。

```ts
type DistillationProviderAdapter = {
  name: DistillationProviderName;
  defaultModel(): string;
  isConfigured(): boolean;
  createChatClient(): DistillationChatClient;
};
```

初期実装では、既存の provider client 関数を維持してよい。今回の目的は Cover Evidence が `azure-openai` provider adapter に倒れるようにすることであり、広範な provider 抽象化は今回のスコープ外とする。

### 方針 3: provider attempt timeout と candidate timeout を分離する

Cover Evidence に少なくとも次の timeout 概念を持たせる。

- `coverEvidenceCandidateTimeoutMs`: 候補全体の timeout
- `coverEvidenceProviderAttemptTimeoutMs`: provider 1 attempt の timeout

fallback が設定されている場合、primary provider の attempt timeout は candidate 全体 timeout より短くする。

例:

```txt
candidate overall: 600s
local attempt: 240s-300s
azure attempt: 残り時間。ただし remote attempt timeout で上限をかける
```

区別すべき error は次の通り。

- provider attempt timeout: fallback する
- provider HTTP/network error: fallback する
- parent candidate abort: fallback しない
- tool loop / parse error: provider fallback ではなく既存の result status として扱う

### 方針 4: fallback を audit と UI/API で追えるようにする

最低限、LLM audit event に次を入れる。

- `providerOrder`
- `attemptedProviders`
- `selectedProvider`
- `fallbackUsed`
- `providerErrorKinds`
- `requestAuditId`

Azure OpenAI の場合は、安全な deployment label だけを出す。

- deployment index または設定名
- model
- base URL の host

API key、secret、full header は保存しない。

Phase 1 では audit metadata を必須にする。UI 詳細表示で同じ情報を扱いやすくする必要が出た場合だけ、Cover Evidence の tool event として fallback を記録する。

```json
{
  "name": "provider_fallback",
  "ok": true,
  "metadata": {
    "from": "local-llm",
    "to": "azure-openai",
    "reason": "timeout"
  }
}
```

## 変更対象マップ

実装時のレビュー対象を、責務ごとに分ける。

| 領域 | 主なファイル | 変更方針 | レビュー観点 |
| --- | --- | --- | --- |
| Cover Evidence route 解決 | `src/modules/coverEvidence/domain.ts` | `input.provider` で fallback を消す分岐を route resolver に置き換える | provider override と fallback disable が分離されているか |
| Cover Evidence CLI | `src/cli/cover-evidence.ts` | single-provider opt-in option を追加する | 手動診断時の互換性が説明されているか |
| pipeline CLI | `src/cli/distill-pipeline.ts` | `--provider` を primary override にし、fallback opt-out を追加する | automation 既定で fallback が残るか |
| pipeline automation | `src/cli/distill-pipeline-automation.ts` | env から fallback opt-out を渡せるようにする | LaunchAgent の env 指定で誤って fallback を消さないか |
| distillation runtime | `src/modules/distillation/distillation-runtime.service.ts` | provider error と parent abort を分類し、attempt 履歴を audit へ渡す | local timeout 後に Azure attempt へ進めるか |
| Azure OpenAI adapter | `src/modules/distillation/providers/azure-openai.ts` | provider adapter 境界を維持し、pool retry を壊さない | Deployment1/2/3 の retry/round-robin が維持されるか |
| Azure deployment pool | `src/modules/llm/providers/azure-openai-config.ts` | 設定済み 3 deployment を round-robin 対象にする | secret を出さず、安全な label で検証できるか |
| settings defaults/cache | `src/modules/settings/settings.defaults.ts`, `src/modules/settings/settings.runtime-cache.ts` | 3 deployment と secret slot の対応を維持する | Deployment3 の key/baseUrl/model が groupedConfig に反映されるか |
| docs/env | `.env.example`, related docs | `--provider` の意味と fallback opt-out を説明する | 運用者が single-provider と primary override を誤解しないか |
| tests | `test/*cover-evidence*`, `test/distillation-runtime.service.test.ts`, `test/azure-openai-provider.test.ts` | route/fallback/round-robin を focused test で固定する | live provider なしで回帰を捕まえられるか |

## 実装順序の依存関係

1. まず route resolver の単体テストを追加する
2. 次に現在の `input.provider` が fallback を消す挙動を再現する
3. route resolver を導入し、期待値を「fallback 維持」に変更する
4. CLI / automation の option を追加する
5. distillation runtime の error 分類と audit 情報を補強する
6. Azure adapter の 3 deployment round-robin を focused test で固定する
7. 最後に docs / `.env.example` / rollout 手順を同期する

この順序にすると、provider fallback の意味変更、timeout 分類、Azure deployment pool の検証を別々にレビューできる。

## 実装マイルストーン

### マイルストーン 1: 現在の挙動をテストで固定する

まず実装前に、現在の問題が再現できる集中テストを追加する。

確認すること:

- provider override なしの場合、route の fallback が `runDistillationCompletion` に渡る
- `provider: "local-llm"` がある場合、現在は fallback が空になる
- `distill-pipeline --provider local-llm` が Cover Evidence に `input.provider` として届く

この段階では「バグを再現するテスト」を作り、その後のマイルストーンで期待値を修正する。

### マイルストーン 2: provider route resolver を追加する

Cover Evidence の route 解決を小さな helper に切り出す。

候補:

```ts
resolveCoverEvidenceProviderRoute({
  route,
  providerOverride,
  fallbackMode,
})
```

期待する挙動:

- override なし: settings route の provider と fallback を使う
- override あり、fallback mode: override を primary にし、settings route の fallback を維持する
- override あり、single mode: override を primary にし、fallback を空にする
- fallbackOrder は重複を除去する

例:

```json
{
  "providerOverride": "local-llm",
  "routeFallback": ["azure-openai"],
  "result": {
    "primary": "local-llm",
    "fallbackOrder": ["azure-openai"],
    "mode": "fallback"
  }
}
```

### マイルストーン 3: CLI / automation の意味を明示する

`--provider` の意味を「単体固定」から「primary override」に変更する。

追加する明示 opt-out:

- `src/cli/distill-pipeline.ts`: `--no-provider-fallback` または `--single-provider`
- `src/cli/cover-evidence.ts`: 手動診断用にも同じ option を追加
- `src/cli/distill-pipeline-automation.ts`: `MEMORY_ROUTER_DISTILL_PIPELINE_PROVIDER_FALLBACK=0` のような env を追加

既定の automation では fallback を有効にする。

`.env.example` には次を明記する。

- `MEMORY_ROUTER_DISTILL_PIPELINE_PROVIDER=local-llm` は local を優先する指定
- fallback を無効化する指定ではない
- fallback を無効化するには専用 option/env を使う

### マイルストーン 4: distillation runtime の fallback 分類を固める

`createDefaultChatClient()` 周辺で次を確認・補強する。

- provider error では fallback する
- parent abort では fallback しない
- provider attempt の履歴を audit に残す
- primary attempt では primary provider の model を使う
- fallback attempt では fallback provider の default model または route 指定 model を使う

timeout handling では次を明確にする。

- provider attempt timeout は fallback 可能な error として扱う
- candidate 全体 abort は fallback 不可として扱う
- local timeout 後に Azure attempt 用の budget が残る

### マイルストーン 5: `azure-openai` を deployment-pool adapter として扱う

Cover Evidence 側では Azure deployment の詳細に触れない。

実装確認の中心は次のファイルに置く。

- `src/modules/distillation/providers/azure-openai.ts`
- `src/modules/llm/providers/azure-openai-config.ts`

受け入れ条件:

- `azure-openai` provider が設定済み deployment をすべて利用できる
- 3 deployment 構成で、呼び出し開始位置が #1 -> #2 -> #3 と rotate する
- 429 が出た deployment だけ cooldown される
- retryable な Azure 5xx / 408 / 409 / 429 では別 deployment を試せる
- non-retryable error では adapter attempt を止め、有用な error を返す

必要になった場合だけ `DistillationProviderAdapter` を導入する。広範な provider rewrite は避ける。

### マイルストーン 6: observability と UI/API 表示を追加する

バックエンド診断の最低ライン:

- audit started/completed/failed event に `providerOrder` を含める
- failed event に `attemptedProviders` と `providerErrorKinds` を含める
- completed event に `selectedProvider`、`fallbackUsed`、安全な Azure deployment label を含める

UI/API の追加対応:

- Candidate detail で provider route と fallback reason を表示する
- Queue または Doctor で repeated local timeout fallback を集計する

## テスト計画

### テストで必ず証明すること

- `--provider local-llm` だけでは fallback が消えない
- `--no-provider-fallback` または `--single-provider` のときだけ fallback が消える
- `local-llm` timeout は `azure-openai` provider adapter への fallback を起こす
- parent candidate abort は fallback を起こさない
- Azure adapter は Deployment1 / Deployment2 / Deployment3 を round-robin 対象にする
- Azure adapter の retry/cooldown は deployment 単位で動く
- audit から provider order、attempted providers、fallback used、selected provider が追える

### ユニットテスト

追加・更新するテスト:

- route resolver が fallback を重複排除する
- primary `local-llm`、fallback `["azure-openai"]` が維持される
- override `local-llm` でも fallback mode なら `["azure-openai"]` が維持される
- override `azure-openai` の場合、fallback 内の重複 `azure-openai` が除去される
- single mode では fallback が空になる
- `runCoverEvidence` が provider override ありでも fallback を渡す
- single mode のときだけ fallback を渡さない
- `runDistillationCompletion` が local timeout 後に `azure-openai` へ進む
- parent abort では fallback しない
- Azure adapter が deployment を rotate する
- Azure 429 で該当 deployment だけ cooldown し、次回は別 deployment を使う

### CLI テスト

追加する parse test:

- `--provider local-llm` は fallback enabled の primary override
- `--provider local-llm --no-provider-fallback` は single provider
- automation env var が同じ意味に変換される

### ライブスモーク

live service に当てる前に、fake provider または意図的に失敗する local provider で確認する。

手順:

1. local provider URL を短時間で timeout する stub に向ける
2. Azure OpenAI deployment を 3 つ設定し、すべて reachable にする
3. `--provider local-llm --force-refresh-evidence` で Cover Evidence candidate を 1 件実行する
4. audit で次を確認する
   - local attempt が timeout した
   - fallback で `azure-openai` が使われた
   - selected deployment label が記録された
   - Azure 成功時に最終 result が `provider_failed` にならない
5. 複数回実行し、Azure deployment #1 / #2 / #3 の使用開始位置が rotate することを確認する

### 回帰確認

まず集中テストを走らせる。

```sh
bun test test/distillation-runtime.service.test.ts
bun test test/cover-evidence.test.ts test/cover-evidence.extra.test.ts test/cover-evidence.extra2.test.ts
```

その後、広い gate を走らせる。

```sh
bun run verify
```

既知の注意点:

- 現在の working tree では、provider fallback とは別理由で失敗しているテストがある
- `vi.unstubAllGlobals` 互換性問題
- settings mock mismatch

provider fallback の実装前に、これらを直すか、集中テストと切り分けて扱う必要がある。

## 運用 rollout

1. fallback mode enabled を既定にしたコードを deploy する
2. distillation LaunchAgent を reload する
3. `launchctl print gui/$UID/com.memory-router.distill-pipeline` で、fallback を無効化する provider override がないことを確認する
4. `doctor` で Azure OpenAI が configured / reachable であることを確認する
5. 既存の `provider_failed/value_provider_failed` を少数だけ force refresh する
6. `audit_logs` で fallback usage を確認する
7. `cover_evidence_results` で `provider_failed` が減ることを確認する

## 検証証跡

実装レビューでは、次の証跡を残す。

| 確認項目 | コマンド / 観測点 | 合格条件 |
| --- | --- | --- |
| Azure deployment pool | `configuredAzureOpenAiDeployments()` の安全な host/model 出力 | 3 deployment が表示される |
| round-robin 開始位置 | `azureOpenAiDeploymentsForTask()` を複数回呼ぶ | #1 -> #2 -> #3 の順で開始位置が回る |
| provider health | `bun run doctor` | Azure OpenAI #1/#2/#3 が configured / reachable |
| LaunchAgent 反映 | `launchctl print gui/$UID/com.memory-router.distill-pipeline` | reload 後の pid で running |
| route resolver | focused unit test | override ありでも fallback が維持される |
| single-provider opt-out | CLI parse test | opt-out 指定時だけ fallback が空 |
| local timeout fallback | fake local provider test | local timeout 後に `azure-openai` が selectedProvider になる |
| parent abort | abort signal test | fallback attempt が発生しない |
| audit | `audit_logs` または repository test | providerOrder / attemptedProviders / fallbackUsed が残る |

secret を含む出力は証跡に残さない。endpoint を出す場合は host までにし、API key や full header は禁止する。

## rollback 方針

fallback 変更で運用上の問題が出た場合、機能を戻す順序は次の通り。

1. automation / CLI の fallback opt-out を有効化し、single-provider 動作へ戻す
2. LaunchAgent を reload して worker に反映する
3. `doctor` と audit で selected provider を確認する
4. opt-out だけでは止められない不具合がある場合に限り、route resolver の既定を一時的に `single` に戻す

rollback 時も、Azure OpenAI deployment pool の設定は削除しない。pool は agentic LLM や他の provider health にも関係するため、Cover Evidence fallback の opt-out と deployment 設定の削除を混ぜない。

## リスク

- Azure 使用量が増えるため、広範囲 reprocess 前に usage visibility が必要
- fallback が積極的すぎると、local-llm の capacity 問題を見落とす可能性がある
- provider attempt timeout が短すぎると、local-llm を不要に bypass する
- provider attempt timeout が長すぎると、Azure fallback 用の budget が残らない
- Azure deployment label から secret が漏れないようにする必要がある

## 未決事項

| 項目 | 推奨判断 | 実装ブロッカーか | 理由 |
| --- | --- | --- | --- |
| `azure-openai` の後に `openai` も fallback 候補として残すか | まずは残さない | いいえ | 今回の要件は Azure OpenAI deployment pool への fallback。OpenAI 追加は cost/secret/route の別判断になる |
| 手動 `cover-evidence --provider local-llm` も既定で fallback enabled にするか | enabled にする | はい | CLI と background pipeline で `--provider` の意味が分かれると再発原因になる |
| local timeout 連続時に local-llm 自体へ cooldown をかけるか | 今回は入れない | いいえ | provider pressure の別機能として扱う。まずは attempt timeout と fallback を正しく動かす |
| `--single-provider` と `--no-provider-fallback` のどちらを採用するか | `--no-provider-fallback` を第一候補 | はい | 既存の `--provider` と併用したとき意味が直感的。alias として `--single-provider` を受けるのは可 |

## 完了条件

- Cover Evidence の value assessment で `local-llm` timeout が起きた場合、`azure-openai` provider adapter へ fallback する
- Azure provider adapter が Deployment1 / Deployment2 / Deployment3 を round-robin 対象にし、Cover Evidence は deployment 詳細を知らない
- single-provider 実行は明示 opt-in として残る
- audit に provider order、fallback use、selected provider、安全な Azure deployment label が残る
- 既存の retryable `provider_failed/value_provider_failed` 行を reprocess したとき、local-only retry で止まらない

## レビュー完了チェックリスト

- 変更対象が `Cover Evidence route 解決`、`CLI/automation semantics`、`runtime fallback classification`、`Azure adapter verification` に分かれている
- `--provider` の意味変更が docs / `.env.example` / tests で一致している
- `input.provider` がある場合でも fallbackOrder が維持される test がある
- opt-out 指定時だけ fallbackOrder が空になる test がある
- timeout 分類で provider attempt timeout と parent abort が分かれている
- Azure adapter の 3 deployment round-robin が test または smoke で証明されている
- audit で fallback の有無を UI/API 側が表示できるだけの情報が残る
- secret が audit、ログ、test fixture、docs に出ない
- LaunchAgent reload と runtime cache reload の運用手順がある
- rollback で deployment pool 設定を削除しない方針が明記されている

## セルフレビュー基準

この文書を 9.5 点相当とみなす条件:

- 原因、設計方針、実装対象、検証方法が分離されている
- `local-llm -> azure-openai` fallback と Azure deployment round-robin の責務境界が明確である
- `--provider` の意味変更による互換性リスクと opt-out が明記されている
- timeout / abort / quality failure の分類が明確である
- Deployment3 を含む 3 deployment pool の現状と検証方法が明記されている
- 実装者がこの文書だけで PR を小さく分割できる
- レビュー担当がこの文書だけで合格条件と rollback を判断できる

残る 0.5 点分の余地は、実装後の実測値に依存する。具体的には、local timeout 後の Azure fallback 成功率、Azure deployment ごとの利用分布、provider_failed 減少率は実装後に audit と `cover_evidence_results` から確認する必要がある。
