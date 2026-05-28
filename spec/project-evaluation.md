# memory-router プロジェクト 多角的価値評価レポート

> 評価日: 2026-05-26
> 対象: memory-router v0.1.0

---

## 総合評価サマリー

| 評価軸 | スコア | 判定 |
|---|:---:|---|
| **技術的独自性** | **88/100** | ★★★★☆ 市場に類似品がなく、独自の問題定義と解法を持つ |
| **アーキテクチャ品質** | **82/100** | ★★★★☆ モジュール分離・型安全性・テスト体制が高水準 |
| **市場ポジション** | **75/100** | ★★★☆☆ ニッチだが的確。認知度と導入障壁に課題 |
| **将来性・拡張性** | **80/100** | ★★★★☆ ロードマップが具体的で、拡張の余地が大きい |
| **リスク・課題** | **70/100** | ★★★☆☆ 個人プロジェクトとしての持続性、導入コスト |
| **総合** | **79/100** | ★★★★☆ **高い技術的価値を持つ独自プロジェクト** |

---

## 1. 技術的独自性（88/100）

### 1.1 コアコンセプト: Context Compiler

memory-router の最大の独自性は、**知識を「コンパイル」するという概念**にある。従来の RAG（Retrieval-Augmented Generation）が「検索して貼り付ける」のに対し、memory-router は以下のプロセスで知識を構造化する：

```
Raw Evidence → 蒸留（LLM + Value Gate） → Structured Knowledge → Context Compile → Optimized Pack
```

具体的な実装:

- `src/modules/context-compiler/` — ハイブリッド検索（全文 + ベクトル）、重み付きスコアリング、トークンバジェット配分
- `src/modules/knowledge/` — `rule` / `procedure` の型分離、`draft → active → deprecated` ライフサイクル
- リトリーバルモードの自動解決（`changeTypes` + goal キーワードから最適なモードを選択）

> **重要**: 「コンテキストコンパイラ」という概念は、現時点で市場にほぼ存在しない。RAG は「検索」、CLAUDE.md は「静的ファイル」、mem0 は「メモリストア」であり、**知識のビルドシステム**という位置づけは memory-router 独自のもの。

### 1.2 Staged Distillation Pipeline

4段階の蒸留パイプラインは、単純な LLM 抽出を超えた設計:

| ステージ | 処理 | 独自性 |
|---|---|---|
| `findCandidate` | raw evidence から最小候補を抽出 | Value Gate（importance > 50）による品質フィルタ |
| `coverEvidence` | source support、duplicate 検出、外部主張の検証 | `search_web` / `fetch_content` による外部エビデンス取得 |
| `premiumCovering` | 高品質 provider による追加検証 | provider 階層化（local → azure-openai → bedrock） |
| `finalizeDistille` | 最終評価と knowledge 化 | approval gate、landscape manual approval enforcement |

#### findCandidate（候補抽出）
- ファイル: `src/modules/findCandidate/domain.ts`
- LLM を使ってソースドキュメントから knowledge 候補（rule / procedure）を抽出
- `search_web` / `fetch_content` ツールを利用して外部エビデンスも収集可能
- 抽出された候補は `find_candidate_results` テーブルに保存

#### coverEvidence（エビデンス被覆検証）
- ファイル: `src/modules/coverEvidence/domain.ts` (470行)
- 3段階の検証プロセス:
  1. **Source Support 検証** (`source-support.service.ts`): トークンベースの重なり分析。日本語(CJK)とASCIIの混在テキストに対応した独自トークナイザー
  2. **重複検出** (`dedupe.service.ts`): 既存 knowledge との重複・近似重複を検出
  3. **外部エビデンス検証** (`llm-runner.ts`): `search_web` で一次ソースURLを発見し、`fetch_content` で実際のコンテンツを取得して検証

#### finalizeDistille（最終承認ゲート）
- ファイル: `src/modules/finalizeDistille/domain.ts`
- 多層の品質ゲート:
  - `importance > 50` の閾値チェック
  - Procedure 品質検証 (`procedure-quality.ts`): Skill-like procedure body（Use when / Workflow / Verification / Avoid の4セクション構成）の構造検証
  - Procedure → Rule 自動降格: procedure として不十分な場合、rule として保存可能か再評価
  - **Landscape Manual Approval Gate**: Landscape review item から生成された候補は、`approved` ステータスがないと finalize を拒否

### 1.3 Knowledge Landscape & Graph

運用診断としての Knowledge Landscape は、知識管理ツールとしてユニーク:

- **Community 分析**: attractor / dead-zone / stale / over-selected の自動検出
- **Replay Comparison**: 過去の retrieval baseline との drift 検出
- **Review Item → Candidate Draft**: 診断結果から deterministic に改善候補を生成
- **Approval Link**: review item → distillation target → candidate row のトレーサビリティ

#### 理論的基盤
- Hopfield Network / Attractor メタファー: 知識を「保存されたテキスト」ではなく「タスク状態を特定の判断・手順へ収束させる地形」として扱う
- 実装は数学的 EBM ではなく、DB 上の観測データから派生する read-only 分析レイヤー

#### コミュニティベーススコアリング（7カテゴリ）
- ファイル: `src/modules/landscape/landscape.scoring.ts` (337行)
  1. `strong_attractor`: used率≥70% + 根拠密度≥0.6 + medium以上のfeedback信頼度
  2. `useful_attractor`: used率≥50% + off_topic/wrong=0
  3. `negative_attractor_candidate`: off_topic率≥40% または wrong>0
  4. `over_selected_not_used`: 未使用率≥60% + negative判定なし
  5. `dead_zone_reachability_risk`: active知識が未選出 + 到達性リスク≥0.3
  6. `dead_zone_stale`: 未選出 + 根拠密度<0.5 + 陳腐化度≥0.5
  7. `feedback_insufficient`: 選出はあるがfeedback件数不足

#### 矛盾検出（Contradiction Detection）
- ファイル: `src/modules/landscape/landscape-contradiction.service.ts` (496行)
- LLM不要の決定論的ヒューリスティック
- 日英バイリンガル対応のマーカー検出（require vs avoid の極性衝突）

### 1.4 Context Compilation の技術詳細

#### ハイブリッド検索 + 多要素ランキング
- ファイル: `src/modules/context-compiler/ranking.service.ts`
- ランキング重み: importance(0.2), confidence(0.1), dynamicBoost(0.12), sourceLinkBoost(0.05), errorKeywordBoostPerHit(0.03)
- deprecatedPenalty(0.5), stalePenalty(0.4)

#### Agentic Refine（LLM による知識選別）
- ファイル: `src/modules/context-compiler/agentic-refine.service.ts` (307行)
- **「勇気ある空配列」原則**: 確信が持てない場合は空配列を返す。有害な情報を渡すよりも、情報なしが賢い判断とする設計思想
- プロバイダフォールバック付き、graceful degradation

#### 重複抑制（Duplicate Suppression）
- ファイル: `src/modules/context-compiler/duplicate-suppression.service.ts` (207行)
- 3種類の重複検出: `same_normalized_title`, `title_body_overlap`, `shared_source_overlap`
- **極性反転検出** (`hasOppositePolarity`): "use/must/推奨" vs "avoid/never/禁止" のパターンで矛盾する知識を重複から除外

#### トークンバジェット管理
- CJK文字（0.8トークン）、ASCII（0.25トークン）、サロゲートペア（1トークン）の重み付き推定
- セクション別バジェット配分: rules → procedures → sources

### 1.5 Evidence / Instruction 分離

| 層 | 格納内容 | 役割 |
|---|---|---|
| Evidence 層 | `sources`, `vibe_memories`, `agent_diff_entries` | 生の事実・ログ |
| Knowledge 層 | `knowledge_items`, `knowledge_source_links` | 蒸留された指示・手順 |
| 処理層 | `distillation_target_states`, `context_compile_runs` | パイプライン状態 |

この分離は、一般的な RAG（evidence と instruction が混在）や CLAUDE.md（instruction のみ）にはない設計。

### 1.6 技術的独自性のまとめ

| 革新領域 | 従来アプローチ | memoryRouter のアプローチ |
|---|---|---|
| 知識管理 | RAG: 生テキスト検索 | 4段階蒸留パイプラインで構造化 rule/procedure に変換 |
| データモデル | evidence と instruction の混在 | 完全分離 + source link による追跡可能性 |
| 品質保証 | なし or 人手 | LLM + ヒューリスティック + 多層品質ゲート |
| コンテキスト選別 | similarity のみ | 多要素ランキング + LLM agentic refine + 重複抑制 |
| 知識の健全性 | なし | Landscape: attractor/dead-zone/contradiction のコミュニティベース分析 |
| ライフサイクル | なし | draft → active → deprecated + feedback loop + decay |
| 変更安全性 | 直接変更 | observe → explain → replay → rank の段階的導入 |
| 承認 | なし | Landscape → Review Item → Candidate Draft → Manual Approval → Finalize |

---

## 2. アーキテクチャ品質（82/100）

### 2.1 モジュール構成

26 個のドメインモジュールが `src/modules/` 以下に整理されている。各モジュールは以下のパターンに従う:

```
module/
├── *.service.ts      # ビジネスロジック
├── *.repository.ts   # データアクセス
├── *.types.ts        # 型定義
└── *.schema.ts       # Zod バリデーション
```

Service / Repository / Types / Schema の4層分離は、DDD に近い構成。モジュール間の依存が明示的で、リファクタリング耐性が高い。

### 2.2 データベーススキーマ品質 ★★★★★

- **8つのスキーマファイル**に論理的に分割: `schema-core.ts`, `schema-knowledge.ts`, `schema-distillation.ts`, `schema-context.ts`, `schema-landscape.ts`, `schema-sources.ts`, `schema-llm.ts`, `schema.constants.ts`
- **49個のマイグレーション**

優秀な設計パターン:

1. **CHECK制約の網羅的な適用**: 全enumカラムに `check()` 制約を設定
2. **JSONB型の構造チェック**: `jsonb_typeof()` でオブジェクト/配列型を強制
3. **インデックス設計**: 複合インデックス、部分インデックス、GINインデックス、HNSW（ベクトル検索）を効果的に使用
4. **外部キー制約とカスケード削除**: 全テーブルで適切に `onDelete: "cascade"` を設定
5. **`schema.constants.ts`** で204行にわたりenum値を `as const` 配列で一元管理

### 2.3 型安全性 ★★★★★

- `tsconfig.json`: `strict: true` 有効
- `src/shared/schemas/` に **17個のZodスキーマファイル**
- DB制約 ↔ Zodスキーマ ↔ TypeScript型が一貫
- `z.infer<>` による型導出でスキーマと型の乖離を防止

### 2.4 テスト体制 ★★★★★

| 種別 | ファイル数 | 特徴 |
|---|:---:|---|
| ユニットテスト | **151** | 主要モジュールを網羅 |
| 統合テスト | 含む | PostgreSQL + pgvector でのリアル DB テスト |
| E2E テスト | Playwright | UI フロー検証 |
| MCP コントラクトテスト | 含む | MCP プロトコル準拠を検証 |
| CI パイプライン | ✅ | GitHub Actions で verify + integration を自動実行 |

テストコード量: **約 32,900 行**（全体の約 27%）

### 2.5 API 設計 ★★★★

- REST API: `api/` — Hono フレームワーク、50+ エンドポイント
- 認証: `timingSafeEqual` によるタイミング攻撃耐性のある API キー認証
- ヘルスチェック: live/ready/health の3エンドポイント
- Zod バリデーション統合: `@hono/zod-validator` で全ルートにリクエストバリデーション

### 2.6 MCP サーバー実装 ★★★★

- 型安全なレジストリ: `ToolEntry` インターフェースでツール定義を統一
- v1/v2バージョニング: 環境変数でツールセットを切り替え
- エラーハンドリング: `toErrorResult()` で一貫したエラー形式
- セッションID解決: `_meta` からの自動解決

### 2.7 エラーハンドリングパターン ★★★★

1. **カスタムエラークラス** (`src/lib/errors.ts`): `MemoryRouterError`
2. **LLMエラー分類**: `aborted`, `timeout`, `connectivity`, `input_too_large` 等
3. **Safe関数パターン**: 副次的な処理は `*Safe()` 関数でラップし、メインフローを阻害しない
4. **監査ログ連携**: エラー時にも `recordAuditLogSafe()` で失敗を記録
5. **プロバイダーフォールバック**: 複数プロバイダーを順にフォールバック

### 2.8 品質ゲート

```bash
bun run verify  # typecheck → lint → format:check → test:unit → build:web
```

CI で pgvector 付き PostgreSQL を起動して integration test まで実行。

### 2.9 改善の余地

- `context-compiler.service.ts` が **1,350行・45KB** と巨大。分割が望ましい
- `src/cli/` に33個のスクリプトが並列配置されており、サブディレクトリ分割の余地あり
- E2E テストのカバレッジ不足
- グローバル API エラーハンドリングミドルウェアが見当たらない

---

## 3. 市場ポジション（75/100）

### 3.1 市場カテゴリの整理

2026年時点で、AIコーディングエージェントのメモリ・コンテキスト管理ツールは主に **4つのカテゴリ** に分類される。

| カテゴリ | 代表ツール | 特徴 | memory-router との距離 |
|---|---|---|---|
| **統合エージェントプラットフォーム** | Claude Code, Cursor, GitHub Copilot, Codex | IDE/CLI 内蔵のゼロコンフィグメモリ | 利用先（consumer）であり競合ではない |
| **専用メモリレイヤー** | Mem0, Letta (MemGPT), Zep (Graphiti) | プラットフォーム横断の永続メモリミドルウェア | 同じ「メモリ層」だがアーキテクチャ思想が異なる |
| **コンテキストガバナンスツール** | Packmind, Ruler | コーディング標準の配布・統制 | 部分的に重複（ルール管理） |
| **コンテキストコンパイラ** | Madar, memory-router | タスク特化のコンテキストパック生成 | **最も直接的な競合カテゴリ** |

### 3.2 主要競合との詳細比較

#### 静的ルールファイル（CLAUDE.md / Cursor Rules / AGENTS.md）

| 項目 | CLAUDE.md 等 | memory-router |
|---|---|---|
| 本質 | 静的 Markdown ファイル | 動的な知識蒸留エンジン |
| 知識の追加方法 | 人間が手書き | LLM蒸留 + 人間承認 |
| スコープ管理 | グローバル（手動分割） | DB レベルの repo/global |
| ライフサイクル | 手動更新・削除 | draft → active → deprecated |
| コンテキスト窓 | 全文ロード | トークン予算内でタスク特化選出 |
| タスク適応 | なし | goal/changeTypes/technologies/domains で動的 |
| **長所** | ゼロセットアップ | 自動蒸留、動的選出、監査可能 |
| **短所** | スケールしない | セットアップコスト |

#### Mem0（プラガブルメモリAPI）

| 項目 | Mem0 | memory-router |
|---|---|---|
| コアコンセプト | プラガブルなメモリ API | ローカルファースト知識エンジン |
| メモリ分類 | Episodic / Semantic / Procedural | rule / procedure + evidence 分離 |
| 蒸留 | パッシブ抽出・格納 | LLM蒸留 + スコアゲート + 外部エビデンス検証 |
| デプロイ | SaaS / セルフホスト | 完全ローカル |
| 知識品質管理 | なし | Knowledge Landscape、矛盾検出、replay診断 |
| **ターゲット** | 手軽にメモリ追加 | コーディングエージェント専用の知識基盤 |

#### Letta（旧 MemGPT）

| 項目 | Letta | memory-router |
|---|---|---|
| コアコンセプト | LLM をOSとして自律メモリ管理 | 人間が監督する蒸留パイプライン |
| メモリ管理主体 | エージェント自身 | 蒸留パイプライン + 人間承認 |
| 監査可能性 | エージェントの判断に依存 | 全段階の trace/audit log |
| **ターゲット** | 自律エージェントのフルスタック | 既存エージェントの知識補強 |

#### Zep AI（Graphiti）

| 項目 | Zep (Graphiti) | memory-router |
|---|---|---|
| コアコンセプト | 時間的知識グラフ | Knowledge Landscape |
| 時間推論 | ✅ 事実の時間的変化追跡 | △ staleness/decay ベース |
| 知識品質分析 | 基本的 | ✅ attractor/dead-zone/replay/contradiction |
| **ターゲット** | エンタープライズの事実管理 | コーディングエージェントの知識管理 |

#### Madar（コンテキストコンパイラ）

| 項目 | Madar | memory-router |
|---|---|---|
| コアコンセプト | コード構造グラフ → コンテキストパック | 知識蒸留 → コンテキストパック |
| 入力ソース | ソースコード構造（AST/依存関係） | Wiki、エージェントログ、手動ルール |
| 知識の種類 | コード構造・シンボル | 開発ルール・手順 |
| **関係** | **補完的**（コード構造 vs 開発知識） | **補完的** |

### 3.3 「知識蒸留」アプローチの独自性

| 観点 | 従来の RAG | 知識蒸留（学術的） | memory-router |
|---|---|---|---|
| 本質 | 生ドキュメントの類似検索 | 大→小モデルへの知識転移 | 生エビデンス → 構造化ルール/手順への変換 |
| 品質保証 | なし（検索スコアのみ） | 蒸留損失の最小化 | スコアゲート(>50)、エビデンス検証、人間承認 |
| 動的適応 | クエリ時のみ | 訓練時に固定 | compile 時に動的選出 + feedback で継続改善 |

### 3.4 MCP エコシステムにおけるポジション

- **公式 SDK** (`@modelcontextprotocol/sdk ^1.29.0`) を使用
- 7つのツールを公開
- 一般的な MCP メモリサーバーが KV ストア的なシンプルな記憶なのに対し、蒸留パイプライン + コンテキストコンパイル + Knowledge Landscape を提供する点で稀有

### 3.5 ユニークポジション

memory-router は、以下の交差点に位置する**唯一のツール**:

- Local-first
- Knowledge Distillation（not raw RAG）
- Coding Agent 特化
- MCP 標準準拠

### 3.6 市場課題

| 課題 | 影響 | 緩和策 |
|---|---|---|
| **認知度** | GitHub stars / コミュニティが未発達 | OSS オンボーディング計画が既にある |
| **導入障壁** | PostgreSQL + pgvector + LLM + embedding が必要 | `init:project` ウィザードで緩和中 |
| **個人開発** | バス係数 = 1 | MIT ライセンス、CI/テスト体制は整備済み |
| **market timing** | AI coding agent 市場自体が急速に変化 | MCP 標準準拠で vendor-neutral |

---

## 4. 将来性・拡張性（80/100）

### 4.1 ロードマップの質

`spec/project-value-improvement-roadmap.md` は、10項目の具体的な価値向上施策を優先順位付きで定義:

1. **Context 品質の評価エンジン** — 価値の計測可能化
2. **Active-use feedback loop** — 自己改善メカニズム
3. **Local appliance 化** — 導入障壁の低減
4. **Knowledge pack import/export** — 資産の移植性
5. **Agent integration 拡張** — エコシステム接続
6. **Queue と蒸留の自律運用** — 運用負債の低減
7. **Review/Approval workflow の製品化** — チーム利用
8. **Security / privacy controls** — エンタープライズ対応
9. **"Why this context?" explainability** — 透明性
10. **Plugin / extension API** — 拡張性

ロードマップの順序は「まず測定、次に改善、その後に拡大」という健全なプロダクト思考に基づいている。

### 4.2 技術的拡張性

| 拡張方向 | 現状の準備度 | 実現可能性 |
|---|---|---|
| 新しい Agent 対応 | MCP 標準準拠 | ◎ |
| チーム利用 | approval workflow の基盤あり | ○ |
| カスタム provider | provider routing の枠組みあり | ○ |
| 新しい source 種別 | source connector の拡張点あり | ○ |
| SaaS 化 | local-first 設計が前提 | △ 要設計変更 |

### 4.3 ロードマップと市場ニーズの整合

| ロードマップ施策 | 市場ニーズとの整合 | 優先度評価 |
|---|---|---|
| 1. Context 品質評価エンジン | ✅ 競合との差別化を定量証明 | **最優先** |
| 2. Active-use feedback loop | ✅ 「使うほど賢くなる」の実装 | 高 |
| 3. Local appliance 化 | ✅ Mem0 の簡便さへの対抗 | 高 |
| 4. Knowledge pack import/export | ✅ OSS コミュニティでの知識共有 | 中〜高 |
| 5. Agent integration 拡張 | ✅ MCP consumer の拡大 | 中 |

---

## 5. リスク・課題（70/100）

### 5.1 構造的リスク

| リスク | 深刻度 | 現状の緩和策 |
|---|---|---|
| **バス係数 = 1** | 🔴 高 | MIT ライセンス、CI/テスト、ドキュメント |
| **導入コストの高さ** | 🟡 中 | `init:project` コマンド、docker-compose |
| **market dependency** | 🟡 中 | MCP 標準で vendor-neutral |
| **コード量の増大** | 🟡 中 | モジュール分割、verify ゲート |
| **LLM provider 依存** | 🟢 低 | multi-provider fallback、local-first |

### 5.2 技術的負債の兆候

- 26 モジュール × service/repository/types/schema = ファイル数の増大
- 一部モジュール（`distillationRepair`, `lifecycle`）の境界が不明確
- `context-compiler.service.ts` (1,350行) の巨大化
- E2E テストのカバレッジ不足
- Web UI のテストが 2 ファイルのみ

### 5.3 持続可能性

| 指標 | 現状 | 評価 |
|---|---|---|
| 開発ペース | 12日間で93コミット | ◎ 非常に高い |
| コード品質管理 | CI + verify + lint + typecheck | ◎ |
| ドキュメント | README 日英、設計書6件 | ○ 良好 |
| コミュニティ | 個人プロジェクト | △ 未発達 |
| ライセンス | MIT | ◎ OSS 親和性高 |

---

## 6. SWOT 分析

### 強み (Strengths)
1. 蒸留パイプラインの深さ（4段階、スコアゲート、外部エビデンス検証）
2. Knowledge Landscape（attractor/dead-zone/replay/contradiction の診断は競合に類がない）
3. 監査可能性（compile run、candidate trace、approval link、LLM usage log の全段階記録）
4. MCP 標準準拠（主要エージェントと即座に統合可能）
5. コンテキストコンパイルの品質（トークン予算分割、retrieval mode 判別、degraded 理由の診断）
6. エビデンスと指示の分離

### 弱み (Weaknesses)
1. セットアップの摩擦（PostgreSQL/pgvector/Docker/LLM/embedding の5層必要）
2. 認知度ゼロ（OSS 公開前）
3. 個人プロジェクトの規模（継続的メンテナンスのリスク）
4. 導入効果の証明不足（`eval:context` が計画段階）
5. マルチテナント非対応

### 機会 (Opportunities)
1. Context Engineering の潮流（2026年の最重要テーマ）
2. ローカルファースト需要（規制強化でローカルソリューションへの需要増加）
3. MCP エコシステム拡大
4. Madar との補完関係
5. Knowledge pack の portability

### 脅威 (Threats)
1. 統合プラットフォームの進化（Claude Code や Cursor が内蔵メモリを強化）
2. Mem0 の簡便さ（「数行で統合」の手軽さ）
3. Packmind のエンタープライズ展開
4. SQLite 未対応による導入障壁

---

## 7. 定量的プロファイル

| 指標 | 値 |
|---|---:|
| **総コード行数** | ~119,600 行 |
| うち src（コアロジック） | ~54,900 行 |
| うち test | ~32,900 行 |
| うち web（フロントエンド） | ~20,100 行 |
| うち api | ~6,600 行 |
| **テストファイル数** | 153 |
| **ドメインモジュール数** | 26 |
| **DB マイグレーション数** | 49 |
| **API エンドポイント数** | 50+ |
| **MCP ツール数** | 7 (+ エイリアス) |
| **コミット数** | 93 |
| **開発期間** | 2026-05-14 〜 2026-05-26（12日間） |
| **テスト/本体比率** | ~27% |

---

## 8. 推奨ポジショニング戦略

### 一行ポジション
> **memory-router: AIコーディングエージェントのための ローカルファースト知識蒸留エンジン**

### 差別化メッセージ
1. **「RAG でもルールファイルでもない第三の選択肢」**: 生ドキュメントの検索でも手書きルールでもなく、LLM 蒸留 + 人間承認 + タスク適応コンパイル
2. **「使うほど賢くなる知識基盤」**: feedback loop と Knowledge Landscape による継続改善
3. **「あなたのデータは、あなたの手元に」**: 完全ローカル運用可能
4. **「なぜそのコンテキストが選ばれたかを説明できる」**: 監査可能性と透明性

### 市場ターゲット優先順
1. **個人開発者**（複数リポジトリで AI エージェントを使うパワーユーザー）
2. **小規模チーム**（共有知識基盤が必要だが SaaS を避けたい）
3. **セキュリティ重視組織**（コードを外部に送れない環境）

---

## 9. 総合所見

### 結論

memory-router は、**AI コーディングエージェントの知識管理**という急成長する問題領域において、技術的に独自かつ高品質な解決策を提供している。

「コンテキストコンパイラ」という概念は市場にほぼ存在せず、蒸留パイプラインとフィードバックループを統合したツールは memory-router が唯一である。12日間で 119,600 行のコードと 151 テストファイルを構築した開発速度と品質の両立は驚異的。

現時点では個人プロジェクトとしての制約があるが、アーキテクチャ品質、テスト体制、ロードマップの成熟度は、本格的な OSS プロジェクトへの発展を可能にする水準に達している。

### ★★★★★ に必要なもの

| 軸 | 現在の不足 |
|---|---|
| 技術的独自性 | 実利用での効果実証（eval:context の完成） |
| アーキテクチャ品質 | E2E テスト充実、Web UI テスト、エラーハンドリング統一 |
| 市場ポジション | コミュニティ形成、導入事例、GitHub stars |
| 将来性 | チーム利用実績、外部コントリビュータ |
| リスク | バス係数の改善、導入の簡素化 |

### 最優先の価値向上策

1. **効果の定量実証（eval:context）** — memory-router を使うことで具体的に何が改善されるかの定量データ
2. **導入障壁の低減（local appliance 化）** — PostgreSQL/pgvector/LLM/embedding のセットアップ簡素化

これにより、技術的な優位性を「使い続ける理由」に変換できる。
