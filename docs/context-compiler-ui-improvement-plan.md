# Context Compiler UI 実践的改修計画書 (仕様・設計)

本ドキュメントは、`context_compile` の実行履歴と成果物を AI エージェントの動作トレースとして完全に可視化し、Vibe Memory や Codex App のように実践的で使いやすい2カラム構成の「デバッグ・コックピットUI」へと進化させるための実装計画です。

---

## 1. 現状の課題と改善方針

### ① 現状の課題
- **実行履歴と詳細の分断**: 過去の実行履歴 (`Recent Runs`) がテーブルで表示されるだけで、各履歴がどのような成果物（コンテキストパック）を出力したか、どのようなツール統計だったかを後から確認することができない。
- **デバッグ性の低さ**: エージェントが裏でMCPを叩いた際、検索スコアの分布、Agentic Refineでの思考プロセス、トークンバジェット調整による切り捨てが発生したか、といった重要な診断・トレース情報がUI上にビジュアル化されていない。
- **入力と結果の非対称**: UI上の手動テストとMCP経由での実行結果が、同じ履歴画面上でシームレスに同期・追跡しづらい。

### ② 改善方針
- **2カラムレイアウト（Sessionスタイル）の導入**:
  - **左カラム**: チャット履歴やCodex Sessionのように、`Goal`をトピックタイトルとした履歴リスト (`Recent Runs`) を縦に配置。
  - **右カラム**: 選択された履歴（または新規作成フォーム）の詳細表示。
- **時系列トレースタイムライン（右カラム）の採用**:
  - コンパイルが完了するまでのステップ（検索 -> エラー分析 -> LLM Refine -> バジェット圧縮 -> 最終出力）をチャットやシステムログのメタファーで上から下へ流れるように可視化。
  - 成果物（Context Pack）は「吹き出しUI」として綺麗にレンダリングし、完了打刻時刻とトータルレイテンシをスタンプ。
- **APIの拡張**:
  - 特定の `runId` に紐づく詳細なコンパイル結果（Rules, Procedures, Code Context, Diagnostics等）をDBから取得する `GET /api/context/runs/:id` エンドポイントを新設（リポジトリ層の `getCompileRunSnapshot` を露出）。
- **MCPとUIのシームレス同期**:
  - UIからの実行（Source: UI Manual）とMCPエージェントからの実行（Source: MCP）をタグで視覚的に識別可能にする。

---

## 2. 変更対象コンポーネントと設計

### ① バックエンド API 層

#### [NEW] `GET /api/context/runs/:id`
- **概要**: 選択された `runId` から、その実行情報と選択されたコンパイル成果物（Rules, Procedures等）の全体像を取得する。
- **処理**:
  1. `src/modules/context-compiler/context-compiler.repository.ts` の `getCompileRunSnapshot(runId)` を呼び出す。
  2. 存在しない場合は `404` を返却。
  3. 取得したスナップショットから、UIに表示しやすい形式の `ContextPack` 互換データを生成して返却。

### ② フロントエンド・リポジトリ＆フック層

#### [MODIFY] `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`
- **データ型の定義**:
  - `CompileRunDetail` 型を定義。`CompileRunSummary` の情報に加え、`rules`, `procedures`, `codeContext`, `warnings`, `minimalTasks`, `diagnostics` を内包する。
- **API関数**:
  - `fetchRunDetail(runId: string): Promise<CompileRunDetail>` を追加。 `/api/context/runs/:id` をコール。

#### [MODIFY] `web/src/modules/context-compiler/hooks/context-compiler.hooks.ts`
- **TanStack Query フック**:
  - `useCompileRunDetail(runId: string | null)` を追加。`runId` がある時だけ自動フェッチし、`compile-runs` の詳細キャッシュとして保持。

---

### ③ フロントエンド UI 層 (フルリニューアル)

#### [MODIFY] `web/src/modules/context-compiler/components/context-compiler.page.tsx`

```
┌────────────────────────────────────────────────────────────────────────┐
│  memory-router > Context Compiler Control Plane                        │
├──────────────────────────────────────┬─────────────────────────────────┤
│ Recent Runs [New Run ボタン]          │ Select a Run or Create New      │
│                                      │                                 │
│ 🔎 [検索フィルタ: すべて/UI/MCP]      │ ┌─ [Header] ──────────────────┐ │
│ ──────────────────────────────────── │ │ Goal: 認証ミドルウェアの修正  │ │
│ 💬 認証ミドルウェアの修正             │ │ Source: [MCP]  Status: [ok]   │ │
│    edit | task_context | 1.2s        │ └───────────────────────────────┘ │
│                                      │                                 │
│ 💬 e2eテストのエラー調査             │ ┌─ [Timeline Trace] ──────────┐ │
│    debug | debug_context | 850ms     │ │ ① 🔍 Hybrid Retrieval       │ │
│                                      │ │    - Rules: 8, Procedures: 5  │ │
│ 💬 初期シード投入手順                │ │                               │ │
│    plan | procedure_context | 2.1s    │ │ ② 🛠️ Error Analysis          │ │
│                                      │ │    - Hits: auth.ts, token     │ │
│                                      │ │                               │ │
│                                      │ │ ③ 🧠 Agentic Refine (LLM)     │ │
│                                      │ │    - Refined 13 -> 8 items    │ │
│                                      │ │      "Removed deprecated test" │ │
│                                      │ └───────────────────────────────┘ │
│                                      │                                 │
│                                      │ ┌─ [Output: Markdown Pack] ───┐ │
│                                      │ │ 📄 Rules (4 items)            │ │
│                                      │ │ 📄 Procedures (2 items)       │ │
│                                      │ │                               │ │
│                                      │ │ 🕒 2026-05-20 19:45 (1.2s)    │ │
│                                      │ └───────────────────────────────┘ │
└──────────────────────────────────────┴─────────────────────────────────┘
```

#### レイアウト構成要素
1.  **左側サイドバー**:
    - **Header**: タイトル＋「+ New Compile」ボタン。
    - **Filter**: 実行ソース（All / UI / MCP）やステータスでの絞り込み。
    - **List**: 各 `Compile Run` のカード表示。`Goal`（長い場合は三点リーダーで省略）を大きく表示し、サブテキストに `intent`、`retrievalMode`、`durationMs`、経過時間を美しくレイアウト。
2.  **右側メインコンテンツ（選択されたセッション）**:
    - **初期表示/新規作成時**: Goal入力フォーム（Goal, Intent, Retrieval Mode, Files, includeDraft）。「Compile」ボタン押下で即座に右側タイムラインに結果をレンダリングし、左側リストを再フェッチして同期。
    - **詳細表示時**:
      - **Header**: 選択された Run のメタデータ（Goal 全文、実行元バッジ、ステータスバッジ、作成日時）。
      - **Timeline Steps (トレース情報)**:
        - `diagnostics.retrievalStats` や `degradedReasons` に基づき、処理フェーズごとの結果を美しく表示。
        - **Retrievalフェーズ**: 初期ヒット件数、ソースごとのマッチ割合。
        - **Error Contextフェーズ**: `lastErrorContext` が提供されていた場合、抽出されたエラーキーワードやファイル一覧をコードバッジで明示。
        - **Refineフェーズ**: `agenticUsed` が真の場合、LLMの思考プロセス（Reasoning text）を表示。
        - **Budgetフェーズ**: トークン使用量。制限オーバーで切り捨てが発生した場合、警告表示（Warning 枠）。
      - **Final Content (吹き出し形式の成果物)**:
        - 最終的にエージェントに渡されたルール・手順・コードヒントなどの一覧をセクションごとにアコーディオン、またはMarkdownレンダラーで吹き出しの中に描画。
        - 吹き出しの隅に「実行完了時刻（打刻）」と「レイテンシ (`${durationMs}ms`)」を表示。
      - **Vibe Link (会話連携)**:
        - もし `vibeMemoryId`（あるいはそれに相当するセッション情報）が input にあれば、その会話画面へ遷移できるボタンを配置。

---

## 3. 実装の進め方 (Phases)

### Phase 1: API / Backend Infrastructure
- DrizzleからSnapshotを引くリポジトリの検証。
- `/api/context/runs/:id` ルートの実装と、スキーマ（Zod）の定義。
- VitestによるAPI疎通確認。

### Phase 2: Frontend Data Hook & Repositories
- フロントエンドにおけるAPI呼び出しと TanStack Query Hook (`useCompileRunDetail`) の追加。
- `Recent Runs` リスト側で詳細取得が綺麗にハンドリングできることの確認。

### Phase 3: UI Full-Rebuild & Style Styling
- CSSによる2カラム・グリッドレイアウトの設計。
- サイドバーのセッションリスト、右側のタイムライン/吹き出しUI、および新規フォームの切り替えロジック。
- プレミアムなダークモード調・ガラスモフィズム調スタイリング。

### Phase 4: Verification & E2E Test
- 手動コンパイルの実行で、履歴が即時左サイドバーに追加され、詳細が右タイムラインにシームレスにフェッチされるかの確認。
- MCPからの実行履歴が即時UIに流れてくるかのシミュレーション検証。
