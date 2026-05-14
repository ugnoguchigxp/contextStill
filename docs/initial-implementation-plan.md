# Initial Implementation Plan

作成日: 2026-05-13

## 目的

この文書は、`memory-router` で最初に手掛ける実装単位を定義する。現在は初期実装の運用基準として扱い、今後の追加改善は `docs/improvement-plan.md` に分離して管理する。

最初の目標は、薄い MVP を急ぐことではない。PostgreSQL / pgvector 上にゼロベースのデータ定義を作り、Markdown source から evidence と knowledge を登録し、`context_compile` が根拠付きの context pack を返せる foundation を確実に作る。

## 実装状況（2026-05-13 更新）

この文書は構想ではなく、現行実装の運用基準として使う。新規ドキュメントは増やさず、本書を更新し続ける。

### 完了済み（Capability 1 の範囲）

- PostgreSQL + pgvector container / Drizzle schema / migration
- `knowledge_items`, `evidence_sources`, `evidence_fragments`, `relations`, `context_compile_runs`, `context_pack_items`, `code_symbols` の初期テーブル
- shared Zod schema と CLI / MCP adapter
- Markdown importer（evidence + knowledge 登録）
- `context_compile` の基盤実装（metadata/FTS/LIKE/vector の merge、status filter、ranking/dedupe）
- retrieval mode の明示指定（`skill_context` を含む）
- item 単位の `evidenceRefs` と pack-level `evidenceRefs`
- section ごとの token budget 制御（rules / skills / examples）
- retrieval 失敗（`*_FAILED`）と「該当なし」（`NO_*_MATCH`）の分離
- MCP resources 最小実装（summary, runs list, latest pack, run snapshot）

### 保留タスク再開結果（2026-05-13）

- 再開計画: `docs/deferred-tasks-resumption-plan.md`
- 保留していた項目は完了
  - DB integration test（repository / context compiler）
  - CLI compile JSON E2E
  - MCP tool/resources contract test
  - doctor 診断拡張（DB + vector + required tables + run health + freshness）
- 現時点の追加保留はなし

### 計画ギャップ解消（2026-05-14）

- `includeTrial` の意味を修正し、`trial` のみ明示許可（`draft` は通常注入しない）
- retrieval mode ごとの routing 差分を knowledge/evidence へ反映
- `code_context` を常に空にしない実装（code symbol index + file hint fallback）
- lifecycle manager の最小実装を追加（status 遷移ルールと注入対象ステータス解決）
- compile output/adapter のノイズ低減（dotenv quiet）
- integration test を追加
  - `includeTrial` セマンティクス（trial は可、draft は不可）
  - `code_context` fallback（symbol 0件時の file hint）
- 検証完了
  - `bun run verify` 成功
  - `bun run test:all` 成功
- 上記ギャップに関する追加保留は現時点でなし

## 採用方針

### 技術スタック

- Runtime: Bun
- Language: TypeScript
- DB: PostgreSQL + pgvector
- DB container: Gnosis で使っていた `pgvector/pgvector:pg16` container を流用可
- ORM / migration: Drizzle ORM + drizzle-kit
- Schema validation: Zod
- Test: Bun test
- Format / lint: Biome
- MCP: `@modelcontextprotocol/sdk`

Gnosis の Bun / Drizzle / MCP 構成を基準にし、`hono-standard` の domain module、shared schema、router / service / repository 分離を参考にする。

### Web server の扱い

最初の実装では Web server を必須にしない。

理由:

- 最初の価値は control plane UI ではなく、CLI / MCP から正しい context pack を返すこと。
- Hono API は、Context Pack Preview、Memory Inbox、Doctor UI などが必要になった段階で追加できる。
- service / repository / shared schema を先に切っておけば、後から Hono router を薄く載せられる。

ただし、将来の API 境界を壊さないため、domain service は HTTP 非依存にする。Hono を追加する場合も、router は Zod schema validation と service 呼び出しだけを担当する。

## プロジェクト構造

初期構成:

```text
memory-router/
  package.json
  tsconfig.json
  biome.json
  drizzle.config.ts
  docker-compose.yml
  .env.example
  src/
    index.ts
    config.ts
    db/
      client.ts
      schema.ts
      seed.ts
    shared/
      schemas/
        knowledge.schema.ts
        evidence.schema.ts
        context-pack.schema.ts
        compile.schema.ts
    modules/
      knowledge/
        knowledge.repository.ts
        knowledge.service.ts
      evidence/
        evidence.repository.ts
        evidence.service.ts
      context-compiler/
        context-compiler.repository.ts
        context-compiler.service.ts
        ranking.service.ts
        pack-renderer.ts
      sources/
        markdown-importer.service.ts
      code-index/
        code-index.repository.ts
        code-index.service.ts
    cli/
      compile.ts
      import-markdown.ts
      doctor.ts
    mcp/
      server.ts
      tools/
        context-compile.tool.ts
        index.ts
    lib/
      errors.ts
      ids.ts
      time.ts
  docs/
    initial-implementation-plan.md
    improvement-plan.md
  test/
    context-compiler.test.ts
    markdown-importer.test.ts
    repositories.test.ts
```

将来 Hono API を追加する場合:

```text
api/
  app.ts
  index.ts
  modules/
    context-compiler/
      context-compiler.routes.ts
    knowledge/
      knowledge.routes.ts
    evidence/
      evidence.routes.ts
```

API layer を追加しても、domain の本体は `src/modules/*/*.service.ts` と `*.repository.ts` に残す。

## レイヤリング規約

### shared schemas

`src/shared/schemas/*.schema.ts` は、CLI、MCP、将来の API、tests が共有する入出力 schema の Single Source of Truth にする。

ここには以下を置く。

- request schema
- response schema
- domain DTO
- enum / status / mode 定義
- Zod inferred type

DB row 型をそのまま公開しない。DB row は repository 境界内に閉じ、service から外へ出す値は shared schema で表現する。

### repository

repository は DB access だけを担当する。

- Drizzle query
- transaction
- insert / update / select
- DB row と persistence DTO の変換

やらないこと:

- context pack ranking
- lifecycle 判断
- user-facing error message の整形
- MCP / CLI / HTTP の入出力処理

### service

service は domain logic を担当する。

- knowledge lifecycle
- evidence registration
- retrieval orchestration
- ranking / dedupe
- context pack generation
- degraded state 判定

service は CLI / MCP / HTTP に依存しない。

### router / tool / CLI

router、MCP tool、CLI は adapter として扱う。

- Zod validation
- service 呼び出し
- response formatting
- process exit code / HTTP status / MCP result への変換

domain 判断をここに置かない。

## データモデル初期案

既存 Gnosis schema との互換は必須にしない。Gnosis の container は使ってよいが、database / schema は空から作る。

### knowledge_items

蒸留済みの知識。context pack に instruction / guidance として入りうる。

主な列:

- `id`
- `type`: `fact | decision | rule | procedure | skill | risk | lesson | example`
- `title`
- `body`
- `status`: `candidate | draft | trial | active | deprecated | rejected`
- `scope`: `user | repo | workspace | org | global`
- `applies_to`: jsonb
- `confidence`
- `importance`
- `embedding`: vector
- `metadata`: jsonb
- `created_at`
- `updated_at`
- `last_verified_at`

通常の `context_compile` は `active` のみを instruction として扱う。`candidate` / `draft` は検索や preview には出してよいが、明示指定なしに行動規範へ混ぜない。

### evidence_sources

証拠元の正本情報。

主な列:

- `id`
- `source_kind`: `markdown | session | tool_output | git | web | manual`
- `uri`
- `title`
- `content_hash`
- `metadata`
- `created_at`
- `updated_at`

### evidence_fragments

source の参照可能な断片。

主な列:

- `id`
- `source_id`
- `locator`: line range、byte range、JSON pointer、URL fragment など
- `content`
- `embedding`
- `metadata`
- `created_at`

context pack は `evidence_refs` として `evidence_fragments.id` を持つ。

### relations

知識、証拠、コード構造、compile run 間の関係。

主な列:

- `id`
- `source_kind`
- `source_id`
- `target_kind`
- `target_id`
- `relation_type`: `supports | derived_from | contradicts | supersedes | applies_to | mentions | impacts`
- `confidence`
- `metadata`
- `created_at`

### context_compile_runs

`context_compile` の実行履歴。

主な列:

- `id`
- `goal`
- `intent`
- `repo_path`
- `input`
- `retrieval_mode`
- `status`: `ok | degraded | failed`
- `degraded_reasons`
- `token_budget`
- `created_at`

### context_pack_items

compile run で採用された item。

主な列:

- `id`
- `run_id`
- `item_kind`
- `item_id`
- `section`: `rules | skills | examples | code_context | warnings | evidence`
- `score`
- `ranking_reason`
- `evidence_refs`
- `created_at`

### code_symbols

repository から抽出した構造情報。最初は table だけ用意し、詳細 indexer は後段でもよい。

主な列:

- `id`
- `repo_path`
- `file_path`
- `symbol_name`
- `symbol_kind`
- `signature`
- `start_line`
- `end_line`
- `metadata`
- `embedding`
- `created_at`
- `updated_at`

## 最初に作る capability

### Capability 1: Context Compiler Foundation

入力:

```ts
{
  goal: string;
  intent?: "plan" | "edit" | "debug" | "review" | "finish";
  repoPath?: string;
  files?: string[];
  changeTypes?: string[];
  technologies?: string[];
  tokenBudget?: number;
}
```

出力:

```ts
{
  goal: string;
  intent: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  minimalTasks: string[];
  rules: ContextPackItem[];
  skills: ContextPackItem[];
  examples: ContextPackItem[];
  warnings: string[];
  evidenceRefs: EvidenceRef[];
  diagnostics: {
    degradedReasons: string[];
    retrievalStats: object;
  };
}
```

最初の retrieval は以下に絞る。

- metadata filter
- Postgres full-text search
- exact / LIKE search
- pgvector search
- score merge
- status filter

Graph traversal、code impact analysis、LLM rerank はこの capability の必須範囲に入れない。ただし schema と service 境界は後から追加できる形にする。

## 実装順序

1. repository skeleton を作る
2. package scripts を定義する
3. docker-compose / .env.example を作る
4. Drizzle schema と migration を作る
5. Zod shared schemas を作る
6. knowledge repository / service を作る
7. evidence repository / service を作る
8. Markdown importer を作る
9. context compiler repository / service を作る
10. CLI `memory-router compile` を作る
11. MCP `context_compile` tool を作る
12. doctor を作る
13. tests を通す

## 品質基準

`context_compile` は以下を満たすまで完了扱いにしない。

- `candidate` / `draft` を通常 instruction に混ぜない
- context pack item に `ranking_reason` がある
- instruction と evidence が別 section になる
- evidence 由来の主張には `evidence_refs` がある
- retrieval 失敗と「該当なし」を別の degraded reason として表現する
- token budget を超えないよう section ごとに上限を持つ
- 同じ source / item を重複表示しない
- DB 接続不可時に doctor が原因を返す

## テスト計画

最初に必要な test:

- Zod schema validation
- repository insert / search
- status lifecycle filter
- Markdown importer の source / fragment 作成
- vector unavailable 時の degraded fallback
- `context_compile` の ranking / dedupe
- CLI compile の JSON output
- MCP tool schema snapshot

DB integration test は、環境変数で明示的に有効化する。通常 unit test は DB なしで動く範囲を残す。

## 保留事項

- Hono API / Web control plane をいつ入れるか
- React / TanStack Router UI を作るか
- code symbol indexer に TypeScript Compiler API / Astmend / tree-sitter のどれを使うか
- LLM rerank を local Gemma4 と cloud provider のどちらから始めるか
- Gnosis への統合時に repo 名を変更するか
