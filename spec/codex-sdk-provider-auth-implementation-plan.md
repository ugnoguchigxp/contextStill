# Codex SDK Provider/Auth Implementation Plan

この計画は、`memoryRouter` に OpenAI / Codex 系の設定導線を追加するための実装計画である。

方針を明確にする。通常の `context_compile` と distillation は **OpenAI API direct provider + `gpt-5.4-mini`** を主系にする。Codex SDK は高コスト・高レイテンシになりやすいため、常用経路ではなく **optional / experimental な agentic route** として追加する。OpenAI への独自 OAuth flow は実装しない。

## 1. Decision

採用する構成:

| 領域 | 方針 |
|---|---|
| compile 主系 | `openai` provider + `gpt-5.4-mini` |
| distillation 主系 | `openai` provider + `gpt-5.4-mini` |
| Codex SDK | `agenticCompile` の optional provider として追加 |
| 認証 | OpenAI API は API key、Codex は既存 Codex CLI/SDK 認証状態または `CODEX_ACCESS_TOKEN` |
| UI | OAuth 画面ではなく Codex auth status / login helper / access token setup |
| cost guard | model 設定より先に max tokens / concurrency / request budget / usage visibility を整える |

非採用:

- OpenAI OAuth を memoryRouter 内に独自実装する。
- Codex SDK を compile / distillation の標準経路にする。
- Codex の ChatGPT backend へ direct transport を実装する。
- OpenAI provider を Codex SDK provider で置き換える。
- Web evidence 収集を大量クロール用途に広げる。

## 2. Current Implementation Anchors

| Area | Current Anchor | Plan |
|---|---|---|
| provider type | `src/config.types.ts` の `AgenticCompileProvider` / `DistillationProvider` | `codex` はまず `AgenticCompileProvider` にだけ追加する。distillation には追加しない。 |
| OpenAI config | `src/config.ts` の `groupedConfig.openAi` | default model を `gpt-5.4-mini` に揃える。既存の `gpt-5-4-mini` 表記は互換 alias として扱うか migration で修正する。 |
| OpenAI provider | `src/modules/llm/providers/openai.provider.ts` | 主系として維持する。最初は Chat Completions のままでもよいが、後続で Responses API 対応を検討する。 |
| distillation OpenAI | `src/modules/distillation/providers/openai.ts` | `gpt-5.4-mini` を既定にして、max token / timeout / rate-limit handling を強化する。 |
| runtime settings | `src/modules/settings/*` | `providers.codex` と `taskRouting.agenticCompile.provider = "codex"` を追加する。 |
| Admin UI | `web/src/modules/admin/components/settings.page.tsx` | LLM Providers に Codex card を追加する。 |
| provider test API | `api/modules/settings/settings.routes.ts` | `/providers/codex/test` と `/providers/codex/auth/status` を追加する。 |
| usage logging | `src/modules/llm/llm-usage-logger.ts` 周辺 | Codex provider でも可能な範囲で usage を記録する。取得不能なら `usage=null` として扱う。 |

## 3. Provider Boundary

### `openai`

`openai` は direct OpenAI API provider として維持する。

責務:

- compile / distillation の主系。
- API key / base URL / model の管理。
- health check。
- usage / cost logging。
- 429 / retry-after の分類。

既定:

```txt
MEMORY_ROUTER_OPENAI_MODEL=gpt-5.4-mini
MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER=openai
MEMORY_ROUTER_DISTILLATION_PROVIDER=openai
MEMORY_ROUTER_DISTILLATION_FIND_CANDIDATE_PROVIDER=openai
```

### `codex`

`codex` は Codex SDK 経由の agentic provider として追加する。

責務:

- `agenticCompile` の optional route。
- Codex auth state の検出。
- Codex SDK smoke / health check。
- 長めの判断や repo-aware refinement が必要な場合だけ明示的に使う。

使わない領域:

- distillation の標準実行。
- cover evidence の大量実行。
- Web evidence の大量探索。
- background queue の常時実行。

## 4. Authentication Design

### OpenAI API

OpenAI API は API key 認証を使う。

保存先:

- `.env`: startup / local boot 用。
- runtime settings secret rows: Admin UI から設定する場合。

UI 表示:

- configured / source / masked value / updatedAt のみ。
- raw key は返さない。

### Codex SDK

Codex SDK は memoryRouter が OAuth token を直接管理しない。

認証モード:

| mode | 説明 | 保存 |
|---|---|---|
| `codex-login` | 既存の `codex login` / Codex app / IDE login 状態を使う | `~/.codex` または OS credential store。memoryRouter DB には保存しない |
| `access-token` | `CODEX_ACCESS_TOKEN` を process env または secret row から渡す | DB secret row または外部 secret manager |
| `api-key` | Codex CLI/SDK を API key mode で使う | 既存 OpenAI API key と同じ扱い |

Phase 1 では `codex-login` と `access-token` だけ扱う。`api-key` mode は `openai` provider で十分なため後回しにする。

### Why No Custom OpenAI OAuth

OpenAI API の通常利用は API key 認証である。Codex の ChatGPT sign-in は Codex CLI / app / SDK の認証面として扱う。memoryRouter が独自に OpenAI OAuth / device code / token refresh を実装すると、責務が広がり、公式 surface ではない backend 依存や token 保管リスクを持ち込む。

このため、Admin UI の名称は **Codex Auth** とし、**OpenAI OAuth** とは呼ばない。

## 5. Cost Guard First

Codex SDK の前に、主系 `openai` provider に cost guard を入れる。

### Required Controls

- `agenticCompile.maxTokens` は既存の `2048` を維持し、UI から上げられるが上限を設ける。
- distillation 系は task ごとに `maxTokens` を明示する。未指定で長文出力させない。
- `coverEvidenceConcurrency` は既存どおり既定 `1` を維持する。
- 429 / retry-after は provider error として分類し、queue 側の cooldown に接続する。
- usage logging が取れない provider は cost を `unknown` として扱い、成功扱いにしない。
- Web evidence は URL / title / short excerpt / citation metadata を保存し、full body 永続化を既定にしない。

### Optional Controls

後続 slice で追加する。

- `MEMORY_ROUTER_OPENAI_DAILY_REQUEST_BUDGET`
- `MEMORY_ROUTER_OPENAI_DAILY_TOKEN_BUDGET`
- `MEMORY_ROUTER_CODEX_DAILY_RUN_BUDGET`
- Admin UI の usage warning。
- queue supervisor の provider-policy based pause。

## 6. Implementation Slices

### Slice 1: Low-cost OpenAI Mainline

目的: `gpt-5.4-mini` を compile / distillation の主系として安全に使う。

変更:

1. `src/config.ts`
   - `groupedConfig.openAi.model` default を `gpt-5.4-mini` にする。
   - `groupedConfig.azureOpenAi.model` default は Azure deployment 名と混同しないよう、既存設定を尊重する。Azure default 変更はこの slice では行わない。
2. `src/modules/settings/settings.defaults.ts`
   - default provider model を `gpt-5.4-mini` に揃える。
3. `src/modules/llm/llm-cost-config.ts`
   - `gpt-5.4-mini` を canonical key にし、`gpt-5-4-mini` は compatibility alias として残す。
4. tests
   - config default model。
   - settings default model。
   - cost config alias。
   - OpenAI provider request body の model。

Acceptance:

- `MEMORY_ROUTER_OPENAI_MODEL` 未指定時、OpenAI provider は `gpt-5.4-mini` を使う。
- `gpt-5-4-mini` が既存 DB/settings に残っていても cost logging は壊れない。
- `bun run typecheck` と関連 unit test が通る。

### Slice 2: Provider Cost/Rate Handling

目的: 低コスト運用を壊す runaway を先に防ぐ。

変更:

1. `openai.provider.ts`
   - `LlmProviderHttpError` の 429 / retry-after を health check と通常 chat の両方で保持する。
   - `x-request-id` が取れる場合は error metadata に残す。
2. `distillation/providers/openai.ts`
   - OpenAI HTTP error を provider error 型に寄せる。
   - 429 を queue cooldown に伝播しやすくする。
3. usage logging
   - unknown cost と zero cost を分ける。
   - model alias 正規化を入れる。
4. settings
   - `agenticCompile.maxTokens` の UI 上限を明示する。

Acceptance:

- 429 が parse failure ではなく provider rate-limit として扱われる。
- usage が取れない場合に cost `0` と誤表示しない。
- provider health が 4xx を reachability として扱う既存挙動を壊さない。

### Slice 3: Codex Auth Status API

目的: Codex SDK を実行する前に、認証状態を安全に見える化する。

追加:

- `src/modules/codex/codex-auth.service.ts`
- `api/modules/settings/settings.routes.ts`
  - `GET /api/settings/providers/codex/auth/status`
  - `POST /api/settings/providers/codex/auth/login-command`

`auth/status` response:

```ts
type CodexAuthStatus = {
  codexHome: string;
  cliAvailable: boolean;
  authJsonExists: boolean;
  accessTokenConfigured: boolean;
  recommendedAction:
    | "ready"
    | "run-codex-login"
    | "set-codex-access-token"
    | "install-codex-cli";
};
```

Rules:

- `auth.json` の中身は読んでも返さない。
- token 文字列は返さない。
- `codex login` をサーバーが勝手に実行しない。まずは実行コマンドを返す。
- 将来 UI から起動する場合も local admin API のみに限定する。

Acceptance:

- Codex 未インストール、未ログイン、access token 設定済みを区別できる。
- secret が API response / log に出ない。

### Slice 4: Codex Provider As Experimental Agentic Route

目的: `agenticCompile` でだけ Codex SDK を選べるようにする。

変更:

1. `package.json`
   - `@openai/codex-sdk` を dependency に追加する。
2. `src/config.types.ts`
   - `AgenticCompileProvider` に `codex` を追加する。
   - `DistillationProvider` には追加しない。
3. `src/config.ts`
   - `groupedConfig.codex` に provider 実行設定を追加する。
4. `src/modules/llm/providers/codex.provider.ts`
   - `LlmProvider` contract に合わせる。
   - `chat()` は Codex SDK thread/run を1回実行し、final text を返す。
   - `healthCheck()` は short prompt smoke。
5. `src/modules/llm/agentic-llm.service.ts`
   - `codex` を provider order に追加する。
   - `auto` の既定順には入れない。明示選択時のみ使う。

Default safety:

```txt
sandboxMode=read-only
approvalPolicy=never
networkAccessEnabled=false
webSearchMode=disabled
timeoutMs=60000
maxTokens=1024
```

Acceptance:

- `agenticCompile.provider=codex` のときだけ Codex SDK provider が呼ばれる。
- `agenticCompile.provider=auto` では Codex に暗黙 fallback しない。
- Codex 未ログイン時も `context_compile` 本体は hard crash しない。

### Slice 5: Admin UI Integration

目的: Settings UI から OpenAI / Codex の状態を混同せず操作できるようにする。

変更:

1. `web/src/modules/admin/repositories/admin.repository.ts`
   - Codex auth status / login command / provider test client を追加。
2. `web/src/modules/admin/components/settings.page.tsx`
   - LLM Providers に Codex card を追加。
   - `agenticCompile` provider select に `codex` を追加。
   - `distillation` routing の provider select には `codex` を出さない。
3. UI copy
   - "OpenAI OAuth" ではなく "Codex Auth"。
   - "Uses existing Codex CLI/app login or CODEX_ACCESS_TOKEN." を明記。

Acceptance:

- OpenAI API key 設定と Codex auth status が別カードで表示される。
- Codex card から token raw value は見えない。
- `agenticCompile` 以外で Codex を選べない。

### Slice 6: Optional Responses API Migration

目的: Web search や structured output が必要な箇所だけ Responses API へ移行する。

この slice は必須ではない。`gpt-5.4-mini` の Chat Completions 互換で現在の用途が動くなら延期する。

候補:

- `openai.provider.ts` に `apiMode: "chat-completions" | "responses"` を追加。
- Web evidence を OpenAI hosted `web_search` に寄せる場合のみ Responses API を使う。
- citations は URL/title/annotation を保存し、本文全文保存を避ける。

Acceptance:

- 既存 distillation JSON parsing を壊さない。
- Web search 使用時は citation metadata が保存される。
- tool call cost を usage/cost view で区別できる。

## 7. Verification Plan

### Unit Tests

- `test/startup-config-env.test.ts`
  - default OpenAI model。
  - `AgenticCompileProvider` に `codex` が入っても既存 provider が壊れない。
- `test/distillation-resolver.test.ts`
  - distillation provider order に `codex` が入らない。
- `test/agentic-llm.service.test.ts`
  - `agenticCompile.provider=codex` の明示 route。
  - `auto` が Codex を暗黙選択しない。
- `test/settings*.test.ts`
  - `providers.codex` の schema/default/view。
  - secret masking。
- `test/codex-auth.service.test.ts`
  - auth status の token redaction。

### Manual Smoke

OpenAI direct:

```bash
MEMORY_ROUTER_OPENAI_MODEL=gpt-5.4-mini bun run doctor
bun run compile -- --goal "small smoke"
```

Codex optional:

```bash
codex --version
codex login
bun run doctor
```

Admin:

```bash
bun run start:api
bun run dev
```

確認:

- Settings / LLM Providers に OpenAI と Codex が別表示される。
- OpenAI provider test が成功する。
- Codex auth status が ready になる。
- `agenticCompile=codex` を明示した場合だけ Codex provider test が走る。

## 8. Rollout Policy

最初の rollout では `codex` を default にしない。

推奨 rollout:

1. Slice 1 + Slice 2 を先に merge し、`gpt-5.4-mini` 主系を安定させる。
2. 1日程度、OpenAI direct usage / queue / doctor を確認する。
3. Slice 3 で Codex auth status を追加する。
4. Slice 4 で Codex provider を experimental flag 付きで追加する。
5. Slice 5 で Admin UI から選べるようにする。
6. Codex が有用な compile task が確認できるまで、distillation には入れない。

## 9. Open Questions

- `@openai/codex-sdk` の exact version は実装時に current npm metadata で固定する。
- Codex SDK の usage event がどの粒度で取得できるかは smoke で確認する。
- `gpt-5.4-mini` が project/account で利用可能でない場合の fallback を `gpt-5.4-nano` にするか、明示エラーにするかは運用判断が必要。
- Responses API への移行は、Chat Completions 互換で不足が出てから判断する。

## 10. Success Criteria

この計画の完了条件:

- compile / distillation は `gpt-5.4-mini` を主系として動く。
- Codex SDK は `agenticCompile` の明示選択時だけ動く。
- OpenAI API key と Codex auth state が UI/API 上で混同されない。
- 独自 OpenAI OAuth flow が存在しない。
- 429 / usage / cost unknown が区別される。
- `context_compile` は Codex 未ログインでも既存 OpenAI provider で稼働できる。
