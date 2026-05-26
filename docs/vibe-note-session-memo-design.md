# Vibe Note / Session Memo 設計

更新日: 2026-05-26
レビュー評点: 9.5 / 10

## 1. 結論
Vibe Note は、LLM がセッション中に劣化させず保持したい一時記憶の表示・参照面である。
保存基盤は既存の `session_memos` を使い、新テーブルは追加しない。

優先順位は次のとおり。

1. `compile_result`: `context_compile` 出力への参照ノート
2. `compile_eval`: LLM による compile 結果の採点ノート
3. `scratch`: その他の自由メモ

`compile_result` は compile 出力本文を二重保存しない。`context_compile_runs` の履歴を指す参照として Vibe Note に現れ、UI と MCP はその参照を解決して compile output を読めるようにする。

## 2. レビューで直した点
- 目標仕様と現行実装の境界を分離した。
- `compile_result` だけが増えると左一覧が肥大化する問題を、デフォルト非表示 + トグル表示として固定した。
- `compile_eval` が静的ラベル `compile_eval` に畳まれるとスロット消費しない問題を、実装禁止事項として明文化した。
- 40スロット上限を DB / API / MCP / UI の共通契約として扱うようにした。
- 「MCPも同じデータを閲覧できる」の意味を、DB本文の複製ではなく参照解決結果の同等性として定義した。

## 3. 現行実装の前提
この設計は以下の現行実装を前提にする。

- `session_memos` は `sessionId + slot` のアクティブ行を一意に扱う。
- `session_memos.slot` の有効範囲は `0..39`。
- `session_memos.body` の最大長は 10,000 文字。
- `session_memos.kind` の最大長は 64 文字。
- `context_compile_runs` は `session_id` と `pack_snapshot` を持つ。
- `pack_snapshot` には compile output を復元できる `outputMarkdown` が含まれる。
- MCP `context_compile` は MCP request metadata から `sessionId` / `threadId` / `conversationId` / `codexSessionId` を解決できる。
- API `POST /api/context/compile` は現時点では `sessionId` を入力として受け取らないため、自動リンク対象外にする。

## 4. スコープ
### In Scope
- `session_memos` の `kind` / `label` / `metadata` 契約
- 40スロットの割り当て・枯渇時の挙動
- `compile_result` 自動リンクのインターフェース契約
- `compile_eval` 保存契約
- UI と MCP の読み取り整合
- 受け入れ条件とテスト観点

### Out of Scope
- `context_compile` 完了時の `compile_result` 自動リンク実装
- compile output の本文を `session_memos.body` に複製する実装
- 人手による Vibe Note 作成 UI

## 5. データ契約
### 5.1 kind
`session_memos.kind` は次を使う。

- `compile_result`
- `compile_eval`
- `scratch`

`metadata.kind` は `session_memos.kind` と一致させる。

### 5.2 label
`label` は重複防止と人間向け識別にだけ使う。静的な kind 名をそのまま label にしてはならない。

- `compile_result`: `compile_result:<contextCompileRunId>`
- `compile_eval`: `compile_eval:<contextCompileRunId>:<ordinal>`
- `scratch`: 任意。未指定なら `null`。

`compile_eval` で label 未指定時に `compile_eval` という固定ラベルを自動設定すると、複数採点が1件へ上書きされる。これは本設計では禁止する。

### 5.3 metadata
#### compile_result
```json
{
  "kind": "compile_result",
  "contextCompileRunId": "<uuid>",
  "contextCompileRunCreatedAt": "<ISO8601>",
  "source": "auto_context_compile",
  "linkMode": "compile_output_reference",
  "linkStatus": "linked"
}
```

#### compile_eval
```json
{
  "kind": "compile_eval",
  "contextCompileRunId": "<uuid>",
  "contextCompileRunCreatedAt": "<ISO8601>",
  "source": "llm_eval",
  "title": "<short title>",
  "score": 0,
  "linkStatus": "linked"
}
```

`score` は `0..100`。`title` は短い採点名。`body` には採点根拠を書く。

### 5.4 body
- `compile_result`: 本文は短いプレビューだけにする。compile output の全文は保存しない。
- `compile_eval`: 採点本文を保存する。空文字は禁止。
- `scratch`: 通常の自由メモ本文を保存する。

## 6. compile_result 自動リンク
### 6.1 発火条件
`context_compile` が完了し、`context_compile_runs` の `pack_snapshot` が保存された後に発火する。

条件:
- `context_compile_runs.session_id` が存在する。
- `pack_snapshot` が存在する。
- 同じ `sessionId + contextCompileRunId` の `compile_result` がまだ存在しない。

API compile のように `sessionId` がない run は自動リンクしない。

### 6.2 保存内容
保存先は `session_memos`。

- `kind`: `compile_result`
- `label`: `compile_result:<contextCompileRunId>`
- `body`: compile output の短いプレビュー、または `"context_compile output reference"`
- `metadata.contextCompileRunId`: run id
- `metadata.linkMode`: `compile_output_reference`
- `source`: `system`

### 6.3 冪等性
同一セッション内で同一 `contextCompileRunId` の `compile_result` は1件のみ。
既存行がある場合は no-op とし、slot を追加消費しない。

### 6.4 失敗時
自動リンク失敗は `context_compile` の成功結果を破壊しない。
ただし失敗は audit / log / diagnostics のいずれかに残し、後から runId 単位で再リンクできるようにする。

## 7. compile_eval 保存
`compile_eval` は LLM が `session_memo` で保存する採点ノートである。

必須:
- `kind: "compile_eval"`
- `title`
- `score`
- `body`

推奨:
- `metadata.contextCompileRunId`

`metadata.contextCompileRunId` がない場合は、同一 session の最新 `context_compile_runs` へリンクする。リンク先が見つからない場合は保存自体は許可し、`metadata.linkStatus = "unresolved"` と `metadata.unresolvedReason` を付与する。

複数回採点した場合は、その回数分だけスロットを消費する。同一 run への再採点も別ノートとして扱う。

## 8. スロットポリシー
セッションごとの上限は 40 スロット。

- 有効 slot は `0..39`。
- `includeEmpty=true` は 40 件の slot 表示を返す。
- `put_many` は最大 40 件まで受け付ける。
- slot が未指定なら最小の空き slot を使う。
- slot が満杯なら `MEMO_FULL` を返す。
- 暗黙削除や自動上書きで空きを作らない。

## 9. API / MCP 契約
### 9.1 API
既存 API を継続使用する。

- `GET /api/session-memo?sessionId=...`
- `GET /api/session-memo/sessions?limit=...`
- `GET /api/session-memo/item?sessionId=...&slot=...`
- `POST /api/session-memo/item`
- `DELETE /api/session-memo/item?...`

追加・変更が必要な契約:
- `GET /api/session-memo/sessions` はデフォルトで `compile_result` のみのセッションを返さない。
- `includeCompileOnly=true` のような明示オプションがある場合だけ `compile_result` のみのセッションを返す。
- `GET /api/session-memo/item` で `compile_result` を返す場合、`linkedOutputMarkdown` または同等の解決済みフィールドを返す。

### 9.2 MCP
`session_memo` は Vibe Note の MCP 面である。

- `list`: session のメモ一覧を返す。
- `get`: `compile_result` の場合は参照先 compile output も返す。
- `put`: `compile_eval` / `scratch` を保存する。
- `put_many`: 最大 40 件を受け付ける。

MCP と API は、同じ `compile_result` を読んだときに同じ compile output を参照できることを保証する。これは本文複製ではなく参照解決によって実現する。

## 10. UI 方針
左一覧のデフォルト表示対象:
- `compile_eval` が1件以上あるセッション
- `scratch` が1件以上あるセッション

左一覧のデフォルト非表示対象:
- `compile_result` のみのセッション

`compile_result` のみのセッションは、明示トグルで表示する。

詳細表示:
- `kind` バッジを表示する。
- `compile_eval` は score / title / body preview を表示する。
- `compile_result` は `session_memos.body` ではなく、参照先 compile output を表示する。
- 参照先が見つからない場合は「参照先なし」を表示し、メモ行は削除しない。

作成 UI:
- 現時点では作らない。
- 人手入力が必要になった時点で別タスクとして設計する。

## 11. 実装タスク
### Task A: compile_result 自動リンク
- `context_compile` 完了後に `compile_result` を作る。
- `sessionId` がない run は skip する。
- `sessionId + contextCompileRunId` で冪等にする。
- compile output 本文は複製しない。

### Task B: 参照解決
- API `get/list` または専用 resolver で `contextCompileRunId` から compile output を返す。
- MCP `session_memo get` でも同じ解決結果を返す。
- `context_compile_runs.pack_snapshot` がない場合の fallback を決める。

### Task C: compile_eval の複数保存
- 固定 label `compile_eval` による上書きをやめる。
- `compile_eval:<runId>:<ordinal>` などで複数採点を別 slot に保存する。
- `contextCompileRunId` が明示されている場合は最新 run 推定より優先する。

### Task D: UI 一覧フィルタ
- 左一覧のデフォルトを `compile_eval` / `scratch` のあるセッションにする。
- `compile_result` のみのセッションはトグルで表示する。
- session count は「表示対象件数」と「総メモ件数」を混同しない。

## 12. 受け入れ条件
1. 同一 session で MCP `context_compile` を3回実行すると、重複 run を除き `compile_result` が3件作られる。
2. `compile_result` の `body` に compile output 全文は入らない。
3. `compile_result` を UI で開くと、`context_compile_runs.pack_snapshot` 由来の output が表示される。
4. `compile_result` を MCP `session_memo get` で読むと、UI と同じ output を参照できる。
5. LLM が `compile_eval` を2回保存すると、2件の別 slot が作られる。
6. 左一覧デフォルト表示では `compile_result` のみのセッションは出ない。
7. 左一覧の明示トグルを有効にすると `compile_result` のみのセッションも出る。
8. slot `39` は保存でき、slot `40` は拒否される。
9. `includeEmpty=true` は 40 件を返す。
10. 40 slot が埋まった状態では `MEMO_FULL` になり、暗黙削除されない。

## 13. テスト観点
- `session_memo` schema: slot `0` / `39` を許可し、`40` を拒否する。
- MCP tool schema: `put_many.items.maxItems` が 40 である。
- session service: `compile_eval` を2回保存して別 slot になる。
- session service: 40件保存後の追加が `MEMO_FULL` になる。
- API route: `includeEmpty=true` が40件を返す。
- API route: `compile_result` の参照解決フィールドを返す。
- UI repository: `includeCompileOnly` を明示指定できる。
- UI page: デフォルトでは `compile_result` のみの session を表示しない。
- UI page: トグル有効時に `compile_result` のみの session を表示する。

## 14. 残リスク
- compile 頻度が高い session では 40 slot でも枯渇する。
- `compile_eval` が多い場合、一覧の視認性が落ちる。
- 古い `context_compile_runs.pack_snapshot` が欠損している run では参照表示できない。

将来案:
- kind 別表示フィルタ
- アーカイブ導線
- 明示的な「この compile_result を固定する」操作
- slot 上限の設定化
