# hooksLLM (LLM Hooks / hooks.json) 活用・導入ガイド

Antigravity プラットフォームが提供する **hooksLLM (LLM Hooks)** 機能を活用することで、コーディングエージェントの作業の安全性、品質保証、およびナレッジの自動登録プロセスを大幅に強化できます。

本ドキュメントでは、LLM Hooks の概要、使うべきタイミング、導入メリット、および具体的なセットアップ方法を解説します。

---

## 1. hooksLLM とは？

`hooks.json` は、Antigravity エージェントの実行ループ（ライフサイクル）の特定のタイミングに、独自のコマンドやスクリプトを「ミドルウェア」として割り込ませる（フックする）ための設定ファイルです。

### 主なイベントライフサイクル
- **`PreToolUse`**: エージェントが MCP ツール（ファイルの作成、書き換え、コマンド実行など）を実行する**直前**に割り込みます。
- **`PostToolUse`**: エージェントが MCP ツールを実行した**直後**に割り込みます。
- **`Stop`**: エージェントのタスク実行が終了したタイミングで割り込みます。

---

## 2. 導入するメリット

1. **デグレードの即時自動検知**
   コードを書き換えた直後（`PostToolUse`）に自動で単体テストが走るため、エージェントがバグを仕込んだ瞬間に自己検知し、自律的に修正ループへ移行できます。人間が指摘する手間が省けます。
2. **環境とDBの健全性担保**
   ファイル変更などの重要アクションの直前（`PreToolUse`）に `bun run doctor` を自動実行することで、DB接続エラーや設定不整合を事前に防ぎます。
3. **安全ガードレールの敷設**
   APIキーや秘密情報の書き込みを検知するセキュリティスキャナを `PreToolUse` に挟むことで、誤った認証情報のコミットを100%防止できます。
4. **トークンとコンテキストの節約**
   エージェント自身に「テストを実行してください」「DBを診断してください」と指示チャットを投げる必要がなくなり、実行ログが自動的にエージェントにフィードバックされるため、トークン消費を大きく節約できます。

---

## 3. hooksLLM を使うべきタイミングとユースケース

### ① コードを変更する直前（`PreToolUse`）
* **タイミング**: `write_file`, `replace_file_content`, `multi_replace_file_content` の実行直前
* **フックアクション**: `bun run doctor` の実行
* **目的**: データベースのマイグレーション漏れや、スキーマ定義とローカル PostgreSQL 稼働ポートの競合などがないかを自動チェックします。

### ② コードを変更した直後（`PostToolUse`）
* **タイミング**: `write_file`, `replace_file_content`, `multi_replace_file_content` の実行直後
* **フックアクション**: `bun run test:unit` または特定の変更ファイルに対するユニットテストの自動実行
* **目的**: 変更によって他のテストが壊れていないか（デグレード）をミリ秒単位で検知します。

### ③ コミット完了時（Git Hooks / `post-commit`）
* **タイミング**: Git のコミット完了時
* **フックアクション**: `post-commit-candidate-reminder.sh` の自動実行
* **目的**: 今回のコミットから、将来にわたって再利用可能な「知見、ルール、手順」を自動抽出し、エージェントに対して `register_candidates` を使った登録を促します。

### ④ ブロッカー由来の判断が必要になった時（MCP / `context_decision`）
* **タイミング**: 作業を続けるか、修正して続けるか、reject / rollback / discard / escalate すべきかで停止しそうな時
* **フックアクション**: shell hook ではなく、エージェントがユーザーへ質問する前に `context_decision` を呼ぶ運用ルールとして扱います。
* **目的**: ブロッカー由来の判断を Knowledge evidence と現在の作業文脈から先に評価し、ユーザー確認が本当に必要な場合だけ escalation します。危険操作、PR作成前判断、未完了Todoや失敗後の継続可否などが対象です。

### ⑤ 判断に従った作業結果が分かった時（MCP / `context_decision_feedback`）
* **タイミング**: `context_decision` の判断に従って作業し、その結果が成功・失敗・回帰・ユーザー上書き・破棄などとして分かった直後
* **フックアクション**: `context_decision_feedback` を保存します。pre-commit は、検証結果が揃いやすいため記録タイミングとして有効です。
* **目的**: 判断が実際に良かったかを decision record と effects table に戻し、次回以降の判断材料として蓄積します。

---

## 4. 設定方法

プロジェクトルートにある `hooks.json.example` を参考に、Antigravity のグローバル設定ディレクトリに `hooks.json` を配置します。

### 配置手順

1. テンプレートファイルをコピーしてグローバル設定ディレクトリへ配置します。
   ```bash
   cp hooks.json.example ~/.gemini/config/hooks.json
   ```

2. 正常にフックがロードされたか確認します。次回以降のエージェント起動時に、対象ツール（例：`replace_file_content`）が実行されると、自動的に指定されたコマンド（例：`bun run test:unit`）が背後で実行され、その結果がエージェントに通知されます。

### hooks.json 設定例 (`hooks.json.example` より)
```json
{
  "context-still-hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file|replace_file_content|multi_replace_file_content",
        "hooks": [
          {
            "type": "command",
            "command": "bun run doctor",
            "description": "Verify database and environment sanity before modifying code files"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "write_file|replace_file_content|multi_replace_file_content",
        "hooks": [
          {
            "type": "command",
            "command": "bun run test:unit",
            "description": "Automatically run unit tests to check for regressions after file modifications"
          }
        ]
      }
    ]
  }
}
```

---

## 5. エージェントへの誘導タイミング方針

協調動作を行うマルチエージェントや、新しく Goal Room に参加したエージェントは、以下の場面でユーザーに `hooksLLM` の導入や Git フック（`setup-candidate-registration-hook.sh`）の実行を推奨してください。

1. **作業開始時 (`initial_instructions` 直後)**
   「このプロジェクトには、ファイル変更時に自動でテストを実行し品質を担保する `hooksLLM` 用の `hooks.json.example` が用意されています。作業を安全に進めるために、`~/.gemini/config/hooks.json` へ設定をコピーして有効化することをおすすめします」と案内する。
2. **コミット忘れや、再利用可能な知見の蓄積漏れを検知したとき**
   「Git post-commit hook を有効化（`scripts/setup-candidate-registration-hook.sh install`）すると、コミット時に自動で `register_candidates` のリマインダーが走り、ナレッジの蓄積漏れを防げます」と案内する。
3. **ブロッカー判断や判断後フィードバックが漏れそうなとき**
   「ユーザー確認の前に `context_decision` でブロッカー由来の判断を記録し、その判断に従った作業が終わったら `context_decision_feedback` を保存してください。pre-commit 時点で結果が分かっていれば、そのタイミングでの記録が適しています」と案内する。
