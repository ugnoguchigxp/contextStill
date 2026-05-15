# Code Review Issue 一覧 & タスクチェックリスト

> **作成日**: 2026-05-15
> **最終確認日**: 2026-05-15
> **ソース**: [project-value-assessment.md](./project-value-assessment.md) のコードレビュー結果
> **対象**: memory-router v0.1.0

---

## 方針

memory-router は **ローカルファースト** のツールである。ナレッジや Markdown ファイルの共有は行うが、サーバーホスティングやパブリック公開は当面の対象外。この前提に基づき、以下の優先度で Issue を整理する。

**優先すべきもの:**

- ローカルでの `context_compile` / distillation / search の品質と信頼性
- 開発速度を支えるコード品質・型安全性
- 日常的に使う CLI / MCP / Web API の安定性
- `bun run verify` に含めるべき回帰テストの追加

**後回しにするもの:**

- サーバーホスト前提のセキュリティ対策。ただし LLM が任意 URL を fetch できる箇所はローカルでも被害範囲を限定する
- Web UI の広範な E2E テスト。ローカル開発者が目視確認できる範囲は後回しでよい
- semantic cache のような性能最適化。まず実測値と無効化条件を固める

---

## 使い方

- `[ ]` → 未着手
- `[x]` → 完了
- 各 Issue には **概要**、**現行確認**、**影響範囲**、**具体的タスク**、**受け入れ条件**、**関連ファイル** を記載
- 優先度は High / Medium / Low の 3 段階
- パスは 2026-05-15 時点の current checkout に合わせる

---

## High Priority

> ローカル運用の `context_compile` / distillation 品質に直結する Issue。

### Issue #1: repo scope 検索条件の正規化と index 整備

- [x] **完了**

**概要**

`knowledge_items.applies_to` は存在し、`buildKnowledgeScopeMetadata()` も `repoPath` / `repoKey` を `metadata` と `appliesTo` の両方に格納する実装になっている。一方で、検索条件はまだ `appliesTo`、`metadata`、`sourceUri`、`sourceDocumentUri` を広い OR 条件で見る形になっており、repo scope の主経路が明確ではない。`appliesTo` を正式な scope 判定の主データにし、既存データの backfill と index を揃える。

**現行確認**

- `buildKnowledgeScopeMetadata()` は `repoPath` / `repoKey` を `metadata` と `appliesTo` に正規化しているため、「appliesTo へ書き込まれていない」という指摘は現状では古い
- `drizzle/0009_source_uri_unique_repo_scope.sql` に加えて `drizzle/0012_applies_to_scope_indexes.sql` でも idempotent backfill を実施している
- `knowledge_items_applies_to_repo_key_idx` / `knowledge_items_applies_to_repo_path_idx` を追加済み
- `buildRepoScopedCondition()` は `scopeMatchMode` により `primary(appliesTo/global)` と `legacy(metadata/sourceUri)` を分離し、主経路に fallback を混在させない
- `search_knowledge` / `context_compile` の共通検索経路で、primary で空振りした場合のみ legacy fallback を実行し、`KNOWLEDGE_APPLIES_TO_FALLBACK` を付与する
- primary hit が存在する場合は legacy-only item を返さないことを integration test で検証済み

**影響範囲**

- `context_compile` 実行時に repo scope の fallback が発生しやすくなり、別 repo 由来の knowledge 混入リスクが残る
- `search_knowledge` と `context_compile` の repo scope 判定が同じ helper に依存しているため、条件の曖昧さが両方へ波及する
- JSONB の `->>` OR 条件が増えるほど query plan が読みづらくなり、将来の性能調査が難しくなる

**具体的タスク**

1. `appliesTo` を repo scope 判定の主経路として明文化する
   - 新規 upsert / distillation / import は `repoPath` / `repoKey` を必ず `appliesTo` に入れる
   - `metadata` は互換 fallback と provenance 用に残すが、主条件にはしない
   - `sourceUri` / `sourceDocumentUri` prefix fallback は、backfill 不能な旧データ救済に限定する
2. 既存 migration の状態を確認する
   - `drizzle/0009_source_uri_unique_repo_scope.sql` が現行 DB に適用済みか確認する
   - 未反映 DB があり得る場合は、idempotent な追加 migration で `applies_to` を再 backfill する
   - `metadata.repoKey` / `metadata.repoPath` があるのに `applies_to` が空のレコードがないことを integration test で検証する
3. `applies_to` 用 index を追加する
   - 最低限 `applies_to ->> 'repoKey'` の expression index を追加する
   - repoPath 完全一致を使うなら `applies_to ->> 'repoPath'` の expression index も追加する
   - JSONB 包含検索へ寄せるなら GIN index を検討するが、現行の `->>` 条件のままなら btree expression index を優先する
4. `buildRepoScopedCondition()` を段階的に整理する
   - 第 1 条件は `scope = 'global'` と `applies_to ->> 'repoKey'` / `applies_to ->> 'repoPath'`
   - `metadata.repoKey` / `metadata.repoPath` は旧データ fallback として残し、degraded reason で検知できるようにする
   - `sourceUri` / `sourceDocumentUri` prefix fallback は最後段に下げ、削除可能な条件か別 issue で追跡する
5. repo scope の回帰テストを追加する
   - active / draft / deprecated を含む同一 repo の hit
   - 別 repo の draft knowledge が混入しないこと
   - global scope は `allowGlobalScope` が有効な場合だけ返ること
   - `appliesTo` 欠落の旧データが fallback される場合は degraded reason が付くこと

**受け入れ条件**

- `context_compile` に `repoPath` を渡した場合、別 repo 由来の draft knowledge が返らない
- `search_knowledge` と `context_compile` が同じ repo scope helper を通る
- `applies_to ->> 'repoKey'` または同等の主検索条件に index が存在する
- `metadata` fallback は旧データ互換としてだけ使われ、主条件ではないことがコード上分かる
- repo scope の integration test が `bun run test:integration` で実行される

**関連ファイル**

- [knowledge.repository.ts](../src/modules/knowledge/knowledge.repository.ts) — `buildRepoScopedCondition`, `buildKnowledgeScopeMetadata`
- [knowledge.service.ts](../src/modules/knowledge/knowledge.service.ts) — `retrieveKnowledge`, `searchKnowledgeCandidates`
- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts) — `compileContextPack`
- [schema.ts](../src/db/schema.ts) — `knowledgeItems` table / index
- [0009_source_uri_unique_repo_scope.sql](../drizzle/0009_source_uri_unique_repo_scope.sql) — existing backfill
- [0012_applies_to_scope_indexes.sql](../drizzle/0012_applies_to_scope_indexes.sql) — idempotent backfill + appliesTo index
- [context-compile-mcp-improvement-plan.md](./context-compile-mcp-improvement-plan.md) — Phase 1

---

### Issue #2: `context-compiler.service.ts` の型キャスト削減

- [x] **完了**

**概要**

`compileContextPack()` 内で `(item as { type: string }).type`、`(item as { sourceRefs?: string[] }).sourceRefs` のようなキャストが残っている。`rankAndDedupe()` の base `Rankable` は汎用 ranker として最小フィールドだけを要求しているため、Context Compiler 側で knowledge 用の rankable 型を明示する必要がある。

**現行確認**

- `Rankable` は `type` と `sourceRefs` を持たない
- `status` は optional で定義されている
- `compileContextPack()` 側の `rankedKnowledge` は実際には `type` / `status` / `sourceRefs` を持つ shape に整形済み
- base `Rankable` に `type` / `sourceRefs` を required 追加すると、汎用 ranker の呼び出し側を不必要に縛る可能性がある

**影響範囲**

- 型安全性の低下。キャスト先の型と実際の値がズレても TypeScript が検出できない
- `selectedStatuses` や `sourceRefs` の扱いを変更した時にキャスト箇所を見落とすリスク
- `rankAndDedupe()` の再利用時に、どのフィールドが ranker に必要でどのフィールドが Context Compiler に必要か分かりにくい

**具体的タスク**

1. `ranking.service.ts` の base 型を export する
   ```typescript
   export type Rankable = {
     id: string;
     title: string;
     content: string;
     score: number;
     confidence?: number;
     importance?: number;
     status?: string;
     hasSourceLinks?: boolean;
     sourceRefCount?: number;
     stale?: boolean;
   };
   ```
2. `context-compiler.service.ts` 側に knowledge 専用型を定義する
   ```typescript
   type KnowledgeRankable = Rankable & {
     type: KnowledgeItem["type"];
     status: KnowledgeStatus;
     sourceRefs: string[];
   };
   ```
3. `knowledge.items.map(...)` の戻り値を `KnowledgeRankable[]` として明示する
4. `rankAndDedupe<KnowledgeRankable>(...)` として呼び、戻り値から直接 `type` / `status` / `sourceRefs` を読む
5. `toKnowledgePackItem` / `selectSourceRefsForKnowledge` の引数型を `KnowledgeRankable` またはそこから Pick した型に寄せる
6. `context-compiler.service.ts` 内の `as { ... }` キャストを削除する

**受け入れ条件**

- `context-compiler.service.ts` の `as {` 型キャストが 0 件
- `rankAndDedupe()` は汎用 ranker のまま維持される
- `KnowledgeRankable` の型で `type` / `status` / `sourceRefs` が compile-time に保証される
- `bun run typecheck` が成功する

**関連ファイル**

- [ranking.service.ts](../src/modules/context-compiler/ranking.service.ts) — `Rankable`, `rankAndDedupe`
- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts) — `compileContextPack`
- [schema.ts](../src/db/schema.ts) — `KnowledgeItem`, `KnowledgeStatus`

---

### Issue #3: `estimateTokens` の日本語過小評価

- [x] **完了**

**概要**

`context-compiler.service.ts` の `estimateTokens()` は `Math.ceil(text.length / 4)` を使っている。英語では概算として成立しやすいが、日本語・CJK では過小評価になりやすい。`truncateForBudget()` も `maxTokens * 4` の文字数換算で切っているため、日本語 knowledge が多い場合に token budget を超えやすい。

**現行確認**

- `estimateTokens(text)` は文字列長を 4 で割るだけ
- `truncateForBudget(content, maxTokens)` は `maxTokens * 4` 文字で切る
- `allocateSectionBudget()` はこの推定値を前提に section budget を消費している
- 日本語の厳密な tokenizer は導入されていない

**影響範囲**

- 日本語 knowledge を多く含む compile 結果が token budget を超過し、エージェントのコンテキストウィンドウを圧迫する
- section ratio による配分が意図通りに機能しない
- `TOKEN_BUDGET_SECTION_LIMIT_REACHED` の発生判断が実態とズレる

**具体的タスク**

1. まず依存なしの保守的 heuristic に置き換える
   - ASCII printable は 4 chars/token 相当
   - whitespace は軽く扱う
   - CJK Unified Ideographs、ひらがな、カタカナ、全角記号は 1.2-1.5 chars/token 相当に寄せる
   - emoji / surrogate pair は過小評価しないよう 1 char/token に寄せる
2. `truncateForBudget()` は文字数換算ではなく、推定 token を増分計算しながら切る
   - budget を超える直前まで code point 単位で走査する
   - 切り詰め suffix `...` または `…` の token 分も予算に含める
3. tokenizer 導入は別判断にする
   - `±20%` の精度を受け入れ条件にするなら tokenizer 導入を検討する
   - 依存なし heuristic の場合は「実トークンに対して保守的に多め」を受け入れ条件にする
4. unit test を追加する
   - 英語だけの長文
   - 日本語だけの長文
   - 英日混在文
   - code block / file path / symbol 名を含む文
   - `truncateForBudget()` が日本語で明らかに予算超過する文字数を返さないこと

**受け入れ条件**

- 日本語テキストで現行 `length / 4` より大きく見積もられる
- 英語テキストで現行と大きく乖離しすぎない
- `truncateForBudget()` が `estimateTokens(result) <= maxTokens` を満たす
- `bun run test:unit` に token estimator の回帰テストが含まれる
- tokenizer を導入しない限り、`±20%` のような厳密精度を acceptance に置かない

**関連ファイル**

- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts) — `estimateTokens`, `truncateForBudget`, `allocateSectionBudget`
- [context-compiler.service.test.ts](../test/context-compiler.service.test.ts) — unit tests
- [context-compiler.integration.test.ts](../test/context-compiler.integration.test.ts) — budget behavior

---

### Issue #4: `retrieveKnowledge` と `searchKnowledgeCandidates` の検索ロジック重複

- [x] **完了**

**概要**

`knowledge.service.ts` の `retrieveKnowledge()` と `searchKnowledgeCandidates()` は、text search、vector search、merge、repo scope fallback、degraded reason の組み立てが重複している。Issue #1 の repo scope 修正を安全に入れるためにも、検索実行の共通部分を 1 箇所へ寄せる。

**現行確認**

- `retrieveKnowledge()` は `compileContextPack()` 用で、`retrievalMode`、`includeDraft`、外部から渡された `queryEmbedding` を扱う
- `searchKnowledgeCandidates()` は MCP/API の raw candidate inspection 用で、入力から embedding を生成する
- 両者とも `config.enableVectorSearch`、text/vector merge、fallback search、degraded reason を持つ
- 差分を無視して単純統合すると、`queryEmbedding` の再利用や status 解決が壊れる

**影響範囲**

- repo scope 修正を 2 箇所に入れる必要があり、修正漏れが起きやすい
- `context_compile` と `search_knowledge` で検索品質や degraded reason が乖離しやすい
- unit test が片方だけを守っている場合に、もう片方の regressions を見逃す

**具体的タスク**

1. internal search executor を抽出する
   ```typescript
   type InternalKnowledgeSearchParams = {
     query: string;
     queryText: string;
     limit: number;
     statuses: KnowledgeStatus[];
     types?: KnowledgeItem["type"][];
     repoPath?: string;
     repoKey?: string;
     allowGlobalScope?: boolean;
     includeDraft?: boolean;
     queryEmbedding?: number[];
     embeddingProvider?: string;
     noMatchReason: "NO_ACTIVE_KNOWLEDGE_MATCH";
     repoFallbackReason: "KNOWLEDGE_REPO_SCOPE_FALLBACK";
   };
   ```
2. executor の責務を限定する
   - text search を実行する
   - `queryEmbedding` がある場合だけ vector search を実行する
   - `queryEmbedding` がなく、必要なら wrapper 側で embedding 生成を済ませる
   - text/vector hit を dedupe + merge する
   - repo scope fallback を 1 箇所で実行する
   - degraded reasons と stats を返す
3. wrapper 側の責務を残す
   - `retrieveKnowledge()` は `retrievalMode` から statuses/types/limit を決める
   - `retrieveKnowledge()` は `input.queryEmbedding` があれば再生成しない
   - `searchKnowledgeCandidates()` は `status/statuses/includeDraft` を schema から解決する
   - `searchKnowledgeCandidates()` は raw candidate inspection 用の limit と type filter を維持する
4. test を分ける
   - executor の merge / fallback / vector unavailable を unit test
   - `retrieveKnowledge()` の retrieval mode と queryEmbedding reuse を unit test
   - `searchKnowledgeCandidates()` の status 解決と raw search behavior を unit test

**受け入れ条件**

- text/vector merge、repo scope fallback、degraded reason 生成が 1 箇所に集約される
- `retrieveKnowledge()` は既存の `queryEmbedding` を再利用できる
- `searchKnowledgeCandidates()` の public input/output shape が変わらない
- `bun run verify` が通る
- 既存 integration test がそのまま通る

**関連ファイル**

- [knowledge.service.ts](../src/modules/knowledge/knowledge.service.ts) — `retrieveKnowledge`, `searchKnowledgeCandidates`
- [knowledge.repository.ts](../src/modules/knowledge/knowledge.repository.ts) — text/vector search
- [knowledge.service.test.ts](../test/knowledge.service.test.ts) — unit tests
- [context-compiler.integration.test.ts](../test/context-compiler.integration.test.ts) — compile behavior

---

## Medium Priority

> コード品質・メンテナンス性の改善。日常開発の生産性に寄与する。

### Issue #5: `weightedScore` の再計算コスト

- [x] **完了**

**概要**

当初は `rankAndDedupe()` の sort 比較中に `weightedScore()` が繰り返し計算される懸念があったが、現行実装では Map に `{ item, weighted }` を保持し、dedupe 時に計算済みの weighted score を sort で再利用している。

**現行確認**

- `rankAndDedupe()` は item ごとに `const weighted = weightedScore(item)` を 1 回計算している
- `byId` は `{ item, weighted }` を保持している
- sort 比較は `b.weighted - a.weighted` を使っている
- この Issue は追加実装不要

**影響範囲**

- なし。現行実装で当初懸念は解消済み

**具体的タスク**

1. 追加タスクなし
2. ranking を変更する別 Issue では、現行の O(n) score 計算を維持する
3. `ranking.service.test.ts` を追加・更新する場合は、dedupe と tie-break の挙動を守る

**受け入れ条件**

- 現行の `rankAndDedupe()` が weighted score を sort 中に再計算しない
- 今後の ranking 変更でも `{ item, weighted }` 構造を壊さない

**関連ファイル**

- [ranking.service.ts](../src/modules/context-compiler/ranking.service.ts)
- [ranking.service.test.ts](../test/ranking.service.test.ts)

---

### Issue #6: `config.ts` のフラット構造

- [x] **完了**

**概要**

`config.ts` は flat な `config.xxx` 参照が多数あり、database、embedding、compile、distillation、source、doctor、agent-log-sync の設定が同じ階層に並んでいる。設定が増えるほど責務境界が見えにくくなる。

**現行確認**

- `config.sourceContentRoot`、`config.localLlmModel`、`config.embeddingDimension`、`config.vibeDistillationMaxInputChars` などの参照が API / CLI / modules / tests に広く存在する
- `package.json` の `verify` は typecheck/lint/format/test/build を通すため、config 分割時の import drift は検出しやすい
- 一括で nested config に移行すると diff が広がりやすい
- `groupedConfig` を導入し、`database` / `embedding` / `localLlm` / `compile` / `doctor` などのカテゴリへ整理した
- 既存の `config.xxx` 参照は `Object.defineProperties` の alias で互換維持しているため、既存の module/test を壊さず段階移行できる
- `bun run verify` が通ることを確認済み

**影響範囲**

- 新しい設定項目の追加時に命名衝突や配置迷いが起きる
- distillation 系設定と runtime 系設定の関係が読み取りづらい
- テストの mock config が大きくなりやすい

**具体的タスク**

1. まず型付き grouped config を内部で作る
   ```typescript
   const groupedConfig = {
     database: { url },
     embedding: { provider, daemonUrl, dimension },
     localLlm: { apiBaseUrl, apiKey, model },
     compile: { defaultTokenBudget, enableVectorSearch },
     vibeDistillation: { promptVersion, batchSize, maxInputChars, maxOutputTokens },
     sourceDistillation: { promptVersion, batchSize, maxInputChars, maxOutputTokens },
     distillationTools: { timeoutMs, maxRounds, resultMaxChars, searchResultCount },
     sourceContent: { root },
     agentLogSync: { interval, initialLookback, lockFile, lockTtlSeconds },
     doctor: { freshnessThreshold, degradedRateThreshold },
   };
   ```
2. 互換期間を設けるか判断する
   - churn を抑えるなら `config.xxx` flat alias を残し、内部 grouped config から展開する
   - 一気に移行するなら `config.embedding.dimension` のような参照へ全置換する
3. test mock を先に確認する
   - `vi.mock("../src/config.js")` しているテストの shape を壊さない
   - flat alias を残す場合は既存 mock が通る
4. 移行後に不要な alias を削除する別 issue を作る

**受け入れ条件**

- 設定項目がカテゴリ別に整理される
- 既存の config mock が壊れない、または同じ PR で更新される
- `bun run verify` が通る
- README / docs に記載する env var 名が実装と一致する

**関連ファイル**

- [config.ts](../src/config.ts)
- [package.json](../package.json) — `verify`
- [sources.routes.ts](../api/modules/sources/sources.routes.ts) — source content config consumers
- [distillation.service.ts](../src/modules/vibe-memory/distillation.service.ts) — vibe distillation config consumers
- [distillation.service.ts](../src/modules/sources/distillation.service.ts) — source distillation config consumers
- [doctor.service.ts](../src/modules/doctor/doctor.service.ts) — doctor config consumers

---

### Issue #7: `doctor.service.ts` の単一ファイル肥大化

- [x] **完了**

**概要**

`doctor.service.ts` は DB、vector、embedding、LaunchAgent、compile run、MCP surface、agent-log-sync、vibe/source distillation を 1 ファイルで診断している。診断項目を増やすほど変更範囲が大きくなり、個別テストもしづらい。

**現行確認**

- `doctor.service.ts` は required table、MCP tool、options、DB probe、embedding probe、recent compile run、distillation freshness をまとめて扱っている
- `config.doctorDegradedRateThreshold` など flat config にも依存している
- 100 行以内という硬い制約は実装目標として不自然。責務が orchestration に限定されていることを重視する
- `inspectors/` 配下へ `database` / `embedding` / `mcp` / `compile` / `agent-log-sync` / `vibe-distillation` / `source-distillation` を分割した
- `doctor.service.ts` は options 解決、inspector 呼び出し、reasons/status 集約、schema parse を主責務とする構成へ変更した
- `bun run verify` と `test/doctor.service.test.ts` が通ることを確認済み

**影響範囲**

- 新しい診断を追加するたびに巨大ファイルを触る必要がある
- 失敗原因が DB なのか embedding なのか distillation なのか、テスト単位で切り分けづらい
- Web UI の Doctor 表示にも影響するため、変更時の regression 範囲が広い

**具体的タスク**

1. inspector 単位に分割する
   ```text
   src/modules/doctor/
   ├── doctor.service.ts
   ├── doctor.types.ts
   ├── inspectors/
   │   ├── database.inspector.ts
   │   ├── embedding.inspector.ts
   │   ├── mcp.inspector.ts
   │   ├── compile.inspector.ts
   │   ├── agent-log-sync.inspector.ts
   │   ├── vibe-distillation.inspector.ts
   │   └── source-distillation.inspector.ts
   └── launch-agent.util.ts
   ```
2. `runDoctor()` は orchestration に限定する
   - options を解決する
   - inspector を順に呼ぶ
   - status / warnings / summary を集約する
   - schema に合う result を返す
3. inspector は独立 test できる pure-ish function にする
   - DB client / repository function を引数注入できるようにする
   - time-dependent な freshness 判定は `now` を注入する
4. Web/API response shape を変えない
   - [doctor.schema.ts](../src/shared/schemas/doctor.schema.ts) に合わせる
   - `api/modules/doctor` と `web/src/modules/admin/components/doctor.page.tsx` を壊さない

**受け入れ条件**

- `doctor.service.ts` は orchestration と public API を主責務にする
- 各 inspector が単体でテスト可能
- Doctor の response shape が既存 schema と互換
- `bun run verify` が通る

**関連ファイル**

- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)
- [doctor.schema.ts](../src/shared/schemas/doctor.schema.ts)
- [doctor.routes.ts](../api/modules/doctor/doctor.routes.ts)
- [doctor.page.tsx](../web/src/modules/admin/components/doctor.page.tsx)
- [doctor.service.test.ts](../test/doctor.service.test.ts)

---

### Issue #8: API ルートのテスト不在

- [x] **完了**

**概要**

`api/` 配下に Hono ベースの API ハンドラがあるが、API の request/response 契約を直接守るテストが薄い。Web UI と API の境界が変わっても `verify` で検出できるようにする。

**現行確認**

- API entrypoint は [api/app.ts](../api/app.ts)
- route は `api/modules/*/*.routes.ts` に分かれている
- `test/api.routes.test.ts` で `Hono app.request()` による契約テストを追加済み
- `package.json` に `test:unit:api` を追加し、`test:unit` から `vitest` 実行を呼び出す形で `verify` に含めた
- DB 前提の happy path は `test/api.routes.integration.test.ts` を追加し、`test:integration` で実行される構成にした

**影響範囲**

- API のリクエスト/レスポンス形式の変更が無検知で通る
- Web repository 側の型・fetch 実装と API response がズレる
- Zod schema / route validation の regression を見逃す

**具体的タスク**

1. `test/api/` または `test/api.*.test.ts` を追加する
2. Hono の `app.request()` で契約テストを作る
   - DB 不要な validation failure は unit test
   - DB を使う happy path は integration test
3. 最低限の対象を決める
   - `POST /api/context/compile` — 入力 validation と response shape
   - `GET /api/doctor` — health report shape
   - `GET /api/knowledge` — list/search response shape
   - `POST /api/knowledge/:id/status` または現行 route の status 更新契約
   - `POST /api/vibe-memory` — ingestion request shape
4. `package.json` の test script を更新する
   - unit に含める API test は `test:unit` の列挙に追加する
   - DB 必須 test は `test:integration` に追加する
5. Web repository の期待 shape と揃える
   - `web/src/modules/admin/repositories/admin.repository.ts`
   - `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`

**受け入れ条件**

- 主要 API の入出力契約テストが存在する
- DB 不要な API validation test は `bun run verify` に含まれる
- DB 必須 test は `bun run test:integration` で実行される
- Web repository が期待する response shape と route test が一致する

**関連ファイル**

- [api/app.ts](../api/app.ts)
- [api/modules/context-compiler/context-compiler.routes.ts](../api/modules/context-compiler/context-compiler.routes.ts)
- [api/modules/doctor/doctor.routes.ts](../api/modules/doctor/doctor.routes.ts)
- [api/modules/knowledge/knowledge.routes.ts](../api/modules/knowledge/knowledge.routes.ts)
- [api/modules/vibe-memory/vibe-memory.routes.ts](../api/modules/vibe-memory/vibe-memory.routes.ts)
- [admin.repository.ts](../web/src/modules/admin/repositories/admin.repository.ts)
- [context-compiler.repository.ts](../web/src/modules/context-compiler/repositories/context-compiler.repository.ts)
- [package.json](../package.json)

---

### Issue #12: `context_compile` レイテンシ計測と semantic cache 設計

- [x] **完了**

**概要**

AI エージェントが作業前に `context_compile` を呼ぶため、compile latency は体感速度に直結する。ただし semantic cache は invalidation を誤ると古い knowledge を返す危険がある。現時点では、いきなり cache を実装するより、まず compile latency の測定と cache key / invalidation 設計を固める。

**現行確認**

- compile run は `context_compile_runs` に保存される
- recent run は Doctor で参照される
- compile duration / cache hit / cache miss の専用指標は未整備
- Knowledge 更新時に compile cache を無効化する仕組みはない

**影響範囲**

- 似た intent / goal の連続 compile で無駄な検索・ranking が発生する
- cache を雑に入れると、新規 active knowledge が反映されない
- repo scope や token budget が違う入力を誤って同一 cache とみなすリスクがある

**具体的タスク**

1. 先に計測を追加する
   - `context_compile_runs` に durationMs を追加するか、metadata / diagnostics に実行時間を記録する
   - Doctor に p50 / p95 / degraded rate を表示するか検討する
   - `context_compile` MCP response に過度なノイズを増やさず diagnostics へ入れる
2. cache key を設計する
   - `repoKey` / `repoPath`
   - `intent` / `goal` / `taskType` / `files`
   - `retrievalMode`
   - `tokenBudget`
   - active knowledge の freshness marker
   - source corpus の freshness marker
3. invalidation を設計する
   - `knowledge_items` の status が `active` に変わった時
   - `knowledge_items` が deprecated になった時
   - source distillation が active knowledge を生成した時
   - repo scope ごとの invalidation にできるか検討する
4. semantic similarity を使うかを決める
   - exact normalized key cache から始める
   - semantic cache は similarity threshold と false hit のリスクを別途評価する
   - embedding 未使用環境でも compile が動く fallback を残す

**受け入れ条件**

- cache 実装前に compile latency の実測値が取れる
- cache key に repo scope / retrieval mode / token budget / freshness が含まれる
- Knowledge 更新時の invalidation 条件がコードまたは設計 doc に明示される
- semantic cache を入れる場合、false hit を検出する test がある
- cache なしでも現行 behavior が維持される

**関連ファイル**

- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts)
- [context-compiler.repository.ts](../src/modules/context-compiler/context-compiler.repository.ts)
- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)
- [schema.ts](../src/db/schema.ts)
- [context-compile-cache-design.md](./context-compile-cache-design.md)

---

### Issue #13: コールドスタート対策の CLI / import 導線整理

- [x] **完了**

**概要**

導入直後の新規プロジェクトでは `vibe_memories` や `sources` が空であるため、Context Compiler が抽出できる knowledge が少ない。初期 seed、Markdown import、source distillation までの導線を memory-router の現行 CLI 構成に合わせて整理する。

**現行確認**

- 現行 CLI は `src/cli/*.ts` の 1 file 1 command 形式
- `package.json` には `import:markdown`、`import:sources`、`distill:vibe-memory`、`distill:sources`、`backfill:knowledge-project-context` がある
- `src/cli/commands/init.ts` のような commands directory は存在しない
- `gnosis init --preset=typescript-react` という表現はこの repo には不適切
- distillation は共通 runtime と、vibe/source それぞれの service に分かれている
- `src/cli/init-project.ts` を追加し、`bun run init:project` で `import -> global preset seed -> (任意) distill:sources -> smoke compile` を順次実行できるようにした
- step ごとの失敗境界を `[init-project/<step>]` として返し、CLI 出力で失敗箇所を即時特定できるようにした
- README に初回導線と、`scope: global` preset / `scope: repo` distillation の分離方針を追記した

**影響範囲**

- 新規導入時に、どのコマンドをどの順で実行すれば knowledge が増えるか分かりにくい
- import だけでは active knowledge まで到達せず、`context_compile` の価値が出るまで時間がかかる
- preset が global knowledge として混ざると repo-specific なルールと競合する可能性がある

**具体的タスク**

1. 現行 CLI に合わせた初期化導線を設計する
   - 追加するなら `src/cli/seed-preset.ts` または `src/cli/init-project.ts`
   - package script は `seed:preset` または `init:project` のように memory-router 名義にする
   - `gnosis` というコマンド名は使わない
2. preset の scope を明確にする
   - 一般的な TypeScript / React ルールは `scope: global`
   - repo 固有の設計判断は import/distillation から `scope: repo`
   - global preset は少量に抑え、既存 knowledge を上書きしない
3. Markdown import と distillation をつなぐ
   - `import:markdown` / `import:sources` の後に `distill:sources` を実行する推奨手順を README / CLI output に出す
   - `--distill` を追加する場合は、import と distillation の失敗境界を明確にする
   - 大量 Markdown では batch size / max input chars / retry behavior を設定できるようにする
4. 初回 smoke を追加する
   - preset or import 後に `context_compile` で 1 件以上の relevant knowledge が返ること
   - active にしない draft 運用の場合は、HITL review への導線を示す

**受け入れ条件**

- memory-router の現行 CLI 構成に合った初期化コマンドまたは手順になっている
- `gnosis` や存在しない `src/cli/commands/*` への参照がない
- import から distillation、review、compile までの初回導線が README / CLI output で分かる
- global preset と repo-specific knowledge の scope が分離されている

**関連ファイル**

- [package.json](../package.json) — CLI scripts
- [init-project.ts](../src/cli/init-project.ts)
- [import-markdown.ts](../src/cli/import-markdown.ts)
- [import-sources.ts](../src/cli/import-sources.ts)
- [distill-sources.ts](../src/cli/distill-sources.ts)
- [distill-vibe-memory.ts](../src/cli/distill-vibe-memory.ts)
- [backfill-knowledge-project-context.ts](../src/cli/backfill-knowledge-project-context.ts)
- [README.md](../README.md) — 初回導線
- [distillation-runtime.service.ts](../src/modules/distillation/distillation-runtime.service.ts)
- [distillation.service.ts](../src/modules/sources/distillation.service.ts)
- [distillation.service.ts](../src/modules/vibe-memory/distillation.service.ts)

---

### Issue #14: Human-in-the-Loop (HITL) 運用ワークフローの UI 強化

- [x] **完了**

**概要**

知識汚染を防ぐため、`draft` から `active` への昇格は人間が確認する前提にする。現状 UI は knowledge を確認できるが、定期レビュー、一括承認/否認、根拠確認を効率化する余地がある。

**現行確認**

- Knowledge UI は `web/src/pages/KnowledgePage.tsx` ではなく `web/src/modules/admin/components/knowledge.page.tsx`
- admin API client は `web/src/modules/admin/repositories/admin.repository.ts`
- API route は `api/modules/knowledge/knowledge.routes.ts`
- `draft` が溜まり続ける状態は Doctor / Overview で見える余地がある

**影響範囲**

- draft knowledge が溜まり、active knowledge への反映が遅れる
- 根拠確認に手間がかかると、HITL が形骸化する
- batch 承認がないと distillation の運用コストが高い

**具体的タスク**

1. Knowledge UI に bulk selection を追加する
   - checkbox column
   - selected count
   - `Activate selected`
   - `Deprecate selected`
   - destructive / irreversible に見える操作は confirmation を出す
2. API に bulk status update を追加する
   - `POST /api/knowledge/bulk-status` などの専用 route を追加する
   - input は `{ ids: string[]; status: "active" | "deprecated" }`
   - id が存在しない場合、一部成功/全失敗の扱いを明確にする
3. 根拠確認をリスト上で行えるようにする
   - expandable row または side panel
   - source refs / source fragments / originating vibe memory を 1 click 以内で確認
   - generated knowledge と evidence の差分を見やすくする
4. Doctor / Overview と連動する
   - draft count
   - oldest draft age
   - source/vibe distillation の未レビュー数
   - threshold 超過時に warning を表示
5. test を追加する
   - API bulk status update の unit/integration test
   - UI は最低限 smoke または component-level で selection state を守る

**受け入れ条件**

- UI 上で複数 knowledge の status を一括変更できる
- bulk API が validation と partial failure を扱う
- 根拠へのアクセスが list から 1 click 以内
- draft backlog が Doctor / Overview で見える
- `bun run verify` が通る

**関連ファイル**

- [knowledge.page.tsx](../web/src/modules/admin/components/knowledge.page.tsx)
- [overview.page.tsx](../web/src/modules/admin/components/overview.page.tsx)
- [admin.repository.ts](../web/src/modules/admin/repositories/admin.repository.ts)
- [knowledge.routes.ts](../api/modules/knowledge/knowledge.routes.ts)
- [knowledge.repository.ts](../api/modules/knowledge/knowledge.repository.ts)
- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)

---

## Low Priority

> サーバーホスト段階やスケール時に対処すればよい Issue。ローカル運用では実害が小さいものを含む。

### Issue #9: 旧 `relations` テーブルの削除

- [x] **完了**

**概要**

Graph relation view は `same_session` / `same_project` を API 側で動的合成する方針になった。旧 `relations` テーブルは Graph、distillation、`context_compile` のいずれからも参照されないため、メンテナンス対象から外す。

**現行確認**

- 旧 relations table は削除済み
- Graph relation は永続 relation table ではなく、API 側の動的 edge として扱う
- 旧 table を前提にしたコードはメンテナンス対象外

**影響範囲**

- 完了済みのため追加影響なし
- 今後 relation 永続化を復活させる場合は、新規設計として扱う

**具体的タスク**

1. 追加タスクなし
2. 今後 `relations` という名称を再導入する場合は、旧 table の復活ではなく新規 issue として設計する

**受け入れ条件**

- `relations` table を前提にした現役コードがない
- Graph relation view は `same_session` / `same_project` の動的 edge として説明される

**関連ファイル**

- [schema.ts](../src/db/schema.ts)
- [graph.repository.ts](../api/modules/graph/graph.repository.ts)
- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)

---

### Issue #10: Web UI のテストカバレッジ不足

- [x] **完了**

**概要**

Web UI のテストは薄く、Playwright config はあるが主要導線の E2E シナリオが不足している。ただし memory-router はローカルツールであり、開発者が日常的に UI を目視確認できるため優先度は Low とする。

**現行確認**

- `web/src/smoke.test.ts` は存在する
- `test:e2e` は `playwright test`
- `verify` には Playwright は含まれていない
- UI は admin module と context-compiler module に分かれている

**影響範囲**

- UI component の regression に気付けない
- API 連携の破損が UI 側で検知されない
- bulk HITL のような UI 変更では手動確認に依存する

**具体的タスク**

1. Playwright で最低限シナリオを作成する
   - `/` top page が表示される
   - Doctor / Overview が表示される
   - Knowledge 一覧が表示される
   - Sources explorer で folder/page structure が表示される
   - Context Compile の form が表示され、validation error を出せる
2. API 依存を減らす
   - 可能なら mock response で UI state を確認する
   - DB 連携まで見る場合は integration/e2e として分ける
3. dev server 起動を安定化する
   - Playwright の webServer 設定を使う
   - port conflict 時の扱いを決める
4. `verify` に入れるかは別判断にする
   - local e2e が重い場合は `test:e2e` のまま残す
   - UI 変更時だけ focused e2e を実行する運用でもよい

**受け入れ条件**

- 主要 UI 導線の Playwright test が存在する
- `bun run test:e2e` で実行可能
- UI 変更時に最低限の regression を確認できる

**関連ファイル**

- [playwright.config.ts](../playwright.config.ts)
- [web/src/App.tsx](../web/src/App.tsx)
- [web/src/modules/admin/components/](../web/src/modules/admin/components/)
- [web/src/modules/context-compiler/components/context-compiler.page.tsx](../web/src/modules/context-compiler/components/context-compiler.page.tsx)
- [web/src/smoke.test.ts](../web/src/smoke.test.ts)
- [tests/e2e/](../tests/e2e/)

---

### Issue #11: Distillation の SSRF 対策不在

- [x] **完了**

> [!NOTE]
> **ローカルファースト方針により優先度を Low に設定。** ただし LLM が生成した URL を `fetch_content` が取得するため、ローカル環境でも `localhost` や private network への意図しないアクセスは起こり得る。サーバーホスティング前に必ず対処し、ローカルでも低コストな denylist は入れてよい。

**概要**

`distillation-tools.service.ts` は `fetch_content` tool を提供しているが、LLM が生成した URL に対する SSRF 防御が不足している。`http://localhost:*`、`http://127.0.0.1:*`、`http://169.254.169.254/`、private IP、redirect 経由の private IP 到達を拒否する必要がある。

**現行確認**

- `fetch_content` は distillation runtime から tool call として呼ばれる
- timeout と result truncation はある
- URL safety validation は専用実装としては未整備

**影響範囲**

- ローカル LLM が意図しない URL を生成した場合に、ローカルサービスへ到達する可能性
- サーバーホスト時には cloud metadata endpoint や internal network へのアクセスリスクがある
- redirect を使った allowlist/denylist bypass のリスクがある

**具体的タスク**

1. URL 検証関数を作成する
   ```typescript
   type UrlSafetyResult = { safe: true } | { safe: false; reason: string };
   function validateFetchContentUrl(input: string): UrlSafetyResult { ... }
   ```
2. 拒否対象を定義する
   - protocol が `http:` / `https:` 以外
   - `localhost` / `.localhost`
   - `127.0.0.0/8`
   - `::1`
   - private IPv4 `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
   - link-local `169.254.0.0/16`
   - metadata endpoint `169.254.169.254`
   - IPv6 unique local / link-local
3. redirect を手動で扱う
   - `redirect: "manual"`
   - `Location` を解決して再検証
   - redirect 回数上限を設ける
4. DNS 解決後の IP 検証を検討する
   - hostname が public に見えても private IP へ解決されるケースを防ぐ
   - ローカル実装ではまず hostname/ip literal deny から始め、サーバーホスト前に DNS rebind 対策を追加する
5. evidence と test を追加する
   - block reason を `source_distillation_evidence` に残す
   - localhost/private/metadata/redirect の unit test を追加する

**受け入れ条件**

- private IP / localhost / metadata endpoint への fetch が拒否される
- redirect 経由の private endpoint 到達が拒否される
- block reason が記録される
- `bun run test:unit` に SSRF 防御テストが含まれる

**関連ファイル**

- [distillation-tools.service.ts](../src/modules/distillation/distillation-tools.service.ts)
- [distillation-runtime.service.ts](../src/modules/distillation/distillation-runtime.service.ts)
- [source_distillation_evidence table](../src/db/schema.ts)
- [context-compile-mcp-improvement-plan.md](./context-compile-mcp-improvement-plan.md) — Phase 6

---

### Issue #15: Agent DX のリカバリ支援強化

- [x] **完了**

**概要**

現状でも `degradedReasons` と `suggested_next_calls` により Agent DX はあるが、エージェントが直面する具体的なエラー、例えば typecheck failure、test failure、compile failure に対して、どの tool を呼び、どの知識を探すべきかをより具体的に返せる余地がある。

**現行確認**

- MCP tool file は `src/mcp/tools/context-compile.tool.ts`
- tool 名は `context_compile`, `memory_search`, `memory_fetch`, `search_knowledge`, `doctor` が現行の主導線
- `record_vibe_memory` は現行 tool surface としては使わない。必要なら別途 tool 復活または ingestion command の設計が必要
- `compileContextPack()` は既に degraded reason に応じて `suggested_next_calls` を返す

**影響範囲**

- エージェントが degraded / failed 状態から回復するまでの試行錯誤が減る
- error-specific な過去 procedure / rule を拾いやすくなる
- suggestion が強すぎると、存在しない tool や不要な web search を誘導するリスクがある

**具体的タスク**

1. `context_compile` input schema を拡張する
   - `lastErrorContext` を追加する
   - `errorKind` を optional enum にする。例: `typecheck`, `lint`, `test`, `runtime`, `build`, `unknown`
   - stack trace / command output をそのまま保存しすぎないよう max length を設ける
2. ranking boost を追加する
   - `lastErrorContext` がある場合、`procedure` と `rule` を優先する
   - title/body/sourceRefs に error keyword が一致する knowledge を boost する
   - file path が一致する knowledge を boost する
   - boost は通常 compile の ranking を破壊しない範囲に抑える
3. suggested next calls を具体化する
   - `NO_ACTIVE_KNOWLEDGE_MATCH` なら `memory_search` / `search_knowledge` を提案
   - repo scope fallback なら `context_compile (retry with explicit repoPath/files)` を提案
   - embedding unavailable なら `doctor` を提案
   - source 不足なら `import:markdown` / `import:sources` / `distill:sources` のような repo-native command を提案
   - 存在しない tool 名を suggestion に出さない
4. MCP contract test を更新する
   - input schema に `lastErrorContext` が出ること
   - degraded response に existing tool/command だけが出ること
   - error context による boost が deterministic に働くこと

**受け入れ条件**

- `context_compile` へ error context を渡せる
- error context に関連する `procedure` / `rule` が boost される
- `suggested_next_calls` に存在しない tool 名が出ない
- MCP contract test が更新される
- `bun run verify` が通る

**関連ファイル**

- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts)
- [ranking.service.ts](../src/modules/context-compiler/ranking.service.ts)
- [context-compile.tool.ts](../src/mcp/tools/context-compile.tool.ts)
- [system.tool.ts](../src/mcp/tools/system.tool.ts)
- [mcp.contract.test.ts](../test/mcp.contract.test.ts)
- [mcp.tools.test.ts](../test/mcp.tools.test.ts)

---

## 既存改善計画との対応

以下の Issue は [context-compile-mcp-improvement-plan.md](./context-compile-mcp-improvement-plan.md) の Phase と連携する。現行コードとの差分を反映し、完了済みまたは設計不足のものはその状態を明記する。

| Issue | 優先度 | 対応 Phase | 状態 | 備考 |
|---|---|---|---|---|
| #1 repo scope / appliesTo / index | **High** | Phase 1 | 完了 | `appliesTo` 主経路化、legacy fallback の段階実行、index/migration、回帰テストを反映 |
| #2 型キャスト | **High** | - | 完了 | `KnowledgeRankable` 導入で `context-compiler.service.ts` の unsafe cast を除去 |
| #3 estimateTokens | **High** | - | 完了 | CJK を考慮した推定 + token-aware truncation へ置換済み |
| #4 検索ロジック重複 | **High** | Phase 1 / 3 | 完了 | `executeKnowledgeSearch()` へ text/vector merge と fallback を集約済み |
| #5 weightedScore 再計算 | Medium | Phase 1 | 完了 | 現行 `rankAndDedupe()` は `{ item, weighted }` を保持済み |
| #6 config 構造 | Medium | - | 完了 | `groupedConfig` + flat alias 互換で段階移行し verify 通過 |
| #7 doctor 分割 | Medium | Phase 4 | 完了 | inspector 分割 + orchestration 化で response shape 互換を維持 |
| #8 API テスト | Medium | - | 完了 | `test:unit:api` と `api.routes` 契約テストを追加し verify/integration に接続済み |
| #9 旧 relations 削除 | Low | - | 完了 | Graph relation は動的合成に統一 |
| #10 Web UI テスト | Low | Phase 4 | 未着手 | ローカル運用では後回し可 |
| #11 SSRF 対策 | Low | Phase 6 | 未着手 | ローカルでも localhost/private deny は有効 |
| #12 latency / semantic cache | Medium | Phase 5 | 設計不足 | cache 実装前に duration 計測と invalidation 設計が必要 |
| #13 コールドスタート対策 | Medium | - | 完了 | `init:project` を追加し現行 CLI 構成で初回導線を実装 |
| #14 HITL UI 強化 | Medium | Phase 4 | 要パス修正済み | 対象は admin module の `knowledge.page.tsx` |
| #15 Agent DX リカバリ | Low | Phase 3 | 要 tool 名修正済み | `context-compile.tool.ts` と現行 tool surface に合わせる |

---

## 推奨実施順序

```text
1. Issue #14 (HITL UI 強化)           ← draft 運用が増える前に bulk review を追加
2. Issue #12 (latency/cache)          ← 実測と invalidation 設計後に実装
3. Issue #11 (SSRF)                   ← サーバーホスト前には必須。ローカル denylist は早めでも可
4. Issue #10 / #15                    ← UI 回帰や Agent DX の必要度に応じて段階的に実施
```

---

## 進捗サマリー

| 優先度 | 件数 | 完了 | 残り |
|---|---:|---:|---:|
| High | 4 | 4 | 0 |
| Medium | 7 | 7 | 0 |
| Low | 4 | 4 | 0 |
| **合計** | **15** | **15** | **0** |

---

## 実装前の注意

- `#1` は完了済み。新規実装では repo scope 判定の主経路に legacy fallback を再混在させない
- `#5` は完了済みなので、再実装しない
- `#13` は完了済み。初回導線を拡張する場合も memory-router の CLI 名と現行 file layout を維持し、`gnosis` や `src/cli/commands/*` を持ち込まない
- `#14` は current UI の admin module を触る。存在しない `web/src/pages/KnowledgePage.tsx` を前提にしない
- `#15` は存在する tool 名だけを suggestion に出す。`record_vibe_memory` を使うなら別途 tool surface の復活設計が必要
- `bun run verify` は `test:unit` の対象を明示列挙しているため、新しい unit test を追加したら `package.json` も更新する
