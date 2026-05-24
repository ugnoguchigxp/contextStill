# Web Source Ingestion Plan

## 目的

ユーザーが提供する URL だけを queue に登録し、distillation pipeline の中で LLM が fetch ツールを使って調査結果 Markdown を作る。その Markdown を `wiki/pages/websource/` 配下に保存し、同じ pipeline 実行内で `findCandidate -> coverEvidence -> finalizeDistille` まで進める。

ユーザー入力から直接 knowledge item を作らない。必ず「URL queue -> LLM fetch 調査 -> Markdown source 保存 -> findCandidate 複数候補保存 -> coverEvidence -> finalize」の順にする。

## ドキュメントレビュー

初回レビュー評点: 7/10。

主な不足:

- `web_ingest` 追加時の DB enum、check constraint、API type、UI type への影響が明記されていない
- URL と保存済み Markdown のどちらを `sources.uri` / `knowledge_source_links` の canonical URI にするかが曖昧
- priority order を settings general から queue claim/order に反映する実装境界が弱い
- duplicate URL、再実行、途中失敗、candidate 単位の部分成功の扱いが弱い
- fetch tool を使う機能として SSRF/private network guard と raw copy 回避が不足している

改善後評点: 9/10。実装前に必要な schema/API/UI/runner 変更点、source link の URI 方針、failure/idempotency/verification を明文化した。残る 1 点は implementation diff と migration 実装時に実コードへ合わせて調整する余地として残す。

## 保存先

実ファイル保存先は次に固定する。

```text
wiki/pages/websource/
```

理由:

- 既存の `readFile.root` は `wiki/pages` を向いている
- 保存後の Markdown は `read_file` で読める
- `findCandidate` / `coverEvidence` / `finalizeDistille` の source evidence 経路を既存 wiki と揃えられる
- DB の `sources.source_kind` は現状 `wiki` 制約なので、Web由来かどうかは `metadata.sourceType = "web_research"` で表現する

## 対象スコープ

この計画で扱うもの:

- 単発 URL 登録
- URL リストの一括登録
- CSV / XLSX からの URL 列抽出
- URL 登録時の queue target 作成
- pipeline 内での LLM fetch 調査
- pipeline 内での調査結果 Markdown 生成と保存
- `sources` / `source_fragments` への upsert
- `findCandidate` による複数 candidate 保存
- `coverEvidence` / `finalizeDistille` までの pipeline 実行
- Web ingest priority の追加
- priority order を settings general から変更できるようにする
- 管理画面 `/sources` での URL 登録導線
- 登録結果、queue status、保存先、candidate 数、finalize 結果の表示

この計画で扱わないもの:

- ユーザーによる title / slug / tags / note 入力
- サーバ側の単純な HTML -> Markdown 変換を source として保存する処理
- URL 入力から直接 `rule` / `procedure` を作る処理
- 新しい knowledge type の追加
- `sources.source_kind = web` の DB 制約変更
- ブックマークレットやブラウザ拡張
- ログインが必要な記事、PDF、動画、動的レンダリング必須ページの完全対応

## 既存構成との接続

現状の有効な接続点:

- `api/modules/sources/sources.routes.ts`
  - Source 画面の URL 登録 API
- `src/modules/selectDistillationTarget/repository.ts`
  - `distillation_target_states` の upsert / claim / requeue
- `src/modules/distillationPipeline/runner.ts`
  - queue target を claim して phase を進める pipeline
- `src/modules/distillation/distillation-runtime.service.ts`
  - LLM 実行と tool calling の既存境界
- `src/modules/distillation/distillation-tools.service.ts`
  - fetch 相当 tool を追加または再利用する候補
- `src/modules/settings/settings.service.ts`
  - Web source research 用 LLM と priority order を既存設定導線で解決する
- `src/modules/sources/wiki/content-repo.ts`
  - `wiki/pages` 配下の Markdown ファイル作成、更新、git commit
- `src/modules/sources/source.repository.ts`
  - `sources` / `source_fragments` の upsert
- `src/modules/findCandidate/domain.ts`
  - `web_ingest` target から保存済み Markdown を読み、複数 candidate を保存する
- `src/modules/coverEvidence/source-support.service.ts`
  - `web_ingest` 由来 candidate の source evidence は元 URL ではなく保存済み Markdown から読む
- `src/modules/coverEvidence/domain.ts`
  - candidate ごとの source support と重複/価値判定
- `src/modules/knowledge/source-linking.service.ts`
  - finalized knowledge の source link を `sources.uri` から解決する
  - `sourceDocumentUri` は保存済み Markdown target key に寄せ、元 URL は metadata に分離する
- `src/modules/finalizeDistille/domain.ts`
  - knowledge 保存と source link 作成
- `src/db/schema.ts`
  - `distillationTargetKindValues` / `distillationTargetPhaseValues` / `distillationTargetPriorityGroupValues` と check constraint を更新する
- `web/src/modules/admin/repositories/admin.repository.ts`
  - queue state type、settings editable type、dashboard 表示を追加する
- `web/src/modules/admin/components/sources.page.tsx`
  - 既存の Source editor 画面

## Queue モデル

Web URL は登録時点で `distillation_target_states` に入れる。Markdown 生成は登録 API では実行しない。

target kind:

```ts
type DistillationTargetKind =
  | "knowledge_candidate"
  | "web_ingest"
  | "wiki_file"
  | "vibe_memory";
```

登録直後の target:

```ts
{
  targetKind: "web_ingest",
  targetKey: "https://example.com/posts/agent-context",
  sourceUri: "https://example.com/posts/agent-context",
  status: "pending",
  phase: "selected",
  priorityGroup: "web_ingest",
  metadata: {
    sourceType: "web_research",
    sourceUrl: "https://example.com/posts/agent-context",
    importedVia: "sources.webIngest",
    registeredAt: "2026-05-24T00:00:00.000Z"
  }
}
```

pipeline が Markdown 保存後に metadata を更新する。

```ts
{
  savedWikiSlug: "websource/example-com/posts-agent-context",
  savedWikiTargetKey: "websource/example-com/posts-agent-context.md",
  savedWikiPath: "/absolute/path/to/wiki/pages/websource/example-com/posts-agent-context.md",
  sourceDocumentUri: "websource/example-com/posts-agent-context.md",
  sourceWebUrl: "https://example.com/posts/agent-context",
  researchGeneratedAt: "2026-05-24T00:00:00.000Z",
  llmProvider: "local-llm",
  llmModel: "..."
}
```

DB/API 変更:

- `distillationTargetKindValues` に `web_ingest` を追加する
- `distillationTargetPhaseValues` に `researching_source` / `writing_source` を追加する
- `distillationTargetPriorityGroupValues` に `web_ingest` を追加する
- queue API filter は `auto | candidate | web | wiki | vibe` を受ける
- admin UI の queue label/filter/badge に `web_ingest` を追加する

## Canonical URI / Source Link 方針

URL と保存済み Markdown path の役割を分ける。ここが曖昧だと `knowledge_source_links` が `sources.uri` を解決できなくなる。

- Queue identity は normalized URL を使う
- `targetKey` と登録直後の `sourceUri` は normalized URL
- 保存済み source document の canonical URI は `websource/<slug>.md`
- `sources.uri` は `websource/<slug>.md`
- candidate metadata の `sourceDocumentUri` は `websource/<slug>.md`
- candidate metadata の `sourceWebUrl` は original URL
- finalized knowledge の source link は `sourceDocumentUri` から `sources.uri` に接続する
- UI は saved Markdown link を primary、original URL を external reference として併記する

この方針により、既存 wiki source reader と source-link resolver を壊さずに外部 URL も追跡できる。

## Priority Order

default priority は次の順にする。

```text
1. knowledge_candidate
2. web_ingest
3. wiki_file
4. vibe_memory
```

意味:

- `knowledge_candidate`: MCP などから明示登録された候補。最優先で処理する
- `web_ingest`: ユーザーが URL として登録した Web source。2 位で処理する
- `wiki_file`: 通常 wiki source。3 位で処理する
- `vibe_memory`: 作業ログ由来。最後に処理する

この順序は settings general で変更可能にする。

設定案:

```ts
type DistillationPrioritySettings = {
  targetPriorityOrder: Array<"knowledge_candidate" | "web_ingest" | "wiki_file" | "vibe_memory">;
};
```

repository の claim query と inventory preview はこの設定を使って order by を組み立てる。設定が壊れている場合は default order に戻す。

実装境界:

- `src/modules/selectDistillationTarget/repository.ts` の hardcoded SQL priority rank を廃止する
- `findNextSelectableDistillationTargetState`、`claimNextDistillationTargetState`、preview API、queue dashboard ordering は同じ priority rank helper を使う
- 設定値に未知の target kind が含まれる場合は無視する
- 設定値から不足している target kind は default order で末尾補完する
- priority order は queue target selection にだけ使い、candidate scoring には使わない

## Settings Model

2 種類の設定を分ける。

- Settings > Task Routing: `webSourceResearch` の LLM route
- Settings > General: distillation target priority order

`webSourceResearch` default:

```ts
type WebSourceResearchRoute = {
  provider: "local-llm";
  model: null;
  fallbacks: [];
};
```

`local-llm` が使えない環境では queue item を retryable failure にする。cloud provider へ勝手に fallback しない。fallback を使う場合はユーザーが Task Routing で明示設定する。

## 基本フロー

### 単発登録

1. 管理画面で URL だけを入力する
2. API が URL を validate する
3. API が `web_ingest` target を `distillation_target_states` に upsert する
4. API は Markdown 生成や LLM fetch を実行せず、queue item を返す
5. pipeline worker が priority に従って `web_ingest` target を claim する
6. pipeline が LLM に URL と調査用 system prompt を渡す
7. LLM が fetch ツールで URL を読み込む
8. LLM が取得内容に基づく調査結果 Markdown を返す
9. pipeline が Markdown frontmatter を付けて `wiki/pages/websource/...md` に保存する
10. pipeline が `upsertSourceDocument({ sourceKind: "wiki", uri: savedWikiTargetKey, ... })` を実行する
11. pipeline が同じ target で `findCandidate` を実行する
12. `findCandidate` が Markdown から複数 candidate を `find_candidate_results` に保存する
13. pipeline が candidate ごとに `coverEvidence` を実行する
14. `knowledge_ready` になった candidate ごとに `finalizeDistille` を実行する
15. target を `completed` / `skipped` / `failed` / `paused` に更新する

### 一括登録

1. 管理画面で URL を複数貼り付ける、または CSV / XLSX を選択する
2. UI が URL だけを抽出して preview する
3. API に URL 配列を送る
4. API が URL ごとに `web_ingest` target を upsert する
5. API は URL ごとの queue item と duplicate / invalid status を返す
6. pipeline worker が priority に従って順次処理する
7. 各 target が単発登録と同じ pipeline を通る

## 入力仕様

ユーザー入力は URL のみ。

単発:

```text
https://example.com/post
```

複数貼り付け:

```text
https://example.com/post-a
https://example.com/post-b
https://example.com/post-c
```

CSV:

```csv
url
https://example.com/post-a
https://example.com/post-b
```

XLSX:

- `url` column があればその列を使う
- `url` column がなければ先頭列から URL を抽出する
- URL 以外の column は無視する

制約:

- `http:` / `https:` のみ許可
- 空行と重複 URL は queue 登録前に除外する
- title、slug、tags、note、source 分類はユーザーに入力させない

## Idempotency / Retry

URL 登録は重複しやすいため、queue identity を明確にする。

- URL normalize は scheme/host の lower-case、default port 除去、fragment 除去、末尾 slash 正規化を行う
- `targetKind + targetKey + distillationVersion` の unique 制約で duplicate を防ぐ
- pending/running の duplicate 登録は既存 queue item を返す
- completed の duplicate 登録は既存結果を返す
- failed/retryable の duplicate 登録は既存 item を再開候補として返す
- 再調査したい場合は既存の requeue 操作を使う
- saved Markdown path は一度決めたら requeue でも維持し、上書き時は frontmatter の `updatedAt` を更新する

## Pipeline Phases

`web_ingest` 用に phase を追加する。

```ts
type DistillationTargetPhase =
  | "selected"
  | "researching_source"
  | "writing_source"
  | "finding_candidate"
  | "covering_evidence"
  | "finalizing"
  | "stored";
```

phase の意味:

- `selected`: queue 登録直後
- `researching_source`: LLM が fetch ツールで URL を読む
- `writing_source`: Markdown を `wiki/pages/websource/` に保存し、source index を更新する
- `finding_candidate`: 保存済み Markdown を `findCandidate` が読む
- `covering_evidence`: candidate ごとに `coverEvidence` を実行する
- `finalizing`: `knowledge_ready` candidate を `finalizeDistille` で保存する
- `stored`: target の処理終了

## Failure Handling

phase ごとの失敗を明確に扱う。

| Phase | 失敗例 | 扱い |
| --- | --- | --- |
| register | URL parse failed / unsupported scheme | API は 400、batch import は row-level skipped |
| researching_source | fetch timeout / fetch tool unavailable / blocked private address | retryable failure、reason を metadata に保存 |
| writing_source | Markdown が空 / frontmatter 不正 / file write failed | retryable failure、saved path 未確定なら再生成 |
| finding_candidate | 候補なし | `completed` with `candidatesCreated=0`、failure にはしない |
| covering_evidence | candidate ごとの evidence 不足 | candidate 単位で rejected / needs_more_evidence、target 全体は続行 |
| finalizing | finalize failed | candidate 単位で retryable、target は partial state を保持 |

batch import は全体 rollback ではなく row-level result を返す。

## LLM 調査 Markdown

保存される Markdown は「元記事の機械的なHTML変換」ではなく、「fetchした内容をLLMが読んだ調査結果」にする。

保存形式:

```md
---
title: "..."
sourceType: "web_research"
sourceUrl: "https://example.com/article"
fetchedAt: "2026-05-24T00:00:00.000Z"
researchGeneratedAt: "2026-05-24T00:00:00.000Z"
showOnMenu: false
showOnHome: false
---

# ...

Source URL: https://example.com/article

## Summary

...

## Reusable Signals

...

## Notes

...
```

方針:

- `showOnMenu` / `showOnHome` は default false にする
- 元 URL は frontmatter と本文の両方に残す
- LLM は fetch で読めた範囲だけから書く
- LLM は `rule` / `procedure` の最終 JSON を返さない
- Markdown は後段の `findCandidate` が読む source として扱う
- ツール呼び出し JSON や prompt 文言を Markdown 本文に混ぜない
- 取得に失敗した URL はファイルを作らず、target を paused / failed にする
- 同じ URL の再登録は default で既存 `web_ingest` target/result を返す。再調査する場合は明示的な requeue 操作で既存 `websource` Markdown を更新する

## LLM Provider

Web source research 用 prompt は `findCandidate` とは別にする。

LLM provider は既存の task routing と同じくユーザーが設定画面で変更できるようにする。初期値は `local-llm` とし、model / fallback も settings の task routing から解決する。

必須条件:

- 対象 URL を fetch ツールで読む
- fetch 結果に含まれる内容だけを根拠に Markdown を作る
- 記事全体の要約だけでなく、後続の `findCandidate` が拾いやすい再利用可能な signal を書く
- `rule` / `procedure` 候補そのものの確定はしない
- 不明点、取得失敗、paywall、JS必須などは Markdown 内に status として残す

出力は Markdown のみ。

## Slug 設計

保存 slug は必ず `websource/` prefix を付ける。ユーザーは slug を指定しない。

優先順位:

1. LLM 調査結果 title から slug 生成
2. URL host + pathname から slug 生成
3. URL hash suffix を足して衝突回避

例:

```text
https://example.com/posts/agent-context
-> websource/example-com/posts-agent-context.md
```

衝突時:

- 同じ URL なら既存ファイル更新
- 異なる URL で同じ slug なら `-2`, `-3` などを suffix する

## Fetch Tool 境界

サーバ側が URL を直接 HTML -> Markdown 化して保存するのではなく、LLM runtime の tool calling として fetch を実行する。

実装方針:

- tool 名は既存 `coverEvidence` 系の web fetch/search tool と揃える
- fetch tool は URL validation、timeout、body size 上限、content-type 制限を持つ
- tool result は LLM に返し、最終保存対象は LLM が生成した Markdown に限定する
- tool result の raw HTML / raw text は `wiki/pages/websource/` に直接保存しない
- pipeline は fetch tool 使用有無を validation し、未使用なら retryable failure とする

Fetch 制約:

- timeout を設定する
- redirect は fetch default に任せるが、最終 URL を metadata に残す
- content-type が HTML / text / markdown 以外なら失敗扱いにする
- body size 上限を設ける
- localhost、private network、link-local、metadata service への fetch はブロックする
- redirect 後の URL も同じ guard を通す
- raw HTML / raw text の長文引用は保存しない

## findCandidate 接続

`web_ingest` target の `findCandidate` は保存済み Markdown を読む。

入力解決:

- `target.targetKind === "web_ingest"` の場合、`target.metadata.savedWikiTargetKey` を `read_file` path として使う
- Markdown が未保存なら `findCandidate` へ進めず、target を failed / paused にする
- candidate origin の `sourceDocumentUri` は保存済み Markdown target key にする
- 元 URL は `sourceWebUrl` / `originalUrl` metadata として保持する

候補保存:

- `findCandidate` は wiki と同じく複数 candidate を返せる
- 返された配列の各要素を `find_candidate_results` に保存する
- candidate ごとの `candidateIndex` を維持する
- 後続の `coverEvidence` / `finalizeDistille` は candidate 単位で実行する

`runFindCandidate` は現在 `wiki_file | vibe_memory` 前提の箇所があるため、`web_ingest` を正式な source kind として追加する。実装上の互換層が必要な場合も、candidate と finalized knowledge の canonical source URI は saved Markdown path に固定する。

## API 設計

### `POST /api/sources/web`

単発 URL を queue に登録する。

Request:

```ts
type WebSourceCreateRequest = {
  url: string;
};
```

Response:

```ts
type WebSourceCreateResponse = {
  ok: true;
  item: WebSourceQueueResult;
};
```

### `POST /api/sources/web/bulk`

URL 配列を queue に一括登録する。CSV / XLSX の解析は UI 側で行い、API には URL だけ送る。

Request:

```ts
type WebSourceBulkRequest = {
  urls: string[];
};
```

Response:

```ts
type WebSourceBulkResponse = {
  ok: true;
  total: number;
  queued: number;
  skipped: number;
  items: WebSourceQueueResult[];
};
```

登録 API は LLM fetch 調査を実行しない。pipeline worker が queue item を claim した時点で調査と Markdown 保存を行う。

XLSX 対応は既存 dependency を確認してから決める。新規 dependency が必要な場合は実装時に理由を明記する。CSV は dependency なしで先に対応できる。

## UI 設計

`SourcesPage` に Web Source パネルを追加する。

単発登録:

- URL input
- queue button

一括登録:

- 複数 URL textarea
- `.csv`, `.xlsx` file input
- URL preview table
- queue selected / queue all
- row status 表示

画面更新:

- queue 登録後に queue / overview 系 query を invalidate
- pipeline が Markdown を保存した後に `page-tree`, `search`, `history` を invalidate
- 直近に保存された `websource/...` slug を選択できるようにする
- 登録結果から queue target、phase、candidate 数、finalize 結果を表示する

Settings:

- Settings > General に target priority order editor を追加する
- Settings > Task Routing に `Web Source Research` route を追加する
- Web Source Research の default provider は `local-llm`

## 実装ステップ

1. DB / schema / migration
   - `distillationTargetKindValues` に `web_ingest` を追加する
   - `distillationTargetPhaseValues` に `researching_source` / `writing_source` を追加する
   - `distillationTargetPriorityGroupValues` に `web_ingest` を追加する
   - check constraint と migration を更新する
2. Settings
   - `RuntimeSettingsEditable.taskRouting.webSourceResearch` を追加する
   - default route を `local-llm` にする
   - Settings > General に `distillationPriority.targetPriorityOrder` を追加する
   - invalid/missing priority order の補完 helper を追加する
3. Queue repository / runner
   - `web_ingest` claim/filter/preview/count を追加する
   - SQL の hardcoded priority order を settings-driven helper に置き換える
   - CLI/API kind filter に `web` を追加する
   - phase transition と retryable failure を追加する
4. Source storage
   - `wiki/pages/websource/` を ensure する
   - slug と saved path を決定する
   - frontmatter 付き Markdown writer を追加する
   - source repository に saved Markdown を upsert する
5. Fetch research agent
   - URL を fetch tool で読む task を追加する
   - SSRF/private network guard を追加する
   - raw dump ではなく調査 Markdown を生成する prompt を追加する
   - provider route は `webSourceResearch` を使う
6. Candidate pipeline integration
   - saved Markdown を source document として `findCandidate` に渡す
   - 複数 candidate を `knowledge_candidate` として保存する
   - candidate metadata に `sourceDocumentUri=savedWikiTargetKey` と `sourceWebUrl=url` を入れる
7. Evidence/finalize integration
   - `coverEvidence` source-support が saved Markdown を読めるようにする
   - finalized knowledge の source link が saved path で解決されることを保証する
   - candidate-wise partial success を維持する
8. API
   - single URL 登録を追加する
   - bulk URL 登録を追加する
   - CSV import を追加する
   - XLSX import は dependency 方針を確定してから追加する
   - status/duplicates/skipped rows を返す
9. Admin UI
   - single URL form を追加する
   - bulk textarea を追加する
   - CSV/XLSX upload UI を追加する
   - queue status/filter/badge を追加する
   - Settings > General に priority order を追加する
   - Settings > Task Routing に Web Source Research route を追加する
10. Verification
    - unit tests を追加する
    - queue integration tests を追加する
    - source-link resolution tests を追加する
    - UI smoke を追加する
    - `bunx vitest run` の対象テストと `bun run build:web` で確認する

## テスト計画

Unit:

- URL validation
- URL list dedupe
- `web_ingest` target upsert
- priority order default が `knowledge_candidate > web_ingest > wiki_file > vibe_memory` になる
- priority order が settings general から反映される
- Web source research route の default が `local-llm` になる
- slug 生成
- LLM Markdown 出力の最低限 validation
- duplicate URL の existing response / explicit requeue 判定
- CSV / XLSX URL 抽出
- private / localhost / metadata service URL block
- saved path canonical URI 生成
- priority order の invalid value 補完

Pipeline:

- `web_ingest` target が `researching_source` で LLM fetch tool を使う
- Markdown 保存後に `writing_source` で `sources` / `source_fragments` が更新される
- 保存済み Markdown から `findCandidate` が複数 candidate を保存する
- candidate ごとに `coverEvidence` が実行される
- `knowledge_ready` candidate ごとに `finalizeDistille` が実行される
- 一部 candidate が rejected でも ready candidate が finalize される
- runtime settings priority order が queue claim order に反映される
- finalized knowledge の source link が saved Markdown path で解決される
- original URL が metadata と UI 表示に残る
- fetch failure が retryable として reason を保存する
- candidate なしは failed ではなく completed/skipped として扱う

API:

- `POST /api/sources/web` が LLM を呼ばず `web_ingest` target を作る
- `POST /api/sources/web/bulk` が部分成功を返す
- duplicate URL の扱いが deterministic である
- unsupported/private URL が deterministic に拒否される
- queue filter `web` が `web_ingest` だけを返す

Frontend:

- admin repository が `/api/sources/web` / `/api/sources/web/bulk` を URL-only payload で呼ぶ
- Sources page で単発URL登録フォームが queue 登録できる
- textarea / CSV / XLSX preview が URL 配列を生成する
- settings page で priority order と Web source research provider を編集できる

Manual:

```bash
bunx vitest run test/admin/repositories.test.ts test/source-web-queue.test.ts test/source-web-research.test.ts test/distillation-pipeline.test.ts
bun run build:web
```

必要なら後段で:

```bash
bun run distill:pipeline:once
```

## リスクと対策

| リスク | 対策 |
| --- | --- |
| URL登録時に重いLLM処理が走る | 登録APIは queue 作成だけにし、pipeline worker に処理を寄せる |
| Web source research だけ設定導線から外れる | 既存 task routing に項目を追加し、default を `local-llm` に固定する |
| priority がコード固定になり運用変更できない | settings general に target priority order を持たせる |
| LLM が fetch せずに推測で書く | prompt と runtime validation で fetch tool 使用を必須にする |
| ツール呼び出し JSON が Markdown に混ざる | LLM 出力 validation で Markdown body のみ保存する |
| 調査結果が要約だけになり findCandidate が拾いにくい | `Reusable Signals` section を prompt で要求する |
| 複数 candidate の一部失敗で target 全体が止まる | wiki と同じく candidate 単位で cover/finalize し、ready candidate は保存する |
| 著作権的に全文転載になりすぎる | raw article 保存ではなく調査結果Markdownを保存し、必要最小限の引用に留める |
| 同じ URL の重複登録 | `sourceUrl` metadata で既存 `web_ingest` target と `websource` ページを探し、default は既存結果を返し、明示 requeue 時だけ更新する |
| XLSX dependency が増える | 実装時に UI 側だけで使うか、server 側に寄せるかを決めて依存範囲を限定する |
| `source_kind = web` を増やして既存制約にぶつかる | 初期実装は `sourceKind: "wiki"` + `metadata.sourceType: "web_research"` に固定する |
| source link が外部 URL を指して解決不能になる | saved Markdown target key を canonical `sourceDocumentUri` にする |
| SSRF / private network fetch | scheme/IP/redirect guard を fetch 前に通す |
| priority settings が壊れて queue が止まる | unknown を無視し、不足分を default order で補完する |
| `local-llm` unavailable 時に意図せず cloud fallback する | default fallback は空にし、retryable failure として表示する |

## 受け入れ条件

- 単発 URL 登録の入力項目が URL のみである
- URL 登録時には LLM fetch や Markdown 保存を行わず、`web_ingest` queue target が作成される
- priority default が `knowledge_candidate > web_ingest > wiki_file > vibe_memory` である
- priority order が settings general から変更できる
- Web source research 用 LLM が settings から変更でき、初期値は `local-llm` である
- pipeline が `web_ingest` target で LLM fetch tool を使う
- LLM の調査結果 Markdown が `wiki/pages/websource/*.md` に作成される
- 作成されたページが Source Explorer に表示される
- `sources` / `source_fragments` に保存される
- `findCandidate` が保存済み Markdown から複数 candidate を保存できる
- candidate ごとに `coverEvidence` と `finalizeDistille` が実行される
- 複数 URL、CSV、XLSX から URL だけを抽出して queue 登録できる
- finalized knowledge の source link が saved Markdown path で解決でき、元 URL も metadata/UI で確認できる
- duplicate URL 登録は不要な二重実行をせず、既存 queue item/result を返す
- localhost/private network URL は登録または実行時に拒否される
- `web` queue filter と queue badge が `web_ingest` を正しく扱う
- 実装時の検証コマンドが通る
