# findCandidate ドメイン実装計画

作成日: 2026-05-19  
対象リポジトリ: `memory-router`

## 目的

`selectDistillationTarget` が選んだ 1 target から、知識化候補を抽出する。

このドメインの責務は候補選出だけに限定する。候補の正しさ、重要度、外部証拠、重複、knowledge 化可否は次工程で扱う。

出力は最小にする。

- `title`
- `content`

`type`、`confidence`、`importance`、`evidence`、`sourceRefs`、`knowledge` 形への整形はここでは行わない。

## ドメイン境界

`findCandidate` が持つ責務:

- selected target の種別に応じて、LLM に 1 種類の reader tool だけを公開する。
- `wiki_file` なら `readFile` だけを使わせる。
- `vibe_memory` なら `memoryReader` だけを使わせる。
- LLM には本文 content だけを読ませ、候補タイトルと候補本文だけを選ばせる。
- CLI で text 出力と table 書き込みを切り替えられるようにする。

`findCandidate` が持たない責務:

- どの target を処理するか選ばない。
- 複数 target を混ぜない。
- Web search / fetch / 外部証拠取得をしない。
- 候補の評価、重要度付け、信頼度付けをしない。
- draft knowledge を作らない。
- embedding を作らない。

## 入力契約

runner から受け取る入力は selected target 1 件だけにする。

```ts
type FindCandidateInput = {
  targetStateId: string;
  provider?: "local-llm" | "azure-openai" | "bedrock" | "auto";
  callerMode?: "cli_text" | "storage";
};
```

`targetKind`、`targetKey`、`sourceUri` は `distillation_target_states` から引く。入力側で同じ識別情報を重複して渡さない。

## Reader Tool

LLM に渡す tool は target kind で 1 つだけにする。

LLM に見せる tool result は本文 content の文字列だけにする。`targetKey`、`sourceUri`、token range、total token、read count などのメタ情報は LLM に渡さない。

target や読み取り範囲は orchestrator が内部で保持する。候補保存時の `origin` は、この内部 read log から付与する。

`wiki_file` の場合:

```ts
readFile({
  fromToken?: number,
  readTokens?: number,
  minify?: boolean
})
```

内部では `target.sourceUri` または `target.targetKey` を固定して `readFileDomain()` を呼ぶ。LLM に path は渡させない。

`vibe_memory` の場合:

```ts
memoryReader({
  fromToken?: number,
  readTokens?: number,
  mode?: "compressed" | "original"
})
```

内部では `target.targetKey` の vibe memory だけを読む。LLM に session ID や別 memory ID は渡させない。

既定値:

- `fromToken = 0`
- `readTokens = 1500`
- `minify = true`
- `mode = "compressed"`

`readFile` / `memoryReader` は部分読みが既定なので、LLM は複数回読む前提にする。

読み方:

- まず `fromToken=0` を読む。
- 候補がありそうなら、必要に応じて `fromToken` を進めて続きを読む。
- 読みながら候補を追加してよい。
- ただし公開 tool は常に 1 種類だけで、target は固定する。
- tool call の戻り値は content だけにする。
- 最大 read 回数と最大 token window は定数で制限する。

## LLM プロンプト方針

LLM への指示は候補選出専用にする。

指示の要点:

- 入力から、後続工程で knowledge 候補として評価する価値がありそうな部分だけを選ぶ。
- best practice、運用ルール、設計判断、失敗回避、実装上の注意を優先する。
- 単なるログ断片、挨拶、作業進捗、検索結果 URL、tool 名だけの断片は候補にしない。
- 確信が薄ければ無理に出さず `NO_CANDIDATE` を返す。
- 評価や根拠説明は書かない。
- 候補選出以外の内容を出力しない。

候補数は固定しない。入力を複数回読み、候補が増えるなら動的に増やしてよい。ただし安全上限は定数で持つ。

## LLM 出力形式

LLM の出力形式は呼び元で切り替える。

CLI text mode:

- LLM には storage mode と同じ最小 JSON を返させる。
- CLI は parse 後の候補リストを人間向け text に整形して stdout に出す。
- 人間が見て妥当性を確認するための経路なので、DB 保存用の parse は必須にしない。

候補あり:

```text
TITLE: Hono backend routes should keep validation close to route boundaries
CONTENT:
Route handlers should validate request bodies at the boundary and pass typed values into services. Repository and service layers should not parse raw HTTP payloads.
---
TITLE: ...
CONTENT:
...
```

候補なし:

```text
NO_CANDIDATE
```

storage mode:

LLM には最小 JSON を返させる。

```json
{
  "candidates": [
    {
      "title": "Hono backend routes should keep validation close to route boundaries",
      "content": "Route handlers should validate request bodies at the boundary and pass typed values into services."
    }
  ]
}
```

候補なし:

```json
{
  "candidates": []
}
```

JSON でも schema はこれ以上増やさない。`type`、`confidence`、`importance`、`reason`、`evidence` は入れない。

storage mode の parse 失敗時は aggressive repair しない。1 回だけ「同じ内容を指定 JSON で返して」と再依頼し、それでも失敗したら `no_candidate_parse_failed` として扱う。

## 出力契約

ドメイン内部の結果は flat に近い形にする。

```ts
type FindCandidateResult = {
  targetStateId: string;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  callerMode: "cli_text" | "storage";
  candidates: Array<{
    title: string;
    content: string;
  }>;
  insertedIds?: string[];
  readRanges: Array<{ from: number; toExclusive: number }>;
};
```

CLI の text mode は人間が見るための出力にする。

```text
# best-practice/hono_backend.md

## Candidate 1
TITLE: ...
CONTENT:
...
```

storage mode は保存結果を JSON で返す。

```json
{
  "targetStateId": "...",
  "candidateCount": 2,
  "candidateIds": ["...", "..."]
}
```

## Table 書き込み

既存の `distillation_candidates` は `type`、`confidence`、`importance` を前提としており、今回の責務より重い。

そのため `findCandidate` 専用に軽い table を追加する。

推奨テーブル: `find_candidate_results`

主要カラム:

- `id`
- `target_state_id`
- `candidate_index`
- `title`
- `content`
- `origin`
- `status`: `selected` / `parse_failed`
- `created_at`
- `updated_at`

この table は次工程 `coverEvidence` の入力になる。`distillation_candidates` への昇格は、候補評価・型判定が入る段階で行う。

候補時点の出自は必ず保存する。

保存する出自:

- `origin.readRanges`

target の identity は `target_state_id` 経由で `distillation_target_states` から参照する。`origin.readRanges` は、複数回の部分読みのうち候補に関係した token window を示す。

これらは LLM に渡す情報ではない。LLM は content だけを見て候補を選ぶ。orchestrator が、実際に読ませた target と read window を候補に後付けする。

この段階では `sourceRefs` という最終 knowledge 用の参照名にはしない。候補 table では `origin` として保存し、`finalizeDistille` で採用 knowledge に昇格するときに `sourceRefs` へ変換する。

保存手順:

1. LLM output を JSON parse する。
2. candidate の順序を `candidate_index` として固定する。
3. 各 candidate を新しい `find_candidate_results.id` で insert する。

重複排除はこの段階では行わない。LLM 出力本文を正規表現で大きく書き換えて重複扱いにしない。

## Provider 切替

既存の distillation provider 設定を使う。

CLI:

```bash
bun run find-candidate -- --provider local-llm
bun run find-candidate -- --provider azure-openai
bun run find-candidate -- --provider bedrock
bun run find-candidate -- --provider auto
```

既定は `groupedConfig.distillation.provider`。`auto` は既存方針どおり local first にする。

実装では `runDistillationCompletion()` 相当を再利用するが、tool set は `findCandidate` 専用に差し替える。旧 distillation の search/fetch/read_source_segment/read_vibe_segment は使わない。

## CLI

追加予定:

- `src/cli/find-candidate.ts`
- package script: `find-candidate`

基本確認:

```bash
bun run find-candidate -- --target-state-id <id>
```

省略時は次の target を preview または claim して使う案があるが、初期実装では明示 `--target-state-id` を推奨する。runner 接続時に claim 済み target を渡す。

text 出力:

```bash
bun run find-candidate -- --target-state-id <id> --provider local-llm
```

table 書き込み:

```bash
bun run find-candidate -- --target-state-id <id> --write --provider local-llm
```

CLI の既定は text mode。`--write` を付けた場合だけ storage mode を使い、JSON parse と DB 保存を行う。

補助:

```bash
bun run find-candidate -- --target-state-id <id> --from-token 1500 --read-tokens 1500
bun run find-candidate -- --target-state-id <id> --reader-mode original
```

`--from-token` は initial read の開始位置を指定する。LLM tool で続き読みも可能だが、CLI で範囲を固定して再現性を取りたい時に使う。

## Runner 連携

runner 側の順序:

1. `selectDistillationTarget` で target を claim する。
2. target phase を `finding_candidate` に更新する。
3. `findCandidate` を呼ぶ。
4. CLI text mode では DB を変えず LLM の候補出力をそのまま表示する。
5. runner / `--write` では storage mode を使い、JSON parse 後に `find_candidate_results` へ保存する。
6. candidate が 0 件なら target を `skipped(no_candidate)` にする。
7. candidate が 1 件以上なら次工程 `coverEvidence` に渡す。

`findCandidate` は target を `completed` にしない。完了判定は最後の `finalizeDistille` まで持ち越す。

## Audit

最低限の audit event:

- `FIND_CANDIDATE_STARTED`
- `FIND_CANDIDATE_READER_USED`
- `FIND_CANDIDATE_COMPLETED`
- `FIND_CANDIDATE_FAILED`

payload は target identity、provider、candidate count、read count、read ranges 程度にする。candidate content の全文は table 側に保存し、audit には長文を入れない。

## 実装フェーズ

### Phase 1: 契約と parser

追加:

- `src/modules/findCandidate/domain.ts`
- `src/modules/findCandidate/parser.ts`

完了条件:

- storage mode の `{ candidates: [{ title, content }] }` だけを parse できる。
- text mode は LLM 出力をそのまま返せる。
- `NO_CANDIDATE` と `{ "candidates": [] }` を 0 件として扱える。
- 複雑な JSON schema や正規表現補正に寄せない。

### Phase 2: reader tool adapter

追加:

- `src/modules/findCandidate/reader-tool.service.ts`

完了条件:

- `wiki_file` では `readFile` だけが使える。
- `vibe_memory` では `memoryReader` だけが使える。
- LLM が path や別 memory ID を指定できない。
- read 回数と token window を制限できる。

### Phase 3: LLM 実行

追加:

- `src/modules/findCandidate/llm.service.ts`

完了条件:

- local-llm / azure-openai / bedrock / auto を CLI から切り替えられる。
- 初期 read と複数回の追加 read tool call を使って候補を返せる。
- caller mode に応じて text output / JSON output を切り替えられる。
- search/fetch/evidence tool は一切公開されない。

### Phase 4: table 保存

追加:

- migration for `find_candidate_results`
- `src/modules/findCandidate/repository.ts`

完了条件:

- text mode は保存しない。
- storage mode は candidate を保存する。
- 保存時は各 candidate に新しい id を割り当てる。
- 同じ target の再実行で候補内容が変わっても既存 `cover_evidence_results` を stale にしない。

### Phase 5: CLI

追加:

- `src/cli/find-candidate.ts`
- `package.json` script: `find-candidate`

完了条件:

- 既定で候補を人間向け text として表示できる。
- `--write` で storage mode に切り替え、table に保存できる。
- `--provider` で Local / Cloud を切り替えられる。

## 最初に避けること

- LLM に target 選択をさせない。
- 複数 target の内容を同時に渡さない。
- Web search / fetch を findCandidate に入れない。
- `confidence`、`importance`、`type` をこの段階で要求しない。
- storage mode でも JSON に候補選出以外の field を増やさない。
- 正規表現で実入力を大きく加工しない。
- parse 失敗を過剰に修復しない。
- 既存の旧 distillation pipeline に無理に接続しない。

## 推奨する最小初期動作

1. `distill-target:status` で pending target を確認する。
2. `distill-target -- claim` で 1 target を claim する。
3. `find-candidate -- --target-state-id <id> --provider local-llm` で候補を見る。
4. 結果が妥当なら `--write` で保存する。
5. candidate 0 件なら runner 側で `skipped(no_candidate)` にする。
