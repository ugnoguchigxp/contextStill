# Wiki & Agent Activity 統合移行計画

## 目的

`gnosis` の Vibe Memory（活動履歴）機能を `memory-router` へ完全に移植し、さらに `Codex` や `Antigravity` のセッション履歴を継続的に取り込む。
一方で、従来の `Sources` は「Wiki / 構造化ドキュメント」として再定義し、エージェントの活動とドキュメントの両面から知識を蒸留（Distill）する基盤を構築する。

## 主な方針

### 1. Sources (Wiki / ドキュメント)
- Markdown source tree を扱う content repository として維持。
- Wiki 文章、README、設計メモなどの「ストック型」情報を管理。
- フォルダ構造、検索、編集、履歴管理の UI 導線を提供。

### 2. Activity (Vibe Memory / ログ)
- Gnosis からの Vibe Memory 機能の完全移植。
- Codex / Antigravity のセッションログを継続的にインジェスト。
- エージェントの思考プロセスや対話などの「フロー型」情報を管理。

### 3. AI Artifacts (AI生成コード)
- 活動ログから AI が実装したソースコード（Artifacts）を抽出・保存。
- 全ファイルのスキャンは行わず、Artifact に対してのみシンボル抽出を行う。
- `Vibe Memory` ↔ `AI Artifact` ↔ `Knowledge` の多層リレーションを構築。

### 4. 蒸留 (Distillation)
- Wiki (Sources) と Activity (Vibe Memory) の両方から知識を蒸留。
- 重要な判断基準や手順を `Knowledge Item` として構造化。

---

## 概念モデル

### 1. Wiki (Sources)
- `sources`: Markdown 正本。
- `source_fragments`: 見出しや段落単位の断片。

### 2. Activity (Vibe Memories)
- `vibe_memories`: セッションログ（Gnosis 互換）。
- `ai_artifacts`: AI が生成したコード。
- `artifact_symbols`: Artifact から抽出されたシンボル。

### 3. Knowledge
- `knowledge_items`: 蒸留された知識。
- `knowledge_activity_links`: 活動/コードとの紐付け。
- `knowledge_source_links`: Wiki との紐付け。

---

## 撤回・削除事項
- **全プロジェクトソーススキャン (Project-wide Code Index)**: **削除**。代わりに AI 生成物（Artifacts）のスキャンに限定する。
- **Code セクション**: **削除**。メニューおよび DB テーブル（code_symbols）を排除。

---

## 実装フェーズ

### Phase 1: Vibe Memory 移植 (完了)
- `vibe_memories` テーブル追加。
- 検索・記録用 repository/service の実装。

### Phase 2: AI Artifact 連携
- `ai_artifacts`, `artifact_symbols` テーブル追加。
- ログからのコード抽出とシンボル化の実装。

### Phase 3: Wiki (Sources) 調整
- 既存 Sources を Wiki 運用に適した形に最適化。

### Phase 4: 統合 Distillation & UI
- Wiki と Activity の両方を確認・採用できる UI の提供。
