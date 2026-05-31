# MCPツール設計ベストプラクティス

## 目的
MCPツールを「公開されている」だけの状態から、LLMが正しい場面で自然に使い、運用者が安全に観測・改善できる状態へ持っていくための設計指針をまとめる。

この文書は、MCP公式仕様・公式クライアント/サーバ開発ガイド・Anthropicの tool definition 指針・Serena の実運用設計をもとにした一般化である。

## 基本原則
1. MCPツールはプロトコル契約、LLM向け説明、実行時誘導、安全運用をセットで設計する。
2. ツールの説明文はルーティングプロンプトである。短すぎる説明はツール未使用や誤使用につながる。
3. ツール一覧は少ないほど良い。増える場合は progressive discovery で必要な定義だけをLLM文脈へ入れる。
4. 結果は高信号・低ノイズにする。次の判断に不要なフィールドや巨大本文を返さない。
5. 危険操作、外部送信、権限境界をまたぐ処理は human-in-the-loop と監査ログを前提にする。

## Serenaから抽出できる実践パターン

Serenaの参考価値は、個々のツール仕様よりも「LLMにツールを使わせるための誘導設計」を複数層で持っている点にある。これはMCPツール一般にもかなり転用しやすい。

### 1. System promptをツール利用に最適化する
Serenaは、クライアントが持つ既定の探索・編集ツールへLLMが戻る問題を前提に、system promptの上書きまで案内している。

一般化すると、重要なMCPサーバーでは次を明文化する。

- このMCPが担当する作業領域。
- 内蔵ツールより先に使うべきMCPツール。
- 低レベル操作へ降りてよい条件。
- 作業完了前に確認すべきMCPツール。

単に「ツールがあります」では弱い。LLMの既定行動を上書きする文面にする。

### 2. セッション開始時の起動手順を固定する
Serenaは、プロジェクトをactivateし、初期指示を読む流れを開始時の儀式として扱っている。

一般化すると、状態を持つMCPサーバーでは次の順序を固定する。

1. 対象プロジェクト/ワークスペースを確定する。
2. サーバー側の初期指示を読む。
3. 現在タスク用のコンテキスト取得ツールを呼ぶ。
4. その後に探索・編集へ進む。

この順序を任意にすると、LLMは作業途中でMCPの存在を思い出せない。

### 3. Hookでドリフトを補正する
Serenaは、セッション開始時のactivateや、ツール使用前のreminderをhookとして設定する運用を案内している。

一般化すると、重要ツールはpromptだけに頼らない。

- `SessionStart`: 初期化ツールを自動実行または強く促す。
- `PreToolUse`: 低レベル探索・読み取りが続いた時に専門MCPツールを促す。
- `Stop` / `PreFinal`: 完了前の検証・記録ツールを促す。

LLMは長い会話で初期指示から離れる。hookはその前提への対策になる。

### 4. Context/modeでツール面を絞る
Serenaは、利用文脈に応じて有効ツールを変える設計を持っている。

一般化すると、ツール一覧は常に全部出すものではない。

- 読み取り専用モードでは編集ツールを出さない。
- オンボーディング時だけ初期化ツールを出す。
- 通常開発時は高頻度ツールだけ出す。
- 破壊的操作は明示モードでだけ出す。

ツール選択肢を減らすこと自体が、LLMの正答率を上げる設計になる。

### 5. メモリは「存在を知らせる」と「読む」を分ける
Serenaは、メモリ本文を最初から全部流すのではなく、メモリの存在をLLMに知らせ、必要に応じて読む形を取っている。

一般化すると、メモリ系ツールは次の二段階にする。

- 初期指示: どんなメモリがあるか、いつ読むかを知らせる。
- 詳細取得: 必要になったメモリだけ本文を読む。

これにより、コンテキストを圧迫せずに、LLMが「読むべきメモリを知っている」状態を作れる。

### 6. クライアント別の設定例まで提供する
Serenaは、特定クライアント向けの設定例やhook例を提供している。

一般化すると、MCPサーバー側のREADMEには抽象説明だけでなく、主要クライアント別の実設定を載せる。

- Claude Code
- Codex
- VS Code系クライアント
- Cursor系クライアント
- 汎用MCP JSON設定

LLMに使わせたいなら、人間が正しく設定できるところまで設計対象に含める。

### 7. 「使われなかった時」を観測する
Serenaのreminder設計は、ツール未使用を検知して介入する発想に近い。

一般化すると、良いMCPサーバーは成功時だけでなく未使用も観測する。

- セッション開始後に初期化ツールが呼ばれたか。
- 対象操作に対して専門ツールではなく低レベル操作が続いていないか。
- reminder後にツール利用へ戻ったか。
- 完了前の記録・検証ツールが呼ばれたか。

これは品質改善に直結する。

## プロトコル契約

### tools/list
- すべての公開ツールは一意な `name`、明確な `description`、JSON Schema の `inputSchema` を持つ。
- ツール一覧が変わる可能性があるなら `tools.listChanged` capability と `notifications/tools/list_changed` を正しく扱う。
- ツール数が多い場合は、最初から全定義をLLMに渡さず、検索・詳細取得・実行の3層に分ける。

### tools/call
- 未知ツール名や壊れたJSON-RPCリクエストは protocol error として扱う。
- API失敗、業務ルール違反、入力値は形として妥当だが実行不能なケースは tool result の `isError: true` で返す。
- `content` はLLMが読む本文、`structuredContent` は機械処理用の構造化結果として分ける。
- `outputSchema` を持つツールは、サーバ側でその schema に合う `structuredContent` を返す。
- 後方互換が必要なら、構造化結果の要約またはJSON文字列を `content` の text block にも入れる。

## ツール定義

### 名前
- `service_action` または `domain_action` の形で、同名衝突と曖昧さを避ける。
- 汎用名（`run`, `query`, `update`）は避ける。
- 関連操作は分離しすぎず、自然な単位でまとめる。例: `github_pull_request` + `action`。

### 説明文
説明文には最低限次を含める。

- 何をするツールか。
- いつ使うべきか。
- いつ使うべきでないか。
- 各パラメータが挙動へどう影響するか。
- 返すもの、返さないもの。
- 失敗時の代表的な理由。

短いラベル説明ではなく、3から4文以上の実用説明を基本にする。複雑な入力では `input_examples` 相当の例を追加する。

### 入力
- 必須項目は最小にする。
- enum、format、min/max、文字数上限を schema に入れる。
- 自由入力は必要な時だけ使う。LLMに巨大JSONやDSLを組ませない。
- `action` 多態にする場合は、actionごとの必須フィールドとエラーを明確にする。

### 出力
- 次の推論や次のツール呼び出しに必要な情報だけ返す。
- IDは安定識別子を返す。表示名だけ、内部DB行番号だけ、巨大オブジェクトだけは避ける。
- 長文は preview + fetch/detail ツールに分ける。
- エラーは復旧可能性がわかる短い code と説明を返す。

## 利用誘導

### 初期指示
- 「このツールがある」ではなく「いつ必ず使うか」を書く。
- 例: 作業開始時、方針変更時、ブロッカー発生時、完了前。
- 重要ツールは `must` / `first` / `before final` のように達成条件へ入れる。

### セッション開始フロー
- プロジェクト文脈が必要なツールは、`activate_project` -> `initial_instructions` -> task tool の順序を固定する。
- 単一プロジェクト前提なら、起動設定で project を確定し、LLMに選ばせない。

### ドリフト対策
- 長セッションでは、LLMが内部の汎用操作へ戻る前提で hook や reminder を入れる。
- `PreToolUse` 相当で低レベル操作が続いたら専門ツールを促す。
- 重要だが安全な読み取りツールは auto-approve に寄せ、摩擦を下げる。

## ツール数と文脈管理

### 少数ツールの場合
- 全ツールを `tools/list` で出してよい。
- ただし説明文と schema が文脈を圧迫し始めたら分割する。

### 多数ツールの場合
- Catalog: `search_tools` で名前と短い説明だけ返す。
- Inspect: `get_tool_details` で1ツール分の schema と説明を返す。
- Execute: 選んだツールだけを呼ぶ。
- tool定義はホスト側でキャッシュし、`list_changed` で再indexする。
- prompt cache を壊さないため、ツール配列の並べ替えや頻繁な出し入れは避ける。

## 安全性

- すべての入力を validation する。
- 権限とテナント境界をサーバ側で確認する。LLMやクライアントUIの選択だけを信用しない。
- rate limit、timeout、監査ログを持つ。
- 外部送信や破壊的操作は、操作対象・入力・影響範囲をユーザーに見せて確認を取る。
- 出力は sanitize し、tool result をそのままプロンプト命令として扱わない。
- OAuthや外部API連携では token passthrough を避け、audience/issuer/scope を検証する。

## メモリ系ツールの設計

- メモリは「検索」「要約一覧」「詳細取得」「更新」を分ける。
- 初期指示ではメモリ名・役割・読む条件を渡し、全文を最初から読ませない。
- short-lived scratch と durable knowledge を分離する。
- 並列エージェントが書くなら `label` 規約と revision/CAS を入れる。
- 上書き可能な共有状態は `work_state`、一方向引き継ぎは `handoff:*` のように用途別ラベルを固定する。

## 運用KPI

- 初動遵守率: 開始時に必須ツールが呼ばれた割合。
- 適切利用率: 対象タスクで該当ツールが呼ばれた割合。
- 誤利用率: 不要な場面で呼ばれた割合。
- 再誘導回復率: reminder/hook 後に正しいツールへ戻った割合。
- 結果有用率: ユーザー作業や後続ステップに使われた tool result の割合。
- エラー復旧率: `isError: true` 後にLLMが正しく再試行・代替できた割合。

## 出典
- MCP Tools specification:
  - https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP client best practices:
  - https://modelcontextprotocol.io/docs/develop/clients/client-best-practices
- MCP server development guide:
  - https://modelcontextprotocol.io/docs/develop/build-server
- MCP security best practices:
  - https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- Anthropic tool definition guidance:
  - https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Serena client integration / hooks / system prompt override:
  - https://oraios.github.io/serena/02-usage/030_clients.html
- Serena tools:
  - https://oraios.github.io/serena/01-about/035_tools.html
- Serena workflow:
  - https://oraios.github.io/serena/02-usage/040_workflow.html
- Serena memories:
  - https://oraios.github.io/serena/02-usage/045_memories.html
- Serena configuration:
  - https://oraios.github.io/serena/02-usage/050_configuration.html
