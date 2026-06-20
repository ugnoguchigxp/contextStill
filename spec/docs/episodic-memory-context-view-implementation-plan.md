# Episodic Memory Context View 実装計画

> 状態: plan draft
> 作成日: 2026-06-20
> 最終更新: 2026-06-20
> 関連: [Episodic Memory Context View Concept](episodic-memory-context-view-concept.md), [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md), [SQLite 自走化 実装計画](sqlite-self-running-implementation-plan.md)

## 目的

この文書は、Episode 記憶を `context_compile` と `context_decision` の有効な情報ソースにするため、concept を実装可能な milestone と検証単位に落とす。

中心方針は、raw log / Vibe Memory を直接 context に入れず、検証可能な `EpisodeCard` projection を中間層として追加することである。`EpisodeCard` は durable Knowledge を置き換えない。単発の過去事例として扱い、複数 Episode から安定した pattern が見えた場合だけ Rule / Procedure への distillation に進める。

## 目標状態

- `vibe_memories`、`agent_diff_entries`、`audit_logs`、`context_compile_runs`、`context_decision_runs` から、検証可能な `EpisodeCard` を生成・保存できる。
- `EpisodeCard` は `refs` 経由で raw evidence に戻れる。
- `context_compile` は、現在 task に近い Episode を少数だけ「過去事例」として提示できる。
- `context_decision` は、`applicability` / `anti_applicability` / `outcome` / `confidence` が揃う Episode だけを conditional precedent として扱う。
- Episode retrieval の採用・不採用・drill down が trace と feedback に残る。
- SQLite backend と PostgreSQL backend の両方で、主要 read/write path が同じ service contract から使える。
- 既存の Vibe Memory search、Knowledge search、context pack、Decision MCP response を破壊しない。

## 非目標

- raw log 全文を毎回 LLM context に入れること。
- EpisodeCard を source of truth にすること。
- EpisodeCard を `knowledge_items` と同じ durable rule/procedure として扱うこと。
- 初期実装で EpisodeCard の自動生成品質を完全自動判定すること。
- 初期実装で vector memory search を必須にすること。
- 初期実装で Admin UI を大規模再設計すること。
- 既存 MCP response の必須 top-level fields を破壊的に変更すること。

## 現状評価

現行実装には、EpisodeCard の土台になる部品は既にある。

| 領域 | 現状 | 実装上の扱い |
|---|---|---|
| Raw evidence | `vibe_memories`、`agent_diff_entries`、`audit_logs` がある | source of truth として残す |
| Vibe Memory MCP | `search_memory` / `fetch_memory` は raw memory 検索と fetch を返す | drill down surface として拡張する |
| Distillation | `vibe_memory` から rule/procedure 候補を作る pipeline がある | Episode から Knowledge 昇格する後段に使う |
| Compile | `knowledge_items` を text/vector/facet で取得し、pack item と trace を保存する | Episode lane を追加する |
| Decision | `knowledge_items` を role 別に検索し、evidence/coverage/confidence trace を保存する | Episode precedent lane を追加する |
| Context pack | schema は rules/procedures/guardrails/warnings 中心 | optional `episodes` を追加するか、MVP は diagnostics に限定する |
| SQLite | Vibe Memory、compile、decision の代表 path は SQLite branch を持つ | Episode repository も backend abstraction で作る |

不足しているのは、raw evidence と durable Knowledge の間にある「単発事例として使える圧縮 view」である。したがって実装対象は UI だけではなく、projection、retrieval、trace、compile/decision integration の小さな縦 slice になる。

## 設計方針

### EpisodeCard の責務

`EpisodeCard` は次の情報だけを持つ。

- 何が起きたか: `situation`、`observations`
- 何をしたか: `action`
- どうなったか: `outcome`
- 次回に使える学び: `lesson`
- 使ってよい条件: `applicability`
- 使ってはいけない条件: `anti_applicability`
- 根拠: `refs`
- 信頼度: `confidence`、`evidenceStatus`

`EpisodeCard` には raw log 全文を入れない。長文 transcript、tool result、diff full body は `refs` の先に置く。

### Ref の責務

`Ref` は元証拠へ戻るための stable entry point であり、本文を増やすためのものではない。

初期対応する ref kind:

| kind | ref value | 用途 |
|---|---|---|
| `vibe_memory` | memory id | imported agent history への drill down |
| `agent_diff` | diff entry id | file diff / symbol evidence への drill down |
| `compile_run` | run id | context pack と candidate trace への drill down |
| `decision_run` | decision id | decision evidence / coverage trace への drill down |
| `audit_log` | audit log id | operational event への drill down |
| `file` | absolute or repo-relative path | touched file evidence |
| `commit` | commit hash | post-merge evidence |

`queryHint` と `locator` は任意で持つ。`locator` は token range、line range、JSON pointer、section label などを許容する。

### Retrieval の責務分離

似ているかは retrieval の仕事であり、使ってよいかは applicability 判定の仕事である。

検索 lane:

- text lane: error code、tool name、file path、固有名詞。
- facet lane: repoKey、domains、technologies、changeTypes、tools、outcome。
- vector lane: EpisodeCard の compressed text。初期は optional。
- freshness lane: stale episode を下げる。
- evidence lane: refs と evidenceStatus が弱い Episode を下げる。

decision では compile より閾値を高くする。`outcome`、`applicability`、`anti_applicability`、`refs` が不足する Episode は evidence ではなく background hint として扱う。

## データモデル

### PostgreSQL schema 候補

```sql
CREATE TABLE episode_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  situation text NOT NULL,
  observations text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT '',
  lesson text NOT NULL DEFAULT '',
  applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  anti_applicability jsonb NOT NULL DEFAULT '{}'::jsonb,
  domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  technologies jsonb NOT NULL DEFAULT '[]'::jsonb,
  change_types jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  repo_path text,
  repo_key text,
  source_kind text NOT NULL,
  source_key text NOT NULL,
  outcome_kind text NOT NULL DEFAULT 'unknown',
  confidence real NOT NULL DEFAULT 50,
  evidence_status text NOT NULL DEFAULT 'unverified',
  status text NOT NULL DEFAULT 'active',
  stale_at timestamp,
  embedding vector,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE episode_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_card_id uuid NOT NULL REFERENCES episode_cards(id) ON DELETE CASCADE,
  ref_kind text NOT NULL,
  ref_value text NOT NULL,
  locator text,
  query_hint text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE episode_retrieval_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_card_id uuid NOT NULL REFERENCES episode_cards(id) ON DELETE CASCADE,
  run_kind text NOT NULL,
  run_id text NOT NULL,
  used_for text NOT NULL,
  verdict text NOT NULL,
  reason text,
  created_at timestamp NOT NULL DEFAULT now()
);
```

### SQLite 方針

- PostgreSQL と同じ logical schema を `src/db/sqlite/schema` 相当に追加する。
- JSON columns は text JSON として保存し、repository boundary で parse/validate する。
- 初期は FTS5 table `episode_cards_fts` を作る。
- `episode_cards.embedding` と sqlite-vec table は M2 以降の optional にする。
- `vibe_memories.embedding` と同じく、実際の backfill/search 経路ができるまで vector index を必須にしない。

### 型と schema

追加候補:

- `src/shared/schemas/episode-card.schema.ts`
- `src/modules/episodic-memory/episode-card.repository.ts`
- `src/modules/episodic-memory/episode-card.repository.sqlite.ts`
- `src/modules/episodic-memory/episode-card.service.ts`
- `src/modules/episodic-memory/episode-retrieval.service.ts`

外部入力は `zod` schema で検証し、service 内部へ raw unknown を流さない。

## MCP / API surface

### MCP

初期は既存 tool を破壊しない。

追加候補:

- `search_episodes`
  - query、domains、technologies、changeTypes、repoPath/repoKey、limit を受ける。
  - EpisodeCard の compressed fields と refs summary を返す。
- `fetch_episode`
  - episode id を受け、EpisodeCard と refs を返す。
  - `includeRawEvidence` は default false。
- `search_memory`
  - 互換維持。将来 `includeEpisodes` を optional にする程度に留める。
- `fetch_memory`
  - raw drill down として維持する。

`context_compile` / `context_decision` の response は、既存必須 fields を維持する。Episode 情報は optional section、diagnostics、または detail API から見られるようにする。

### REST API

追加候補:

- `GET /api/episodes`
- `GET /api/episodes/:id`
- `POST /api/episodes/:id/feedback`
- `GET /api/context-compiler/runs/:id/episodes`
- `GET /api/context-decision/runs/:id/episodes`

Admin UI はこの API だけを使い、repository へ直接依存しない。

## Context Compile 統合

### MVP

MVP では context pack の top-level schema を大きく変えず、次を行う。

- `retrieveEpisodes(input, { mode: "compile" })` を追加する。
- `diagnostics.retrievalStats.episodes` に hit count、selected count、degraded reason を保存する。
- selected Episode の refs を pack-level `sourceRefs` に追加する。
- rendered markdown には最大 2 件だけ「Related Episodes」として出す。

### 正式統合

MVP の有用性が確認できたら、`contextPackSchema` に optional `episodes: ContextPackItem[]` を追加する。`context_pack_items.section` には `episodes` を追加する。

pack item の shape:

```ts
{
  id: `episode:${episodeId}`,
  itemKind: "episode",
  itemId: episodeId,
  section: "episodes",
  title,
  content: compactEpisodeBody,
  score,
  rankingReason,
  sourceRefs,
  changeTypes,
  technologies,
  domains
}
```

`compactEpisodeBody` は `situation / action / outcome / lesson / applicability / anti_applicability` だけを短く含める。raw transcript は含めない。

## Context Decision 統合

Decision では Episode を Knowledge と同じ evidence role に混ぜない。別 role の `precedent` として扱う。

追加候補:

- `context_decision_episode_evidence`
  - decision id
  - episode card id
  - role: `supporting_precedent` / `counter_precedent` / `risk_precedent` / `background`
  - applicability score
  - anti-applicability score
  - weight at decision
  - source refs
  - metadata

判定ルール:

- `outcome` が unknown の Episode は direct execute の support にしない。
- `refs` がない Episode は decision evidence にしない。
- `anti_applicability` が現在 task に強く一致する Episode は risk/counter 側に寄せる。
- decision prompt には最大 2 件だけ入れる。
- Episode が Knowledge Assessment と矛盾する場合、Knowledge を優先し、Episode は revise/escalate の理由にする。

## UI 方針

最初から大きな画面を作らない。

MVP:

- Context Compile detail の ranking tab に Episode retrieval summary を追加する。
- Decision detail に Episode precedent summary を追加する。
- Vibe Memory page から Episode refs の drill down ができるようにする。

正式版:

- Admin に Episodes 一覧を追加する。
- Episode detail で Card、refs、raw drill down、retrieval feedback を表示する。
- Episode から `register_candidates` に送る導線を追加する。ただし自動昇格はしない。

## 実装マイルストーン

### M0: fixtures と手動 Episode baseline

目的: EpisodeCard が本当に有用かを、実装前に小さく評価できる状態にする。

実装:

- `test/fixtures/episodes/` に手作業の EpisodeCard JSON を 5 件置く。
- 成功事例、失敗事例、anti-applicability が強い事例、refs 不足事例、stale 事例を含める。
- `episode-card.schema` の parse test を追加する。
- concept の slice と、この implementation plan の milestone 対応を確認する。

検証:

- fixture が schema parse できる。
- refs 不足や outcome unknown が decision evidence から除外される expectation を書く。

### M1: Episode repository と backend schema

目的: EpisodeCard を保存・検索・fetch できる最小 substrate を作る。

実装:

- PostgreSQL migration を追加する。
- SQLite schema/bootstrap を追加する。
- repository contract を追加する。
- text/facet search を実装する。
- `search_episodes` / `fetch_episode` MCP tool を追加する。
- API read endpoints を追加する。

検証:

- repository unit test。
- SQLite runtime support test。
- MCP contract test。
- `bun run verify:sqlite` または repo-native verify で regression を確認する。

### M2: Episode projection pipeline

目的: raw evidence から EpisodeCard を作れるようにする。

実装:

- `vibe_memory` から EpisodeCard draft を作る service を追加する。
- `context_compile_runs` / `context_decision_runs` から outcome 付き EpisodeCard draft を作る service を追加する。
- projection は `draft` status から開始し、refs と evidenceStatus を必須にする。
- auto generation は default off。operator command または admin action から実行する。
- duplicate source guard を入れ、同じ source_kind/source_key から無制限に作らない。

検証:

- raw memory がない場合は structured degraded result を返す。
- refs なし draft は active 化できない。
- source duplicate が抑制される。

### M3: context_compile への読み取り統合

目的: Compile に過去事例を少数だけ入れ、作業地図を補正できるようにする。

実装:

- `retrieveEpisodes(input, { mode: "compile" })` を追加する。
- text/facet lane と confidence/evidence rerank を入れる。
- pack diagnostics に episode retrieval stats を保存する。
- rendered markdown に最大 2 件の related episodes を出す。
- selected episode と source refs を compile run detail で見られるようにする。

検証:

- Episode がない場合でも compile は degraded ではなく通常通り動く。
- refs 不足 Episode は selected されない。
- token budget を超える場合は Episode を優先的に落とす。
- 既存 context pack schema の互換性 test が通る。

### M4: context_decision への precedent 統合

目的: Decision が過去事例を条件付き precedent として使えるようにする。

実装:

- Decision 用 `retrieveEpisodes(input, { mode: "decision" })` を追加する。
- `context_decision_episode_evidence` 相当の persistence を追加する。
- confidence trace に `episodeAssessment` を追加する。
- prompt には最大 2 件だけ入れる。
- Reliability gate に refs/outcome/applicability 不足の cap を追加する。

検証:

- outcome unknown は execute support にならない。
- anti-applicability が一致する Episode は revise/reject 側に働く。
- Knowledge evidence と矛盾した場合、Episode だけで execute しない。
- Decision detail API で selected/rejected episodes が監査できる。

### M5: UI drill down と feedback

目的: 人間が Episode の採用理由と元証拠を確認できるようにする。

実装:

- Compile detail に Episode summary を表示する。
- Decision detail に Episode precedent を表示する。
- Episode detail API と UI を追加する。
- `episode_retrieval_feedback` を保存する。
- Good/Bad feedback ではなく、`used` / `not_relevant` / `needs_raw_check` / `stale` のような Episode 専用 verdict を使う。

検証:

- UI から refs drill down できる。
- feedback が retrieval ranking に即時破壊的影響を与えない。
- stale verdict が次回 ranking を下げる。

### M6: distillation 連携

目的: 複数 Episode から再利用可能な Rule / Procedure 候補を作る。

実装:

- 同一 repo/domain/changeType で似た Episode を cluster する。
- 繰り返し現れる lesson だけを `register_candidates` に送る。
- 単発 Episode は Knowledge 化しない。
- `knowledge_origin_links.origin_kind` に `episode_card` を追加するか、metadata sourceUri で `episode://...` を扱う。

検証:

- 1 Episode だけでは candidate を作らない。
- refs なし Episode は candidate source にならない。
- distillation output は既存 rule/procedure quality gate を通る。

## リリース順

1. M0 と M1 を同じ PR にしてよい。外部挙動は追加のみ。
2. M2 は projection 品質の review をしやすいように単独 PR にする。
3. M3 は compile の optional integration として入れる。Episode がない環境で差分が出ないことを必須にする。
4. M4 は decision 品質に影響するため、calibration test とセットにする。
5. M5/M6 は UI と learning loop のため、M3/M4 の有用性が確認できてから進める。

## 検証ゲート

各 milestone の共通 gate:

- `bun run verify` または対象 package の repo-native verify。
- SQLite mode の代表 test。
- PostgreSQL repository test。
- MCP contract test。
- schema parse test。

追加 gate:

- M3: context_compile の snapshot/contract test。
- M4: context_decision calibration test。
- M5: component test または API route test。
- M6: distillation quality test。

## 主要リスク

| リスク | 対応 |
|---|---|
| EpisodeCard がただの要約になりノイズ化する | refs、outcome、applicability、anti-applicability を active 条件にする |
| 過去成功事例を現在にも適用してしまう | decision では anti-applicability と confidence cap を必須にする |
| token budget を圧迫する | Episode は最大 2 件、raw は入れない、MVP では diagnostics 優先 |
| Knowledge と Episode の責務が混ざる | Episode は precedent、Knowledge は durable rule/procedure として分離する |
| SQLite/PostgreSQL で実装差が出る | repository contract と shared schema parse test を先に作る |
| UI が raw transcript viewer になる | detail では refs drill down に限定し、通常 view は Card を表示する |

## 未決事項

- `contextPackSchema` に `episodes` を追加する時期。MVP では diagnostics で始める。
- `episode_cards.embedding` の backfill をいつ有効化するか。
- EpisodeCard の active 化を人手 review 必須にするか、自動 gate で許可するか。
- `knowledge_origin_links.origin_kind` に `episode_card` を追加するか、`episode://` sourceUri だけで扱うか。
- stale 判定を時間ベースにするか、source refs の現在状態検査にするか。
