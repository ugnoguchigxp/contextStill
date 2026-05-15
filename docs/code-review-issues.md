# Code Review Issue 一覧 & タスクチェックリスト

> **作成日**: 2026-05-15  
> **ソース**: [project-value-assessment.md](./project-value-assessment.md) のコードレビュー結果  
> **対象**: memory-router v0.1.0

---

## 方針

memory-router は **ローカルファースト** のツールである。ナレッジや MD ファイルの共有は行うが、サーバーホスティングやパブリック公開は当面の対象外。この前提に基づき、以下の優先度で Issue を整理する。

**優先すべきもの:**
- ローカルでの compile / distillation / search の品質と信頼性
- 開発速度を支えるコード品質・型安全性
- 日常的に使う CLI / MCP の安定性

**後回しにするもの:**
- サーバーホスト前提のセキュリティ対策（SSRF 等）
- Web UI のテスト自動化（ローカル開発者が目視確認できる範囲）

---

## 使い方

- `[ ]` → 未着手
- `[x]` → 完了
- 各 Issue には **概要**、**影響範囲**、**具体的タスク**、**受け入れ条件**、**関連ファイル** を記載
- 優先度は High / Medium / Low の 3 段階

---

## High Priority

> ローカル運用の compile / distillation 品質に直結する Issue。

### Issue #1: `metadata` JSONB への検索依存

- [ ] **完了**

**概要**

`knowledge_items.metadata` の JSONB カラムに `repoPath`, `repoKey`, `sourceUri` など検索に使うフィールドが格納されているが、DB レベルの制約やインデックスがなく、repo scope フィルタの信頼性が低い。`appliesTo` カラムは存在するが、活用が不十分。

**影響範囲**

- `context_compile` 実行時に別リポジトリ由来の draft knowledge が混入する可能性がある
- `search_knowledge` の repo scope フィルタリングが JSONB 演算子（`->>` ）に依存しており、パフォーマンスとクエリ計画の最適化が困難

**具体的タスク**

1. `knowledge_items.appliesTo` の利用方針を確定する
   - `repoPath`, `repoKey` を必ず `appliesTo` に正規化して格納するルールを徹底
   - `buildKnowledgeScopeMetadata()` 内で `appliesTo` への書き込みを保証する
2. `knowledge.repository.ts` の `buildRepoScopedCondition()` を修正
   - 第一条件として `appliesTo ->> 'repoKey'` を使い、`metadata` のフォールバック検索は補助に下げる
   - `metadata ->> 'sourceProject'`, `metadata ->> 'sourceDocumentUri'` 等の冗長な OR 句を整理
3. 既存データのマイグレーションスクリプトを作成
   - `metadata` に `repoKey` が入っているが `appliesTo` に未反映のレコードを一括更新
4. integration test に「別リポ知識が混入しないこと」の回帰テストを追加

**受け入れ条件**

- `context_compile` に `repoPath` を渡した場合、別リポ由来の draft knowledge が返らない
- `appliesTo` にインデックスが効くクエリ構造になっている
- `bun run test:integration` に repo scope の回帰テストが含まれる

**関連ファイル**

- [knowledge.repository.ts](../src/modules/knowledge/knowledge.repository.ts) — `buildRepoScopedCondition`, `buildKnowledgeScopeMetadata`
- [knowledge.service.ts](../src/modules/knowledge/knowledge.service.ts) — `retrieveKnowledge`
- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts) — `compileContextPack`
- [schema.ts](../src/db/schema.ts) — `knowledgeItems` テーブル定義
- [context-compile-mcp-improvement-plan.md](./context-compile-mcp-improvement-plan.md) — Phase 1

---

### Issue #2: `context-compiler.service.ts` の型キャスト

- [ ] **完了**

**概要**

`compileContextPack()` 内で `(item as { type: string }).type` のようなキャストが 6 箇所以上存在する。`rankAndDedupe` が返す `Rankable` 型に `type`, `status`, `sourceRefs` が含まれていないため、呼び出し側で毎回キャストが必要になっている。

**影響範囲**

- 型安全性の低下（キャスト先の型と実際の値がズレても TypeScript が検出できない）
- メンテナンス時にキャスト箇所の見落としリスク

**具体的タスク**

1. `ranking.service.ts` の `Rankable` 型を拡張する
   ```typescript
   type Rankable = {
     id: string;
     title: string;
     content: string;
     score: number;
     confidence?: number;
     importance?: number;
     type: string;        // 追加
     status: string;      // 追加
     sourceRefs: string[]; // 追加
     hasSourceLinks?: boolean;
     sourceRefCount?: number;
     stale?: boolean;
   };
   ```
2. `context-compiler.service.ts` の L267-278 のキャストを全て除去
3. `toKnowledgePackItem` の引数型を `Rankable` から直接導出するように変更
4. `typecheck` が通ることを確認

**受け入れ条件**

- `context-compiler.service.ts` に `as {` パターンのキャストが 0 件
- `bun run typecheck` が成功

**関連ファイル**

- [ranking.service.ts](../src/modules/context-compiler/ranking.service.ts) — `Rankable` 型定義
- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts) — L267-318

---

### Issue #3: `estimateTokens` の精度

- [ ] **完了**

**概要**

`context-compiler.service.ts` の `estimateTokens()` が `Math.ceil(text.length / 4)` という固定ヒューリスティックを使用している。英語テキストではおおよそ妥当だが、日本語テキストはトークン効率が異なり（1 文字 ≈ 1-2 トークン）、実際の消費トークン数を過小評価する。

**影響範囲**

- 日本語 knowledge を多く含むコンパイル結果が token budget を超過し、エージェントのコンテキストウィンドウを圧迫する
- section ratio による配分（rules: 45%, procedures: 35%）が意図通りに機能しない
- ローカルで毎回使う context_compile の品質に直結する問題

**具体的タスク**

1. `estimateTokens()` を改良する
   - ASCII 文字は `/4`、日本語文字（CJK Unified Ideographs + ひらがな + カタカナ）は `/1.5` の加重平均を取る簡易実装
   - もしくは `gpt-tokenizer` のような軽量ライブラリの採用を検討
2. `truncateForBudget()` を同じ推定式で更新
3. 日本語テキストの token 推定精度を検証する unit test を追加
   - 英語、日本語、混在テキストの 3 パターン
4. 既存の `context-compiler.test.ts` に予算超過シナリオのテストを追加

**受け入れ条件**

- 日本語テキスト（500 文字程度）のトークン推定誤差が ±20% 以内
- `bun run test:unit` で推定精度テストが通る

**関連ファイル**

- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts) — `estimateTokens`, `truncateForBudget`

---

### Issue #4: `retrieveKnowledge` と `searchKnowledgeCandidates` のコード重複

- [ ] **完了**

**概要**

`knowledge.service.ts` の `retrieveKnowledge()`（L58-228, 170行）と `searchKnowledgeCandidates()`（L230-400, 170行）がほぼ同一の検索ロジックを持っている。`runSearch` 内部関数、`mergeHits` 関数、repo scope fallback の処理が完全に重複している。

**影響範囲**

- DRY 違反。一方を修正した時にもう一方の修正漏れが発生するリスク
- Issue #1 の repo scope 修正を行う際に、2 箇所を同時に直す必要があり、修正漏れが起きやすい
- `context_compile` と `search_knowledge` で検索品質の乖離が起きる可能性

**具体的タスク**

1. 共通の internal search builder を抽出する
   ```typescript
   type InternalSearchParams = {
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
   };
   
   async function executeKnowledgeSearch(
     params: InternalSearchParams
   ): Promise<KnowledgeRetrievalResult> { ... }
   ```
2. `retrieveKnowledge` と `searchKnowledgeCandidates` を上記の wrapper として再実装
3. 既存テストが全て通ることを確認
4. 差分がある場合は意図的な分岐だけを明示的にドキュメント化

**受け入れ条件**

- `runSearch` / `mergeHits` / repo scope fallback のロジックが 1 箇所に集約
- `bun run verify` が通る
- 既存の integration test がそのまま通る

**関連ファイル**

- [knowledge.service.ts](../src/modules/knowledge/knowledge.service.ts) — L58-400

---

## Medium Priority

> コード品質・メンテナンス性の改善。日常開発の生産性に寄与する。

### Issue #5: `weightedScore` の再計算コスト

- [ ] **完了**

**概要**

`ranking.service.ts` の `rankAndDedupe()` 内で `weightedScore()` がソート中の比較関数で毎回呼ばれる。JavaScript の sort は O(n log n) 比較を行うため、n 件のアイテムに対して `weightedScore` が最大 O(n log n) 回呼ばれる。現在の候補数（10-15 件）では問題にならないが、将来的に候補数が増えた場合のボトルネック。

**影響範囲**

- 現時点では実害なし
- 候補数が 100+ になった場合にソート性能が劣化

**具体的タスク**

1. ソート前に全候補の `weightedScore` を一括計算して Map に保存
2. ソート比較関数では Map から取得するように変更
   ```typescript
   const scoreMap = new Map(deduped.map(item => [item.id, weightedScore(item)]));
   return [...deduped.values()]
     .sort((a, b) => {
       const scoreDelta = (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0);
       // ...
     })
     .slice(0, limit);
   ```
3. 既存の unit test が通ることを確認

**受け入れ条件**

- `weightedScore` の呼び出し回数が O(n) に削減
- 既存テストが通る

**関連ファイル**

- [ranking.service.ts](../src/modules/context-compiler/ranking.service.ts)

---

### Issue #6: `config.ts` のフラット構造

- [ ] **完了**

**概要**

`config.ts` は 180 行のフラット構造で 40+ の設定項目が並列に定義されている。設定項目の増加に伴い、可読性と保守性が低下する懸念がある。

**影響範囲**

- 新しい設定項目の追加時に、既存設定との命名衝突や見通しの悪さ
- 特定モジュール（embedding, distillation 等）の設定変更時に関係ない設定も視界に入る

**具体的タスク**

1. namespace 別のグルーピングに再構成
   ```typescript
   export const config = {
     database: { url, ... },
     embedding: { provider, daemonUrl, dimension, ... },
     vibeDistillation: { promptVersion, batchSize, maxInputChars, ... },
     sourceDistillation: { promptVersion, batchSize, ... },
     agentLogSync: { interval, initialLookback, ... },
     doctor: { freshnessThreshold, degradedRateThreshold },
     compile: { defaultTokenBudget, enableVectorSearch },
   };
   ```
2. 既存の `config.xxx` 参照を `config.namespace.xxx` に一括置換
3. 後方互換のために旧パスのアクセスもしばらく残すか判断

**受け入れ条件**

- 設定項目がカテゴリ別にグルーピングされている
- `bun run verify` が通る

**関連ファイル**

- [config.ts](../src/config.ts)
- 全モジュールの `config.*` 参照箇所

---

### Issue #7: `doctor.service.ts` の単一ファイル肥大化

- [ ] **完了**

**概要**

`doctor.service.ts` が 644 行の単一ファイルに、DB 診断、vector 診断、embedding 診断、LaunchAgent 診断、compile run 分析、MCP surface 診断、agent-log-sync 診断、vibe/source distillation 診断を全て含んでいる。新しい診断項目の追加が困難。

**影響範囲**

- 新しい診断（例: wiki Git 整合性チェック）を追加する際の変更範囲が大きい
- テストの粒度が粗くなる

**具体的タスク**

1. セクション別のインスペクタファイルに分割
   ```
   src/modules/doctor/
   ├── doctor.service.ts          # runDoctor() の集約のみ
   ├── inspectors/
   │   ├── db.inspector.ts        # DB + vector + tables
   │   ├── embedding.inspector.ts # embedding health
   │   ├── mcp.inspector.ts       # MCP surface
   │   ├── compile.inspector.ts   # compile run health
   │   ├── agent-sync.inspector.ts
   │   ├── vibe-distillation.inspector.ts
   │   └── source-distillation.inspector.ts
   └── launch-agent.util.ts       # LaunchAgent 共通ユーティリティ
   ```
2. 各インスペクタは独立して unit test 可能にする
3. `runDoctor()` は各インスペクタの結果を集約するだけのオーケストレータにする

**受け入れ条件**

- `doctor.service.ts` が 100 行以内のオーケストレータに縮小
- 既存の doctor テスト（あれば）が通る
- `bun run verify` が通る

**関連ファイル**

- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)

---

### Issue #8: API ルートのテスト不在

- [ ] **完了**

**概要**

`api/` ディレクトリ配下に Hono ベースの API ハンドラが存在するが、対応する unit test / integration test が見当たらない。API の入出力契約が壊れても検知できない。

**影響範囲**

- API のリクエスト/レスポンス形式の変更が無検知で通る
- Web UI と API の間の契約崩壊リスク

**具体的タスク**

1. `test/api/` ディレクトリを作成
2. 最低限以下のエンドポイントの unit test を作成
   - `POST /api/context/compile` — 入力バリデーション + レスポンス shape
   - `GET /api/doctor` — ヘルスレポートの構造
   - `GET/POST /api/knowledge` — CRUD の基本契約
   - `POST /api/vibe-memory` — diff 分離の動作確認
3. Hono の `app.request()` を使ったテストパターンを確立
   - DB を使う場合は integration test として分離
   - DB 不要なバリデーションテストは unit test として実行
4. `package.json` の `test:unit` にAPI テストファイルを追加

**受け入れ条件**

- 主要 4 エンドポイントの入出力契約テストが存在
- `bun run verify` のゲートに含まれる

**関連ファイル**

- [api/app.ts](../api/app.ts)
- [api/modules/](../api/modules/)

---

### Issue #12: コンパイル・レイテンシの最適化（セマンティックキャッシュの導入）

- [ ] **完了**

**概要**

現状、AIエージェントがコーディングのたびに `context_compile` を呼び出すため、この処理のレイテンシがエージェントの体感速度（思考サイクル）に直結する。Issue #5 で `weightedScore` の改善を挙げたが、より根本的に、類似する `intent` / `goal` に対するコンパイル結果をキャッシュする仕組みがない。

**影響範囲**

- エージェントのレスポンスタイムの遅延
- 短時間の間に似たようなコンパイル要求が連続した場合の無駄な計算リソース消費

**具体的タスク**

1. セマンティックキャッシュ層の設計と実装
   - 入力された `intent` や `goal` の Embedding を計算し、直近のキャッシュと比較
   - 閾値（例: コサイン類似度 0.95以上）を満たす類似リクエストがあれば、キャッシュしたコンテキストパックを返却
2. キャッシュの無効化（Invalidation）戦略の策定
   - 対象スコープ（repoKey等）内に新たな Active Knowledge が追加された場合にキャッシュをパージ
3. パフォーマンス指標の計測と Doctor への組み込み
   - `compile` の平均実行時間を記録し、`doctor.service.ts` のヘルスチェック項目に追加

**受け入れ条件**

- 類似リクエストに対してキャッシュがヒットし、レイテンシが数十ミリ秒以内に抑えられる
- Knowledge 更新時にキャッシュが正しく無効化される

**関連ファイル**

- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts)
- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)

---

### Issue #13: コールドスタート問題への対応（初期プリセットとインポート強化）

- [ ] **完了**

**概要**

導入直後の新規プロジェクトでは、`vibe_memories`（会話ログ）や `sources`（Wiki）が空であるため、Context Compiler が抽出する知識が存在せず、本来の価値を発揮しにくい「コールドスタート問題」が発生する。

**影響範囲**

- 新規ユーザー（開発者・エージェント）のオンボーディング時の体験低下
- プロジェクト初期フェーズにおけるエージェントのコード品質低下

**具体的タスク**

1. `scope: global` な標準知識プリセットの提供
   - 一般的な言語・フレームワーク（例: TypeScript, React, Next.js, Python）のベストプラクティスを定義したシードデータを用意
2. 初期セットアップCLIコマンドの実装
   - `gnosis init --preset=typescript-react` のようなコマンドで、初期知識を一括インポート（Active状態で登録）する機能
3. 既存ドキュメントのバルクインポート機能の強化
   - 既存の `import` コマンドを拡張し、ディレクトリ単位のMarkdown読み込みだけでなく、そこから自動的に初期知識の抽出（Distillation）をバッチ実行する機能を追加

**受け入れ条件**

- `init` コマンドにより数秒で基礎的なグローバル知識が投入される
- `import --distill` コマンドで既存の仕様書から初期知識ベースが構築できる

**関連ファイル**

- `src/cli/commands/init.ts` (新規作成)
- `src/cli/commands/import.ts`
- [distillation.service.ts](../src/modules/distillation/distillation.service.ts)

---

### Issue #14: Human-in-the-Loop (HITL) 運用ワークフローのUI強化

- [ ] **完了**

**概要**

知識汚染（ハルシネーションの混入）を防ぐため、`draft` から `active` への昇格は人間が行うべき（Human-in-the-Loop）。現状UIはこの機能を持つが、運用フローとして「定期的なレビューと一括承認/否認」を行うには効率が悪い。

**影響範囲**

- `draft` 知識が溜まり続け、レビューがボトルネックになる
- 人間のレビューコスト増加による、実運用からの離脱リスク

**具体的タスク**

1. Web UI における一括処理（Bulk Actions）の実装
   - 複数の `draft` アイテムを選択し、「Activeへ昇格」「Deprecatedへ降格」を1クリックで実行可能にする
2. 差分・根拠のインラインプレビュー機能
   - 知識アイテムをクリックせずとも、テーブルの行拡張（Expandable Row）で「元のVibe Memory / Source」と「生成された知識」の差分・根拠を素早く確認できるビューの追加
3. Doctor 連携によるアラート表示
   - `draft` が一定数（例: 20件）または一定期間未レビューの場合、UIダッシュボードにアラートを表示

**受け入れ条件**

- UI上で複数アイテムのステータス一括変更が可能
- 根拠（Source Evidence）へのアクセスがリスト上から1クリック以内で可能

**関連ファイル**

- [web/src/pages/KnowledgePage.tsx](../web/src/pages/KnowledgePage.tsx)
- `web/src/components/`

---

## Low Priority

> サーバーホスト段階やスケール時に対処すればよい Issue。ローカル運用では実害が小さい。

### Issue #9: 旧 `relations` テーブルの削除

- [x] **完了**

**概要**

Graph relation view は `same_session` / `same_project` を API 側で動的合成する方針になった。旧 `relations` テーブルは Graph、distillation、`context_compile` のいずれからも参照されないため、メンテナンス対象から外す。

**影響範囲**

- 旧テーブルを残すと Doctor、migration、schema、docs が実態とズレる
- Graph に見える relation edge が永続テーブル由来だと誤解される

**具体的タスク**

1. `src/db/schema.ts` から旧 `relations` テーブルと `relationTypeValues` を削除
2. Doctor と integration helper の required/truncate 対象から `relations` を削除
3. migration で既存 DB の `relations` テーブルを drop
4. README/docs の Graph relation 説明を、動的合成 edge として更新

**受け入れ条件**

- `rg "\brelations\b"` で現役コード参照が残らない
- Graph relation view は `same_session` / `same_project` の動的 edge として説明される

**関連ファイル**

- [schema.ts](../src/db/schema.ts)
- [graph.repository.ts](../api/modules/graph/graph.repository.ts)
- [doctor.service.ts](../src/modules/doctor/doctor.service.ts)

---

### Issue #10: Web UI のテストカバレッジ不足

- [ ] **完了**

**概要**

Web UI のテストは `web/src/smoke.test.ts`（159 bytes）のみ。Playwright config は存在するが、実質的な e2e シナリオが不足している。ただし、ローカルツールとして開発者自身が日常的に UI を目視確認しているため、当面の実害は限定的。

**影響範囲**

- UI コンポーネントの回帰に気付けない（ただしローカル開発者が目視確認可能）
- API 連携の破損が UI 側で検知されない

**具体的タスク**

1. Playwright で以下の最低限シナリオを作成
   - `/` トップページが表示される
   - Knowledge 一覧が表示される（テーブル描画）
   - Knowledge の作成 → 一覧に反映
   - Sources エクスプローラでフォルダ構造が表示される
   - Context Compile 実行結果が表示される
2. CI 用の minimal Playwright config を整備
   - headless モード
   - dev server の起動・停止を自動化
3. `package.json` の `test:e2e` が実際に動作することを確認

**受け入れ条件**

- 5 シナリオ以上の Playwright test が存在
- `bun run test:e2e` で実行可能

**関連ファイル**

- [playwright.config.ts](../playwright.config.ts)
- [web/src/](../web/src/)
- [tests/](../tests/) — e2e テスト格納先

---

### Issue #11: Distillation の SSRF 対策不在

- [ ] **完了**

> [!NOTE]
> **ローカルファースト方針により優先度を Low に設定。** 現状 memory-router はローカルマシンでのみ動作し、`fetch_content` はローカル LLM の蒸留時にのみ呼ばれる。サーバーホスティング段階に移行する前に対処すれば十分。

**概要**

蒸留パイプラインの `distillation-tools.service.ts` が `fetch_content` ツールを提供しているが、LLM が生成した URL に対して SSRF（Server-Side Request Forgery）防御がない。LLM が `http://169.254.169.254/` や `http://localhost:*` 等にアクセスを指示した場合、内部ネットワークへの不正アクセスが発生しうる。

**影響範囲（ローカル環境では限定的）**

- ローカル LLM が意図しない URL を生成した場合に、ローカルサービスに到達する可能性
- サーバーホスト時にはクラウドメタデータへのアクセスリスクがある（将来的課題）

**具体的タスク**

1. URL 検証関数を作成する
   ```typescript
   function isSafeUrl(url: string): { safe: boolean; reason?: string } {
     // 拒否: private IP (10.x, 172.16-31.x, 192.168.x)
     // 拒否: localhost, 127.0.0.0/8
     // 拒否: link-local (169.254.x)
     // 拒否: metadata endpoints (169.254.169.254)
     // 拒否: file://, ftp://, gopher://
     // 許可: http/https のみ、かつ public IP
   }
   ```
2. `distillation-tools.service.ts` の `fetch_content` ハンドラに URL 検証を追加
   - 初回 URL のチェック
   - redirect 後の URL も再検証（`fetch` の `redirect: 'manual'` + 手動フォロー）
3. SSRF をブロックした場合のログ出力（`source_distillation_evidence` に記録）
4. unit test でブロック対象 URL のテストを追加

**受け入れ条件**

- private IP / localhost / metadata endpoint への fetch が拒否される
- redirect 経由のバイパスも防止される
- `bun run test:unit` に SSRF 防御テストが含まれる

**関連ファイル**

- [distillation-tools.service.ts](../src/modules/distillation/distillation-tools.service.ts) — `fetch_content` 実装
- [context-compile-mcp-improvement-plan.md](./context-compile-mcp-improvement-plan.md) — Phase 6

---

### Issue #15: Agent DX のさらなる強化（自己修復・自律的リカバリの拡張）

- [ ] **完了**

**概要**

現状でも `degradedReasons` と `suggested_next_calls` により Agent DX は高いが、さらに一歩進めて、エージェントが直面する具体的なエラー（コンパイルエラー、テスト失敗）に対して「どう検索すれば解決策となる知識が引き出せるか」をシステム側が能動的にガイドする機能を追加する。

**影響範囲**

- エージェントの自律的なタスク遂行能力の向上
- コンテキスト不足による試行錯誤ループ（無限ループ）の削減

**具体的タスク**

1. `context_compile` の入力スキーマ拡張
   - `lastErrorContext`（直近のエラーメッセージやスタックトレース）を受け取れるように拡張
2. リカバリ専用の Retrieval Mode の追加
   - エラーコンテキストが与えられた場合、関連する過去の `procedure`（トラブルシューティング手順）や `rule`（アンチパターン）を優先的にスコアリングするロジックの実装
3. 次のアクション提案の高度化
   - 知識が不足している場合、単なる検索提案だけでなく「このエラーに関する知識がないため、`search_web` ツールで一般解を検索し、その結果を `record_vibe_memory` に残してください」という具体的なプロンプトレベルの行動指示を返す

**受け入れ条件**

- `context_compile` へのエラー入力時、解決に関連する知識のスコアがブーストされる
- `suggested_next_calls` がエージェントの具体的な行動指示を含む

**関連ファイル**

- [context-compiler.service.ts](../src/modules/context-compiler/context-compiler.service.ts)
- [ranking.service.ts](../src/modules/context-compiler/ranking.service.ts)
- [context_compile.tool.ts](../src/mcp/tools/context_compile.tool.ts)

---

## 既存改善計画との対応

以下の Issue は [context-compile-mcp-improvement-plan.md](./context-compile-mcp-improvement-plan.md) の Phase と連携する。

| Issue | 優先度 | 対応 Phase | 備考 |
|---|---|---|---|
| #1 metadata JSONB 依存 | **High** | Phase 1 | compile 品質の根幹。最優先 |
| #2 型キャスト | **High** | - | 独立して即着手可能。#1 修正前に片付けると安全 |
| #3 estimateTokens 精度 | **High** | - | 日本語環境で毎回影響。独立して実施可能 |
| #4 検索ロジック重複 | **High** | Phase 1 / 3 | #1 と同時に統合すると効率的 |
| #5 weightedScore 再計算 | Medium | Phase 1 | ranking 修正と同時に対処 |
| #6 config 構造 | Medium | - | リファクタリング機会にいつでも |
| #7 doctor 分割 | Medium | Phase 4 | doctor 機能拡張と同時に実施 |
| #8 API テスト | Medium | - | API 変更時にセットで追加 |
| #9 旧 relations 削除 | Low | - | 完了。Graph relation は動的合成に統一 |
| #10 Web UI テスト | Low | Phase 4 | ローカル運用では後回し可 |
| #11 SSRF 対策 | Low | Phase 6 | サーバーホスト段階で対処 |
| #12 セマンティックキャッシュ | Medium | Phase 5 | レイテンシ改善・将来のパフォーマンス要件 |
| #13 コールドスタート対策 | Medium | - | 新規導入時の UX 向上 |
| #14 HITL ワークフロー UI 強化 | Medium | Phase 4 | UI 改善・運用負荷の低減 |
| #15 Agent DX のさらなる強化 | Low | Phase 3 | エージェントの自律性向上・リカバリ機能強化 |

---

## 推奨実施順序

```
1. Issue #2 (型キャスト)          ← すぐ終わる。安全ネットを先に張る
2. Issue #3 (estimateTokens)      ← 日本語 compile 品質の即効改善
3. Issue #4 (検索ロジック統合)    ← #1 の前提。重複を先に潰す
4. Issue #1 (metadata/repo scope) ← Phase 1 本体。compile 信頼性の中核
5. Issue #5 (weightedScore)       ← #1 と同時に ranking 改善
6. Issue #6 (config 構造)         ← リファクタリングの気分転換に
7. Issue #7 (doctor 分割)         ← 診断拡張前に
8. Issue #8 (API テスト)          ← API 変更時に
9. Issue #13 (コールドスタート)   ← ユーザー導入促進のため早めに
10. Issue #14 (HITL UI 強化)      ← 運用が本格化する前に
11. Issue #12 (キャッシュ導入)    ← 呼び出し頻度が増大したタイミングで
12. Issue #10-11, 15              ← 必要になった時、または段階的に
```

---

## 進捗サマリー

| 優先度 | 件数 | 完了 | 残り |
|---|---|---|---|
| High | 4 | 0 | 4 |
| Medium | 7 | 0 | 7 |
| Low | 4 | 1 | 3 |
| **合計** | **15** | **1** | **14** |
