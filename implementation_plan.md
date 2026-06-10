# テストカバレッジ向上計画 (Test Coverage Improvement Plan)

本プロジェクトのテストカバレッジを向上させ、保守性と品質を高めるためのアプローチと計画を提案します。本計画では、データベース（DB）やLLMなどの外部依存をすべてモック化し、**DBへの書き込みを行わない高速かつ軽量なユニットテストの追加**を主軸とします。

---

## 1. 現状の分析

現在のユニットテスト（`bun run test:unit`）実行時のテストカバレッジは以下の通りです：
- **Stmts (ステートメント):** 69.59%
- **Branch (分岐):** 57.87%
- **Funcs (関数):** 68.29%
- **Lines (行):** 72.35%

目標である **全体カバレッジ 85% 以上** に到達するためには、約 15% のカバレッジ向上が必要です。

### カバレッジが著しく低い（または未テストの）主要モジュール

1. **`src/modules/context-decision` (カバレッジ: 0% 〜 40%)**
   - `context-decision.service.ts` (0%): 意思決定 MCP ツールのビジネスロジック。LLM や DB への依存が高いため現在未テスト。
   - `context-decision.repository.ts` (0%): Drizzle を用いた DB アクセス。
   - `domain.ts` (0%)
2. **`src/modules/landscape` (カバレッジ: 0% 〜 20%)**
   - 複数の `repository.ts` や `review-llm.ts`, `replay` などのサービスが 0% または極めて低いカバレッジ。
3. **`src/modules/queue/core` (カバレッジ: 0% 〜 47%)**
   - ジョブキューの管理ロジック (`claim.ts`, `control.ts`)。
4. **`src/modules/session-memo` (カバレッジ: 1.41%)**
5. **フロントエンド (`web/src/modules`) のフックやコンポーネント (カバレッジ: 0%)**
   - `context-compiler/hooks/context-compiler.hooks.ts` (0%)
   - `context-decision` 関連のページ、サイドバー、フック (0%)

---

## 2. 提案するアプローチ

カバレッジ向上に向けて、DB不要のユニットテストを以下のステップで拡充します。

### ステップ1: DB不要のモックベースのユニットテストを追加する
もっともコードサイズが大きく、かつカバレッジが 0% である `context-decision` モジュールを最優先でテストします。
- **`context-decision.service.ts` のテスト化:**
  - DB アクセス（リポジトリ層の関数）および LLM プロバイダを Vitest のモック（`vi.mock`）で差し替えます。
  - `decideContext` 関数の主要なパス（`execute`, `reject`, `escalate` などの意思決定分岐）のロジックを検証するユニットテストを追加します。これにより、DBや外部APIに接続することなく、高速にテストを実行できます。
- **`session-memo.service.ts` のテスト化:**
  - ナレッジの一時保存ロジックについて、DB依存部分をモック化してテストを追加します。

### ステップ2: 未テストの `landscape` サービスのロジックをテスト化
- `landscape` 内 of ドメインロジックやコントラディクション（矛盾）検知ロジックなどのうち、DBをモック化しやすい部分から優先的にユニットテストを追加します。

### ステップ3: フロントエンド（WebUI）の主要フック・コンポーネントのテスト
- `web/src/modules/context-compiler` および `context-decision` のカスタム Hooks に対するユニットテストを追加します（`@testing-library/react`を使用し、純粋なロジックとしてテスト）。

---

## 3. 提案する変更内容

### [Component: Test Suite Expansion (Unit Tests Only)]
DBを必要としない新規ユニットテストの追加。

#### [NEW] [context-decision.service.test.ts](file:///Users/y.noguchi/Code/contextStill/test/context-decision.service.test.ts)
- `decideContext` 関数の主要なパスを検証するユニットテスト。
- LLM プロバイダと `searchKnowledge` などの外部依存をすべてモック化したテストケース。

#### [NEW] [session-memo.service.test.ts](file:///Users/y.noguchi/Code/contextStill/test/session-memo.service.test.ts)
- `session-memo.service.ts` のビジネスロジックを検証するユニットテスト（DB接続をモック化）。

---

## 4. 検証計画

### 自動テスト
以下のコマンドを実行し、データベースコンテナなどを起動していない状態でもテストがすべてパスし、かつカバレッジが向上することを確認します。

```bash
# ユニットテストのみを実行し、カバレッジを確認する（DB接続は不要）
bunx vitest run --coverage --exclude "test/*.integration.test.ts" --exclude "test/*.e2e.test.ts"
```

### 手動確認
- 生成された `coverage/index.html` をブラウザで開き、追加したテストにより該当ファイルのカバレッジが向上していることを視覚的に確認します。
