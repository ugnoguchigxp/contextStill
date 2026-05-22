# 失敗経験 Knowledge Candidate 化 実装計画

## 1. 目的

MCP の knowledge 登録を、即時に `knowledge_items` へ入れる処理から、まず候補として保存する処理へ変更する。

狙いは次の流れを固定すること。

1. Agent が作業中に得た教訓、失敗談、修正手順を MCP から即時登録する
2. 登録時点では embedding を作らず、正式な knowledge にもしない
3. 既存の蒸留ラインで価値判定、重複判定、procedure 品質判定を通す
4. 通過したものだけ `knowledge_items.status = draft` として保存し、embedding を作る
5. `context_compile` は draft/active knowledge だけを通常どおり検索する

失敗経験は新しい knowledge 種別にはしない。基本形は「失敗根拠つきの skill-like procedure 候補」として扱う。

## 2. 現状整理

現在の `register_knowledge` は次の動きをしている。

- MCP public tool として `register_knowledge` が公開されている
- 入力は `title`, `body`, `type`, `status`, `scope`, `confidence`, `importance`, `appliesTo`, `metadata` など
- handler は重複チェック後に `registerKnowledgeFromMarkdown(...)` を呼ぶ
- 登録時点で `knowledge_items` に保存され、embedding も生成される

一方、蒸留ラインにはすでに次の段階テーブルがある。

- `distillation_target_states`
- `find_candidate_results`
- `cover_evidence_results`
- `knowledge_items`

さらに `finalizeDistille` は `cover_evidence_results.status = knowledge_ready` の候補だけを `knowledge_items.status = draft` として保存する。ここに candidate 登録を接続すれば、専用の failure table を増やさずに目的を達成できる。

## 3. 方針

### 3.1 MCP 登録は candidate 保存に変える

公開ツールの主役を `register_candidate` にする。

`register_knowledge` は public MCP surface から外す。直接 `knowledge_items` へ保存するパスは MCP からは使わせない。

### 3.2 candidate は既存ラインに乗せる

新規の `knowledge_candidates` テーブルは作らない。

代わりに、MCP 登録 1 件を次の 2 行として保存する。

- `distillation_target_states`
  - `target_kind = knowledge_candidate`
  - `target_key = <generated candidate id>`
  - `source_uri = agent://candidate/<candidate id>`
  - `status = pending`
  - `phase = selected`
  - `priority_group = knowledge_candidate`
- `find_candidate_results`
  - `target_state_id = <above id>`
  - `candidate_index = 0`
  - `title = input.title`
  - `content = input.body`
  - `origin.source = mcp_register_candidate`
  - `origin.candidateType = input.type`
  - `origin.appliesTo = input.appliesTo`
  - `origin.repoPath = input.repoPath`
  - `origin.registeredAt = now`

`origin` は最小限に留める。検索やランキングの主軸に `metadata` / `origin` の細かい分類を使わない。

### 3.3 失敗経験は procedure 候補として表現する

失敗談を `type = failure` のような新種別にしない。

基本は `type = procedure` とし、既存の procedure 品質判定に乗る本文構造へ寄せる。

推奨本文:

```md
Use when:
- どの作業・症状・文脈で使うか

Failure pattern:
- 何が起きたか
- Agent が誤って完了報告した、DB 初期化を実行した、検証せず修正完了とした、など

Root cause:
- 失敗を引き起こした構造的原因

Workflow:
1. まず疑うべき前提を確認する
2. 実行前に守るべき手順を適用する
3. 修正後に再現条件を使って検証する

Verification:
- 成功判定に使うコマンド、ログ、UI、DB 状態

Avoid:
- やってはいけない短絡、過信、破壊的操作

Evidence:
- 元タスク、修正タスク、ログ、ユーザー指摘の要約
```

必須は `Use when:`, `Workflow:`, `Verification:`, `Avoid:`。`Failure pattern:`, `Root cause:`, `Evidence:` は失敗経験向けの推奨セクションとして扱う。

## 4. 非目標

- `knowledge_items` に `failure_kind` などの列を増やさない
- `metadata.lessonKind` のような非正規化フィールドを検索条件の中心にしない
- `failure` という knowledge type を追加しない
- candidate 登録時に embedding を作らない
- candidate 登録時に active knowledge へ昇格しない
- `initial_instructions` に長い固定ルールを足さない
- 初期実装で大規模な失敗分類器を作らない

## 5. データモデル変更

### 5.1 `distillationTargetKindValues`

`knowledge_candidate` を追加する。

```ts
export const distillationTargetKindValues = [
  "wiki_file",
  "vibe_memory",
  "knowledge_candidate",
] as const;
```

### 5.2 `DistillationTargetPriorityGroup`

`knowledge_candidate` を追加する。

```ts
export type DistillationTargetPriorityGroup =
  | "knowledge_candidate"
  | "wiki"
  | "vibe_memory";
```

DB の check constraint も更新する。

### 5.3 migration

Drizzle migration で次を行う。

- `distillation_target_states_target_kind_check` を更新
- `distillation_target_states_priority_group_check` を更新

既存データの変換は不要。

## 6. MCP ツール設計

### 6.1 新規ツール: `register_candidate`

入力は現行 `register_knowledge` に近くするが、正式 knowledge 用の項目は削る。

必須:

- `title`
- `body`

任意:

- `type`: `rule | procedure`, default `rule`
- `confidence`
- `importance`
- `appliesTo`
- `general`
- `technologies`
- `changeTypes`
- `domains`
- `repoPath`
- `repoKey`
- `metadata`

削る項目:

- `status`
- `scope`

理由:

- candidate はまだ `draft / active / deprecated` ではない
- candidate の scope は後段の `coverEvidence` / `finalizeDistille` で決める
- 初期保存は同期的で軽量にする

### 6.2 戻り値

登録直後に次を返す。

```json
{
  "targetStateId": "...",
  "findCandidateResultId": "...",
  "sourceUri": "agent://candidate/...",
  "status": "candidate_registered",
  "next": "run distillation pipeline to promote valid candidates to draft knowledge"
}
```

### 6.3 `register_knowledge` の扱い

`register_knowledge` は public MCP surface から外す。

ユーザー意図としては「登録できるが即 knowledge にはしない」が重要なので、MCP から直接 `knowledge_items` へ保存する入口は残さない。

## 7. サービス設計

### 7.1 新規 service

`src/modules/knowledgeCandidateRegistration/` を追加する。

責務:

- input schema の正規化
- UUID 生成
- `distillation_target_states` 作成
- `find_candidate_results` 作成
- 重複候補の軽い検出
- MCP handler 用の結果整形

重複候補の扱い:

- 既存 `knowledge_items` との完全一致に近い重複は `candidate_registered_duplicate_possible` として警告しても保存する
- 強制 skip はしない
- 最終判断は `coverEvidence` の重複判定に寄せる

理由:

- 登録時点で捨てると、失敗経験の収集頻度が落ちる
- LLM/embedding を使う重い判定を同期 MCP 登録の critical path にしない

### 7.2 repository

`distillation_target_states` と `find_candidate_results` を同一 transaction で作る。

失敗時に片方だけ残さない。

`target_key` は UUID にする。本文 hash による deterministic key は初期実装では避ける。

理由:

- 似た失敗経験を複数保存したい場合がある
- 重複整理は candidate 後段の仕事にする方が安全

## 8. 蒸留ライン変更

### 8.1 target kind 追加

型と check constraint に `knowledge_candidate` を追加する。

対象:

- `src/db/schema.ts`
- `src/modules/selectDistillationTarget/domain.ts`
- `src/modules/findCandidate/repository.ts`
- `src/modules/coverEvidence/domain.ts`
- `src/modules/coverEvidence/source-support.service.ts`
- distillation target repository / CLI / tests

### 8.2 candidate 優先順位

`selectDistillationTarget` は `knowledge_candidate` を最優先にする。

順序:

1. `knowledge_candidate`
2. `wiki_file`
3. `vibe_memory`

理由:

- MCP から登録した candidate は作業直後の短命な文脈を持つ
- ユーザーが明示的に登録したものなので処理待ちを短くしたい

ただし candidate が大量に詰まる場合は、将来 `--kind` filter や quota で調整する。

### 8.3 inventory refresh

`refreshDistillationTargetInventory` は wiki/vibe の inventory 更新だけを続ける。

`knowledge_candidate` は MCP tool が作るため、inventory refresh で生成しない。

注意点:

- refresh 時に `knowledge_candidate` target を消したり上書きしたりしない
- `distillation_target_states` の claim/retry/status 操作は全 target kind 共通で使えるようにする

### 8.4 `loadOrRunFindCandidate`

既存実装は target に `find_candidate_results` があれば `runFindCandidate` をスキップする。

MCP candidate は登録時点で `find_candidate_results` を作るため、この性質をそのまま使う。

必要な確認:

- `candidateCount` 更新が既存行 reuse 時にも正しく行われること
- `runFindCandidate` が `knowledge_candidate` に対して呼ばれないこと

### 8.5 source support

`readSourceEvidenceForCandidate` を `knowledge_candidate` 対応にする。

現在は `wiki_file` 以外を `vibe_memory` として読む構造なので、このままだと `knowledge_candidate` を vibe memory ID と誤認する。

対応方針:

- `row.targetKind === "wiki_file"` は既存どおり wiki file
- `row.targetKind === "vibe_memory"` は既存どおり vibe memory
- `row.targetKind === "knowledge_candidate"` は `row.content` を source evidence として返す

reference:

```ts
{
  kind: "source",
  uri: row.sourceUri,
  locator: "candidate:content",
  note: "registered knowledge candidate",
  evidenceRole: "supports_candidate",
}
```

この source evidence は「登録者の主張そのもの」なので、価値判定と重複判定は引き続き後段で行う。

## 9. failure-backed procedure の蒸留ルール

### 9.1 candidate 登録時

登録時は hard reject しない。

ただし `type = procedure` で `Use when`, `Workflow`, `Verification`, `Avoid` が不足している場合は、戻り値に warning を含める。

例:

```json
{
  "status": "candidate_registered",
  "warnings": [
    "procedure candidates should include Use when, Workflow, Verification, and Avoid sections"
  ]
}
```

### 9.2 coverEvidence

`knowledge_candidate` は source evidence が短く、登録者の要約に依存しやすい。

初期実装では特別扱いしすぎない。

- 価値が低いものは `insufficient` / `low_value`
- 重複が強いものは `duplicate`
- procedure として不十分なものは既存の procedure 品質判定で demote/reject

### 9.3 finalize

既存どおり `knowledge_items.status = draft` で保存する。

metadata には既存の `targetKind`, `targetKey`, `sourceDocumentUri`, `coverEvidenceResultId` を入れる。新しい検索用 metadata は増やさない。

## 10. `context_compile` への接続

MVP では `context_compile` を大きく変えない。

candidate は compile 対象にしない。`knowledge_items` に draft/active として昇格してから通常検索に入る。

次の段階で、failure-backed procedure の本文に `Failure pattern:` / `Root cause:` がある場合だけ、pack renderer が短い注釈として出す。

例:

```md
### Procedure
...

Failure note:
類似タスクでは、検証ログを確認せず完了報告したため再修正になった。完了前に `bun run verify` の実行結果を確認すること。
```

この注釈は global initial instruction ではなく、類似 knowledge が選ばれたときだけ出る。

## 11. UI / Admin

既存の candidate lineage 表示がある場合は、`knowledge_candidate` を表示対象に追加する。

表示するもの:

- source: `MCP candidate`
- title
- type hint
- target status
- cover evidence status
- finalized knowledge id
- warnings
- registeredAt

初期実装で専用の複雑な編集 UI は作らない。

最低限:

- candidate が保存されたことを見えるようにする
- rejected / duplicate / knowledge_ready / finalized の状態を追えるようにする

## 12. CLI

必要なら distillation CLI に kind filter を足す。

候補:

```sh
bun run distill-pipeline -- --kind candidate --limit 5
```

実装上の mapping:

- `candidate` -> `knowledge_candidate`
- `wiki` -> `wiki_file`
- `vibe` -> `vibe_memory`

MVP では通常の pipeline が `knowledge_candidate` を優先するだけでもよい。

## 13. テスト計画

### 13.1 unit

- `registerCandidateTool` が `distillation_target_states` と `find_candidate_results` を作る
- candidate 登録時に `knowledge_items` が作られない
- `knowledge_candidate` の source support が `row.content` を返す
- procedure candidate warning が出る
- valid failure-backed procedure body が `hasSkillLikeProcedureBody` を通る

### 13.2 integration

- MCP tool -> pipeline -> `cover_evidence_results` -> `knowledge_items.status = draft`
- invalid procedure candidate は draft 化されない
- duplicate candidate は duplicate として止まる
- wiki/vibe の既存 pipeline が壊れない

### 13.3 contract

- MCP tools list に `register_candidate` が含まれる
- `initial_instructions` が `register_candidate` を案内する
- MCP tools list に `register_knowledge` が含まれない
- docs/mcp-tools.md を更新する

### 13.4 migration

- `knowledge_candidate` の target row が DB check constraint を通る
- 既存 `wiki_file` / `vibe_memory` target が引き続き通る

## 14. 実装順序

### Phase 0: contract 決定

- tool 名を `register_candidate` に決める
- `register_knowledge` を public MCP surface から外す
- candidate 本文テンプレートを docs に固定する

### Phase 1: schema / domain

- `distillationTargetKindValues` に `knowledge_candidate` を追加
- priority group に `knowledge_candidate` を追加
- migration を生成
- domain 型と repository 型を更新
- `selectDistillationTarget` に candidate 優先順位を追加

### Phase 2: candidate registration service

- `knowledgeCandidateRegistration` module を追加
- transaction で target/candidate を保存
- warning 生成を追加
- MCP tool `register_candidate` を追加
- `register_knowledge` の直接登録パスを MCP から外す

### Phase 3: distillation support

- `readSourceEvidenceForCandidate` を `knowledge_candidate` 対応にする
- coverEvidence / finalize / runner の型を更新
- `loadOrRunFindCandidate` reuse 前提の regression test を追加
- pipeline が candidate を draft へ昇格できることを確認する

### Phase 4: docs / initial instructions / UI

- `docs/mcp-tools.md` を更新
- `src/mcp/tools/system.tool.ts` を短く更新
- contract tests を更新
- admin candidate 表示に `knowledge_candidate` を追加

### Phase 5: compile 注釈

MVP の後で実装する。

- `Failure pattern:` / `Root cause:` を含む selected procedure を検出
- pack renderer に短い failure note を追加
- context payload が肥大化しないよう 1 procedure につき 1-2 行に制限する

## 15. 受け入れ条件

- MCP から `register_candidate` を呼ぶと同期的に candidate ID が返る
- 登録直後には `knowledge_items` が増えない
- 登録直後には embedding が作られない
- pipeline 実行後、有効な candidate だけが `knowledge_items.status = draft` になる
- `knowledge_items.metadata.targetKind = knowledge_candidate` で出自を追える
- invalid / duplicate / low value candidate は draft 化されず、状態が追える
- 既存 wiki/vibe distillation が通る
- `context_compile` は candidate を直接読まず、draft/active knowledge だけを読む
- `register_knowledge` は MCP から直接 `knowledge_items` に保存しない

## 16. 検証コマンド

最低限:

```sh
bun run test:unit
bun run verify
```

実装範囲に応じて追加:

```sh
bun run db:generate
bun run db:migrate
bun run doctor
bun run distill-progress
```

MCP contract 変更後:

```sh
bun test test/mcp.contract.test.ts
bun test test/mcp.tools.test.ts
```

## 17. リスクと対策

### 17.1 candidate が溜まりすぎる

対策:

- candidate target を優先処理する
- `--kind candidate --limit N` を用意する
- admin で rejected / duplicate を見えるようにする

### 17.2 登録本文が雑で使えない

対策:

- 登録時は保存するが warning を返す
- procedure は既存の skill-like section 判定で落とす
- docs に failure-backed procedure template を置く

### 17.3 metadata が肥大化する

対策:

- metadata/origin は出自追跡だけに使う
- 検索分類は本文、`appliesTo`, embedding, FTS に寄せる
- 必要になったら正規化テーブルを検討する

### 17.4 自分で書いた candidate を自分で evidence として通してしまう

対策:

- `knowledge_candidate` の source support は「登録者主張の存在確認」と位置づける
- 価値、重複、procedure 品質の gate は必ず通す
- external evidence が必要な内容は既存の `requiresExternalEvidence` に任せる

### 17.5 failure matching が過剰に効く

対策:

- 初期実装では candidate を compile に直接出さない
- draft/active に昇格した knowledge だけを検索対象にする
- failure note は MVP 後に短い注釈として追加する
