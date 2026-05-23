# DB-backed Settings UI 実装計画

> Status: planning only
> Date: 2026-05-23
> Scope: `.env` 中心の provider / key / endpoint / model / task routing / search provider 設定を、DB-backed settings と admin Settings UI へ移す。

## 1. 目的

`findCandidate`、`coverEvidence`、`finalizeDistille`、`agenticCompile`、検索 provider、embedding/local runtime の設定を、運用中に見える・変更できる control plane として管理する。

今回の直接の問題は、`findCandidate` がどの LLM に流れているかを運用画面で判断できず、候補抽出品質が落ちても気づきにくいことだった。`findCandidate` は knowledge 化の入口で、`local-llm` では候補を十分に出せないため native `openai` を初期値にする。一方、候補後の蒸留・整形・通常検証はコストを抑えるため `local-llm` を初期値にする。`agenticCompile` も例外として native `openai` primary / `local-llm` fallback を初期値にする。

## 2. 方針

- `.env` は bootstrap と secret fallback に限定する。
- DB には `settings` table を置く。
- 起動中は settings をメモリキャッシュし、通常リクエストごとに DB を読まない。
- API key は扱えるようにするが、平文表示しない。初期実装では DB 保存を暗号化必須にするか、秘密値だけ `.env` fallback を残す。
- UI は admin nav の一番右、つまり `web/src/modules/admin/components/app-shell.tsx` の `navItems` 末尾に `Settings` を追加する。
- React component 内で直接 fetch せず、既存方針どおり `web/src/modules/admin/repositories/admin.repository.ts` に API client を置く。

## 3. 非目標

- この計画書では実装しない。
- 認証・認可の全面導入は含めない。ただし Settings API は将来の admin auth を前提に境界を切る。
- 既存 `.env` を即廃止しない。移行期間は DB settings > `.env` > constants の順で解決する。
- API key をブラウザに返さない。UI には masked / configured / lastUpdated のみ返す。

## 4. 設定モデル

### 4.1 Settings table

最小案は 1 table に namespace/key/value を保存する。

```sql
create table settings (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  value_kind text not null default 'json',
  secret_ref text,
  is_secret boolean not null default false,
  description text,
  schema_version integer not null default 1,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  updated_by text,
  unique(namespace, key)
);
```

`value_kind` 候補:

| value_kind | 用途 |
| --- | --- |
| `json` | provider assignment、timeout、boolean flags |
| `string` | endpoint、model id、profile |
| `secret_ref` | secret store / encrypted payload への参照 |
| `encrypted` | DB 内暗号化 payload |

### 4.2 Secret storage

秘密値は次の順で設計する。

1. Phase 1: `.env` fallback を残し、DB には `configured: true` と `source: env|db` だけ返す。
2. Phase 2: DB encrypted secret を追加する。
3. Phase 3: macOS Keychain / OS secret store 連携を検討する。

DB encrypted secret を採る場合:

- `MEMORY_ROUTER_SETTINGS_ENCRYPTION_KEY` を `.env` に置く。
- `settings.value` には暗号文・iv・tag・version を保存する。
- UI の GET response は secret 本体を返さず、`maskedValue`, `configured`, `source`, `updatedAt` のみ返す。
- secret 更新は write-only API にする。空文字は「変更なし」、明示 reset は `clearSecret: true` にする。

## 5. Runtime settings 解決

### 5.1 キャッシュ設計

新規 module 案:

- `src/modules/settings/settings.repository.ts`
- `src/modules/settings/settings.service.ts`
- `src/modules/settings/runtime-settings.ts`
- `api/modules/settings/settings.routes.ts`
- `api/modules/settings/settings.service.ts`

`runtime-settings.ts` は process 内 singleton cache を持つ。

```ts
type RuntimeSettingsCache = {
  loadedAt: Date | null;
  version: number;
  settings: RuntimeSettings | null;
};
```

読み取り方針:

- 初回 access 時に DB から settings を読む。
- 起動中は memory cache を使う。
- Settings UI から保存されたら、同一 process の cache を invalidate する。
- LaunchAgent / MCP / API は別 process なので、DB 更新後の反映は次のいずれかにする。
  - Phase 1: UI に「保存後は worker reload が必要」と表示し、reload action を別途用意する。
  - Phase 2: `settings_revision` table または `settings.updated_at max` を低頻度 polling する。
  - Phase 3: Postgres LISTEN/NOTIFY で cache invalidation する。

DB 負荷を増やさないため、通常 path では毎回 DB を見ない。Phase 2 の polling を入れる場合も 30-60 秒以上の TTL を置く。

### 5.2 解決優先順位

設定値の優先順位:

1. DB settings
2. `.env`
3. `APP_CONSTANTS`
4. hardcoded fallback

ただし secret は DB が未実装または未設定の場合 `.env` fallback を維持する。

### 5.3 groupedConfig との関係

現行の `groupedConfig` は module import 時に `.env` と constants から静的に組み立てられる。DB settings を直接ここに混ぜると async 初期化が広がるため、段階的に分ける。

Phase 1:

- provider / endpoint / model 解決が必要な runtime path で `getRuntimeSettings()` を使う。
- `groupedConfig` は fallback source として残す。

Phase 2:

- `groupedConfig` を `bootstrapConfig` と `runtimeSettings` に分離する。
- DB 接続、source root、ログ root など bootstrap 必須項目は同期 config のまま残す。

## 6. Provider / task assignment

### 6.1 LLM provider registry

DB settings では provider 定義を registry として持つ。

```json
{
  "providers": {
    "openai": {
      "enabled": true,
      "apiBaseUrl": "https://api.openai.com/v1",
      "model": "5.4mini",
      "apiKeySecret": {"configured": true, "source": "env"}
    },
    "azure-openai": {
      "enabled": false,
      "apiBaseUrl": "https://...",
      "apiVersion": "2025-04-01-preview",
      "model": "5.4mini",
      "apiKeySecret": {"configured": false, "source": "none"}
    },
    "bedrock": {
      "enabled": false,
      "region": "us-east-1",
      "endpointUrl": "",
      "profile": "",
      "model": "claude-4.6-haiku",
      "credentialSecret": {"configured": false, "source": "env-or-profile"}
    },
    "local-llm": {
      "enabled": true,
      "apiBaseUrl": "http://127.0.0.1:44448",
      "model": "gemma-4-e4b-it"
    }
  }
}
```

OpenAI native provider を `openai` として追加し、初期 task routing の primary provider にする。Azure OpenAI は `azure-openai` として別 provider に分け、必要な環境だけ明示的に有効化する。Bedrock は Claude 4.6 Haiku 系を基本にし、実装時に利用リージョンの正確な Bedrock model id を確認して保存する。

### 6.2 Task routing

初期 default は task ごとに分ける。候補抽出は品質優先で native `openai`、候補後の蒸留処理はコスト優先で `local-llm` とする。

| task | default provider | 理由 |
| --- | --- | --- |
| `findCandidate.source` | `openai` / `5.4mini` | source から候補を見つける入口。`local-llm` では候補数と品質が落ちるため native `openai` を初期値にする。 |
| `findCandidate.vibe` | `openai` / `5.4mini` | 会話ログからの候補抽出も reasoning 品質が必要なため native `openai` を初期値にする。 |
| `coverEvidence.sourceSupport` | `local-llm` | 根拠評価も通常は local。外部事実確認が重い場合だけ cloud に切り替える。 |
| `coverEvidence.externalEvidence` | `local-llm` | Web/search/fetch 結果の検証は cloud の方が強いが、デフォルトでは費用を優先する。 |
| `coverEvidence.mcpEvidence` | `local-llm` | 任意 MCP evidence も downstream 検証なので初期値は local に寄せる。 |
| `finalizeDistille` | `local-llm` | candidate -> knowledge の整形は local でよい。 |
| `agenticCompile` | `openai` fallback `local-llm` | context pack の補助推論は回答品質への影響が大きいため native `openai` を主にし、未設定・失敗時は local に落とす。 |
| `embedding` | `daemon` | 現行 local embedding daemon を継続。 |

設定 shape 案:

```json
{
  "taskRouting": {
    "findCandidate": {
      "source": {"provider": "openai", "model": "5.4mini", "fallback": []},
      "vibe": {"provider": "openai", "model": "5.4mini", "fallback": []}
    },
    "coverEvidence": {
      "sourceSupport": {"provider": "local-llm", "fallback": []},
      "externalEvidence": {"provider": "local-llm", "fallback": []},
      "mcpEvidence": {"provider": "local-llm", "fallback": []}
    },
    "finalizeDistille": {
      "provider": "local-llm",
      "fallback": []
    },
    "agenticCompile": {
      "enabled": true,
      "provider": "openai",
      "fallback": ["local-llm"]
    }
  }
}
```

現行 `auto` は runtime によって順序が違う。distillation は `local-llm -> azure-openai -> bedrock`、agenticCompile は `azure-openai -> bedrock -> local-llm` なので、DB 設定では task ごとに `fallback` を明示し、暗黙順序に頼らない。コスト事故を避けるため、初期値では暗黙 fallback を使わない。

`findCandidate` と `agenticCompile` は native `openai` を初期値にする。`coverEvidence` と `finalizeDistille` は `local-llm` を初期値にする。

外部検証まで高品質化する profile の例:

```json
{
  "taskRouting": {
    "coverEvidence": {
      "externalEvidence": {"provider": "openai", "model": "5.4mini", "fallback": ["local-llm"]}
    }
  }
}
```

Azure OpenAI や Bedrock を使う環境では同じ profile を `azure-openai` / `bedrock` に差し替えられるが、初期値としては採用しない。

## 7. Search provider settings

対象:

- Brave Search API key
- Exa API key
- DuckDuckGo enable/disable
- provider order
- max provider attempts
- result count
- timeout
- rate-limit cooldown

設定 shape 案:

```json
{
  "search": {
    "providerOrder": ["brave", "exa", "duckduckgo"],
    "maxProviderAttempts": 2,
    "resultCount": 3,
    "timeoutMs": 10000,
    "rateLimitCooldownSeconds": 3600,
    "providers": {
      "brave": {"enabled": true, "apiKeySecret": {"configured": true, "source": "db"}},
      "exa": {"enabled": true, "apiKeySecret": {"configured": false, "source": "none"}},
      "duckduckgo": {"enabled": true}
    }
  }
}
```

既存の search provider cooldown state は `sync_states` の `distillation_search_providers` にある。これは runtime state なので settings table へ混ぜない。Settings UI では「設定」と「現在 cooldown / rate limit 状態」を分けて表示する。

## 8. Settings UI

### 8.1 Navigation

- `web/src/modules/admin/components/app-shell.tsx` の `navItems` 末尾に `{ to: "/settings", label: "Settings" }` を追加する。
- 末尾追加により Settings は一番右に表示される。
- `web/src/App.tsx` に `/settings` route を lazy route として追加する。

### 8.2 Page layout

Settings page は操作系なので、marketing 的な hero は不要。既存 admin page と同じ密度で、tabs を使う。

Tabs:

1. `LLM Providers`
2. `Task Routing`
3. `Search`
4. `Embedding / Local Runtime`
5. `Distillation Runtime`
6. `Advanced`

UI 要件:

- API key / AWS credential 欄は masked input + Replace / Clear。
- endpoint/region/profile/model は provider 種別に応じた input。
- provider enabled は toggle。
- task routing は matrix table + provider select + model select + fallback order。
- search provider order は ordered list または up/down controls。
- 保存前に validation summary を出す。
- 保存後に cache invalidation / worker reload 必要性を明示する。
- Provider health check button を置く。ただし health check は保存とは別 action。

### 8.3 API shape

```http
GET /api/settings
PUT /api/settings
POST /api/settings/providers/:provider/test
POST /api/settings/reload-runtime-cache
```

`GET /api/settings` は masked secret だけ返す。

```json
{
  "settings": {...},
  "effective": {...},
  "sources": {
    "findCandidate.source.provider": "db",
    "openai.apiKey": "env",
    "azure-openai.apiKey": "unset"
  },
  "revision": 12
}
```

`PUT /api/settings` は partial update ではなく、validated document を保存する方式を推奨する。複数 field の整合性を一度に検証できるため。

## 9. Runtime integration points

変更対象候補:

| area | current | new |
| --- | --- | --- |
| findCandidate | `groupedConfig.distillation.findCandidateProvider` | `runtimeSettings.taskRouting.findCandidate[source|vibe]` |
| distillation runtime | `groupedConfig.distillation.provider` | task-specific provider setting |
| coverEvidence | `input.provider ?? groupedConfig.distillation.provider` | coverEvidence subtask routing |
| finalizeDistille | LLM は基本使わず validation/embedding 中心 | provider が必要になった場合は `finalizeDistille` routing |
| agenticCompile | `groupedConfig.agenticCompile` | runtime settings + fallback `.env` |
| search providers | `groupedConfig.distillationTools.searchProviders` + env key | runtime settings search config + secret resolver |
| provider configured check | `groupedConfig.*` | runtime provider registry |

既存 code path は provider union / schema / CLI validation が `azure-openai`、`bedrock`、`local-llm`、`auto` 前提になっている箇所がある。`openai` を default にするため、Settings UI だけでなく次の adapter と型境界も同時に拡張する。

- `src/modules/llm/llm-provider.ts`
- `src/config.types.ts`
- `src/modules/distillation/llm-resolver.ts`
- `src/modules/distillation/distillation-runtime.service.ts`
- `src/cli/find-candidate.ts`
- `src/cli/cover-evidence.ts`
- `src/cli/distill-pipeline.ts`
- `src/db/schema.ts` の provider comment / enum 相当の表現

重要: audit には必ず `task`, `provider`, `model`, `settingsRevision` を残す。今回のような誤 routing をあとから特定できるようにする。

## 10. constants から Settings へ移す候補

### 10.1 Settings UI に持ってくるべき

| current constant/config | 理由 |
| --- | --- |
| `distillationTimeoutMs` | provider/model ごとに調整したい。 |
| `distillationCandidateTimeoutMs` | candidate 単位 timeout は運用品質に直結する。 |
| `distillationToolMaxRounds` | tool use の品質・コストに効く。 |
| `distillationToolTimeoutMs` | search/fetch timeout の運用調整対象。 |
| `distillationToolResultMaxChars` | evidence quality と token cost の調整対象。 |
| `distillationSearchResultCount` | 検索コスト・精度の調整対象。 |
| `distillationSearchMaxProviderAttempts` | search fallback 戦略。 |
| `distillationSearchRateLimitCooldownSeconds` | provider rate limit 運用。 |
| `distillationFailureRetryDelaySeconds` | timeout/retry 滞留の運用調整。 |
| `distillationReaderMaxReads` | findCandidate の source/vibe 読み取り品質に影響。 |
| `distillationReaderMaxCharsPerRead` | source/vibe 読み取り品質と token cost に影響。 |
| `distillationLowImportanceRejectThreshold` | knowledge 化の厳しさ。 |
| `sourceDistillationAgenticReaderManualEnabled` | source reader 方針。 |
| `sourceDistillationAgenticReaderAutoEnabled` | source auto reader 方針。 |
| `vibeDistillationAgenticReaderManualEnabled` | vibe reader 方針。 |
| `agenticCompileEnabled` | UI で on/off できるべき。 |
| `agenticCompileTimeoutMs` | provider/model ごとに調整したい。 |
| `agenticCompileMaxTokens` | cost/quality 調整。 |
| `defaultTokenBudget` | compile UI と連動できる。 |
| `embeddingTimeoutMs` | embedding daemon 運用で必要。 |

### 10.2 Advanced に置くべき

| current constant/config | 理由 |
| --- | --- |
| `distillationPipelineLockStaleSeconds` | 誤設定で二重 worker 事故になるので Advanced。 |
| `distillationLockTtlSeconds` | 同上。 |
| `distillationContinuousIdleSleepMs` | worker 負荷調整。 |
| `distillationContinuousErrorSleepMs` | 障害時 retry 負荷調整。 |
| `distillationInventoryRefreshIntervalMs` | DB/source scan 負荷調整。 |
| `distillationTargetMaxAttempts` | skip/retry 方針。 |
| `distillationTargetStaleSeconds` | stale recovery 方針。 |
| `distillationTargetRetryDelaySeconds` | paused retry 方針。 |
| `doctorFreshnessThresholdMinutes` | health 判定の運用閾値。 |
| `doctorDegradedRateThreshold` | health 判定の運用閾値。 |
| `doctorKnowledgeZeroUseWarningMinActiveCount` | knowledge lifecycle 診断。 |

### 10.3 `.env` / bootstrap に残すべき

| config | 理由 |
| --- | --- |
| `DATABASE_URL` | DB 接続前に必要。 |
| `MEMORY_ROUTER_SETTINGS_ENCRYPTION_KEY` | DB secret 復号に必要。 |
| `MEMORY_ROUTER_SOURCE_CONTENT_ROOT` | 起動・import 前提。UI 変更は可能でも慎重に扱う。 |
| `MEMORY_ROUTER_CODEX_SESSION_DIR*` | machine-local path。UI 表示・編集候補ではあるが、まずは read-only でよい。 |
| `MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR*` | machine-local path。まず read-only。 |
| LaunchAgent の PATH / WorkingDirectory | OS job 定義側の責務。 |

## 11. Migration plan

### Phase 0: Plan / schema agreement

- この計画をレビューする。
- secret を DB encrypted にするか、まず `.env` fallback のみにするか決める。
- OpenAI native provider を `openai` として追加し、Azure OpenAI は `azure-openai` として別 provider に残す。`findCandidate` と `agenticCompile` は `openai` primary、候補後の distillation task は `local-llm` を初期値にする。

### Phase 1: Read-only effective settings

- `settings` table migration を追加。
- runtime settings resolver を追加。
- `.env` + constants から effective settings document を作る。
- `GET /api/settings` を read-only で返す。
- Settings page を read-only dashboard として追加。
- nav の一番右に Settings を追加。

### Phase 2: Editable non-secret settings

- provider enabled、endpoint、region、profile、model、task routing、search order、timeouts を保存可能にする。
- 保存後に in-process cache を invalidate。
- audit log に settings update を記録する。
- doctor / overview に effective provider assignment を表示する。

### Phase 3: Secret write support

- encrypted secret 保存または secret_ref 保存を追加。
- API key replace / clear UI を追加。
- provider test endpoint を追加。
- secret value は API response に返さない。

### Phase 4: Runtime adoption

- `findCandidate` を DB task routing に切り替える。
- `coverEvidence` subtask routing を DB task routing に切り替える。
- `agenticCompile` を DB settings に切り替える。
- search provider handlers を DB settings + secret resolver に切り替える。
- audit に `settingsRevision` を入れる。

### Phase 5: Worker reload / cross-process invalidation

- Settings save 後の LaunchAgent reload action を設計する。
- 低頻度 revision polling または LISTEN/NOTIFY を導入する。
- doctor に `SETTINGS_CACHE_STALE` / `SETTINGS_SECRET_MISSING` などの reason を追加する。

## 12. Validation

計画実装時の検証:

- `bun run db:generate` / migration snapshot。
- `bunx vitest run test/settings*.test.ts test/find-candidate.test.ts test/search-providers.test.ts test/distillation-runtime.service.test.ts`
- `bun run typecheck`
- `bun run doctor`
- Playwright で `/settings` desktop/mobile 表示確認。
- `findCandidate.source = openai` / `5.4mini` の default で audit に provider/model/settingsRevision が残ること。
- `finalizeDistille = local-llm` のまま downstream が動くこと。
- `agenticCompile = openai` が未設定または失敗した場合に `local-llm` fallback へ落ちること。
- secret GET response に API key 生値が含まれないこと。
- Settings を保存しても通常 LLM request path で毎回 DB query が増えないこと。

## 13. Open questions

- Secret 保存は DB encrypted で始めるか、まず `.env` fallback + masked read-only で始めるか。
- `5.4mini` と Claude 4.6 Haiku の実 provider model id を実装時にどう検証・固定するか。
- Azure OpenAI を初期 UI で通常 provider として見せるか、Advanced provider として隠すか。
- Settings save から distill LaunchAgent reload まで UI で実行できるようにするか、最初は明示コマンド案内に留めるか。
- `sourceContent.root` や agent log roots を編集可能にするか、read-only diagnostics に留めるか。
