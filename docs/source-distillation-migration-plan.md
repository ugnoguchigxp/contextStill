# Vibe Memory & Agent Activity 移行計画

## 目的

`gnosis` の Vibe Memory（活動履歴）機能を `memory-router` へ完全に移植し、さらに `Codex` や `Antigravity` のセッション履歴を継続的に取り込むことで、エージェントの実装実績を知識として蒸留（Distill）する基盤を構築する。

「何が書かれているか（Wiki）」ではなく、**「エージェントが何を行い、どんなコードを書き、なぜその判断をしたか（Activity）」**をデータ運用の中心に据える。

## 主な方針

### 1. Gnosis 機能の完全移植
- Vibe Memory のデータ構造（`id`, `sessionId`, `content`, `embedding` 等）を移植。
- `memory_search` / `memory_fetch` ツールの移植。
- Gnosis で培った Vibe UI（履歴一覧、詳細表示、スニペットプレビュー）を React コンポーネントとして移植。

### 2. Codex / Antigravity 履歴の継続的インジェスト
- 外部エージェント（Codex, Antigravity）のセッションログを自動的、あるいは定期的に `Activity Source` として取り込む。
- 単なるテキストログとしてだけでなく、セッションごとの「ゴール」「意図」「成果物」を構造化して保存する。

### 3. AI Artifacts (コード & シンボル) の抽出
- 活動ログの中から AI が実装したソースコードを抽出し、`ai_artifacts` として独立保存する。
- 抽出されたコードに対してのみ、軽量なシンボル解析（関数・クラス名の抽出）を行い、`artifact_symbols` としてインデックス化する。
- これにより、全ファイルのスキャンを避けつつ、AIが関与した箇所の「コードの文脈」を確実に保持する。

### 4. 履歴から知識への蒸留 (Distillation)
- 活動ログを LLM で分析し、汎用的な「ルール（Guidance）」や「手順（Procedure）」を抽出。
- 抽出された `Knowledge Item` は、元の `Vibe Memory` および `AI Artifact` と強固なリレーションを張る。

---

## 新しい概念モデル

### 1. vibe_memories (移植)
Gnosis の中核データ。セッション中の発言やアクションの断片。
- `id`
- `session_id`
- `content` (Markdown / Log)
- `memory_type`: `chat | action | observation | system`
- `embedding`
- `metadata` (agent_id, tool_calls, etc.)

### 2. ai_artifacts
AI が生成・修正したコードの断片。
- `id`
- `vibe_memory_id` (紐付け)
- `file_path`
- `content` (コード本体)
- `diff` (変更内容)
- `language`

### 3. artifact_symbols
AI Artifact から抽出されたシンボル情報。
- `id`
- `artifact_id`
- `symbol_name`
- `symbol_kind` (function | class | etc.)
- `signature`

### 4. knowledge_items (蒸留済み知識)
活動ログから抽出された再利用可能な知見。
- `id`
- `title` / `body`
- `type`: `guidance | procedure`
- `status`: `candidate | active | archived`

---

## リレーションシップ

1.  **Vibe Memory ↔ AI Artifact**: どの対話/思考フェーズでどのコードが生成されたか。
2.  **Vibe Memory → Knowledge Item**: この知見はどの活動から導き出されたか。
3.  **Knowledge Item → Artifact Symbol**: このルールはどの関数やクラスの実装に関連しているか。

---

## UI 計画 (Gnosis UI の移植と拡張)

### 1. Activity (旧 Vibe UI)
- セッション履歴をタイムライン形式で表示。
- Codex / Antigravity のアイコンでソースを識別。
- ログ内のコードブロックを `Artifact` として強調表示。

### 2. Knowledge Candidates
- 活動ログから自動抽出された知識候補を「承認 / 却下」するワークフロー。
- 承認時に、関連する AI Artifact も同時に Knowledge の「根拠」として登録される。

---

## 実装フェーズ

### Phase 1: Gnosis 移植 & Foundation
- `vibe_memories` テーブルの追加。
- `memory_search` / `memory_fetch` ツールの実装。
- Gnosis UI の `ActivityPage` としての移植。

### Phase 2: Ingestion & Artifact Capture
- Codex / Antigravity のログインポート機能。
- ログからのコード抽出ロジック（`ai_artifacts`）の実装。
- Artifact からのシンボル抽出（軽量解析）の追加。

### Phase 3: Distillation Engine
- 活動ログをスキャンし、`Knowledge Item` を生成するバックグラウンドタスク。
- 知識と活動、知識とコード（シンボル）の自動リンク生成。

### Phase 4: Context Compiler 連携
- `context_compile` 時に、関連する `Knowledge` だけでなく、その根拠となった `Activity` や `AI Artifact` を Context Pack に含める。

---

## 撤回・削除事項
- **旧 Sources セクション (Wiki/Markdown)**: 削除。これらは「過去の活動ログ」や「エージェントが書いたドキュメント（Artifact）」として扱う。
- **全プロジェクトソーススキャン (Project-wide Code Index)**: 削除。AIが関与した `ai_artifacts` のスキャンに限定する。
