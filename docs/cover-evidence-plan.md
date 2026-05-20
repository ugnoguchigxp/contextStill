# coverEvidence 実装計画（候補単位の evidence coverage 判定）

作成日: 2026-05-19
レビュー更新日: 2026-05-19
対象リポジトリ: `memory-router`

## レビューで直した点

この文書は、`findCandidate` 実装後の現在のコードに合わせて責務境界を整理した版である。

主な修正点:

- `coverEvidence` から `knowledge_items` への draft 作成を外し、`finalizeDistille` の責務に戻した。
- Stage 0 で「成立したら即終了」できる書き方をやめ、重複判定を必須 gate にした。
- rejection と runtime failure を同じ `insufficient` に潰さず、再試行できる失敗を区別した。
- `find_candidate_results.id` を入力の正本にし、`cover_evidence_results` を判定結果の正本にした。
- `search_web` / `fetch_content` の tool event と references を保存要件に入れた。
- 現行 schema の `distillation_candidates` は `wiki_file` 起点を直接表現できないため、互換利用は明示 migration 後に限る方針にした。

## 目的

`findCandidate` が保存した候補 1 件について、後続の `finalizeDistille` が draft knowledge を作ってよい状態かを判定する。

`coverEvidence` が行うこと:

- 元 source / memory の読取範囲に戻って、候補本文が根拠に支えられているか確認する。
- 既存 knowledge との完全重複・近傍重複を判定する。
- 外部仕様、URL、ライブラリ/API、現在性に依存する主張があれば `search_web` / `fetch_content` で補強する。
- `type`、`title`、`body`、`importance`、`confidence` を finalizer に渡せる形へ正規化する。
- 判定 stage、参照、tool event、失敗理由を保存する。

`coverEvidence` が行わないこと:

- target を選ばない。
- 候補を新規抽出しない。
- `knowledge_items` に draft / active を作らない。
- embedding を作らない。
- HITL backlog や promotion backpressure を判断しない。
- LLM 出力を正規表現で大きく補正して成立扱いにしない。

## 現行コード上の前提

参照した現行実装:

- `src/modules/coverEvidence/domain.ts` は scaffold のみ。
- `src/modules/coverEvidence/search-query.service.ts` は検索 query 正規化だけ実装済み。
- `find_candidate_results` は `src/db/schema.ts` に存在し、`findCandidate` の保存先として実装済み。
- `src/modules/findCandidate/repository.ts` は `find_candidate_results.id` を候補行の識別子にする。
- `search_web` / `fetch_content` は `src/modules/distillation/distillation-tools.service.ts` にあり、audit / cache / provider fallback と接続済み。
- `finalizeDistille` は scaffold のみで、draft 作成・backpressure・retry semantics が未確定。

このため、最初の実装では `cover_evidence_results` を正本にし、`distillation_candidates` への互換書き込みは入れない。後で `distillation_candidates` を使うなら、`target_kind=wiki_file` を表現できる schema migration を先に行う。

## ドメイン境界

責務分割:

- `selectDistillationTarget`: 次に処理する target を claim し、phase / heartbeat / retry を管理する。
- `readFile` / `memoryReader`: selected target の本文を読む。
- `findCandidate`: `title` と `content` だけを持つ候補を `find_candidate_results` に保存する。
- `coverEvidence`: 候補の根拠充足、重複、外部 evidence、型・スコアを判定して `cover_evidence_results` に保存する。
- `finalizeDistille`: `knowledge_ready` な `cover_evidence_results` から draft knowledge、source refs、embedding、target 完了状態を保存する。
- runner / worker: 上記を順番に呼び、target phase を `finding_candidate`、`covering_evidence`、`finalizing` と進める。

`coverEvidence` は候補 1 件だけを処理する。複数候補、複数 target を 1 回の判定に混ぜない。

## 入力契約

runner / CLI から受け取る入力:

```ts
type CoverEvidenceInput = {
  id: string;
  provider?: "local-llm" | "azure-openai" | "bedrock" | "auto";
  write?: boolean;
  forceRefreshEvidence?: boolean;
};
```

`id` は `find_candidate_results.id` を指す。そこから読み込む情報:

- `target_state_id`
- `target_kind`: `wiki_file` / `vibe_memory`
- `target_key`
- `source_uri`
- `title`
- `content`
- `origin.readRanges`
- `provider`
- `model`

`target_kind` に応じて、source 再読込の adapter を固定する。

- `wiki_file`: `readFile` を使う。
- `vibe_memory`: `memoryReader` を使う。

LLM に file path、memory ID、別 target の選択をさせない。どの target を読むかは orchestrator が固定する。

## 判定フロー

判定は stage を順に進める。ただし、`knowledge_ready` にする前に dedupe gate は必ず通す。

### Stage 1: load / claim

- `find_candidate_results.id` で候補を取得する。
- `status='selected'` 以外は原則処理しない。
- `cover_evidence_results.id` は `find_candidate_results.id` と同じ値にし、existing row があれば idempotency key として扱う。
- `--write` では running 相当の metadata を保存し、同じ候補を同時に処理しない。

終了条件:

- 対象候補がない: `provider_failed` ではなく caller error。
- 既存 row が terminal status: 既存結果を返す。

### Stage 2: source support

候補の `origin.readRanges` と `target_kind` に基づき、元 source / memory を再読込する。

判定:

- 候補本文が元 source / memory の範囲に支えられている。
- 候補が単なるログ断片、URL、tool 名、作業進捗だけではない。
- rule / procedure として自己完結できるだけの主語、条件、行動、制約がある。

不成立なら `insufficient` にする。理由は `unsupported_by_source`、`not_actionable`、`too_context_dependent` のように短く保存する。

### Stage 3: dedupe

既存 knowledge に対して必ず重複確認する。

使う候補:

- lexical search: `title + body`
- vector search: embedding が利用可能な場合
- scope: `active` と `draft` の両方

判定:

- 文意が同じなら `duplicate`。
- 既存 knowledge とほぼ同じで、差分が運用上の価値を持たないなら `near_duplicate`。
- 近傍でも、repo、適用条件、失敗回避、手順粒度が違うなら継続する。

`duplicate` / `near_duplicate` では、該当 knowledge の `id`、`title`、score、理由を `duplicateRefs` に保存する。

### Stage 4: evidence need classification

元 source だけで足りる候補か、外部 evidence が必要な候補かを分ける。

元 source だけで足りる例:

- ユーザーが明示した運用ルール。
- この repo 固有の実装判断。
- 過去失敗から得た手順で、外部仕様に依存しないもの。

外部 evidence が必要な例:

- ライブラリ/API/CLI の現在仕様。
- URL に含まれる内容。
- 価格、制限、モデル名、provider 挙動など drift しやすい事実。
- Web 上の公開仕様を根拠にした一般化。

source-only で十分かつ dedupe 済みなら `knowledge_ready` にできる。外部 evidence が必要なら Stage 5 に進む。

### Stage 5: web evidence

`search_web` と `fetch_content` を使い、外部主張を補強する。

ルール:

- provider 順は `MEMORY_ROUTER_DISTILLATION_SEARCH_PROVIDERS` に従う。既定は `brave,exa`。
- 実装済み provider は `brave`、`exa`、`duckduckgo` だが、既定にない provider を勝手に追加しない。
- 検索結果 snippet だけを最終根拠にしない。
- 外部主張を採用する場合は、原則 `fetch_content` の成功結果を references に入れる。
- 既存の `distillation_evidence_cache` は使ってよいが、cache hit でも references には元 URL と fetched/cache metadata を残す。
- 失敗した provider と fallback は `toolEvents` と `metadata.providerAttempts` に残す。

補強後に still insufficient なら `insufficient`。tool / provider の一時失敗なら `tool_failed` または `provider_failed` として retry 可能にする。

### Stage 6: optional MCP evidence

`context7` / `deepwiki` は利用可能な場合だけ使う補助 stage にする。

初期実装では hard dependency にしない。使う場合も、Web fetch と同様に references と tool event を保存する。MCP が使えないことだけを理由に source-only 候補を失敗扱いにしない。

### Stage 7: final verdict

最終 status を 1 つに決める。

- `knowledge_ready`: finalizer が draft 化してよい。
- `duplicate`: 既存 knowledge と文意同一。
- `near_duplicate`: 既存 knowledge と近すぎ、差分価値が薄い。
- `insufficient`: 根拠、自己完結性、実用性のいずれかが足りない。
- `parse_failed`: LLM 出力を契約 JSON にできない。
- `tool_failed`: tool 実行や fetch が一時失敗した。
- `provider_failed`: LLM provider 呼び出しが失敗した。

`duplicate`、`near_duplicate`、`insufficient` は業務上の terminal rejection。`parse_failed`、`tool_failed`、`provider_failed` は retry policy の対象にできる。

## 出力契約

`coverEvidence` の machine-readable 出力は JSON 固定にする。

```ts
type CoverEvidenceStatus =
  | "knowledge_ready"
  | "duplicate"
  | "near_duplicate"
  | "insufficient"
  | "parse_failed"
  | "tool_failed"
  | "provider_failed";

type CoverEvidenceStage =
  | "load"
  | "source_support"
  | "dedupe"
  | "evidence_need"
  | "web"
  | "mcp"
  | "final";

type CoverEvidenceReference = {
  kind: "source" | "web" | "context7" | "deepwiki" | "knowledge";
  uri: string;
  locator?: string;
  title?: string;
  note: string;
  evidenceRole: "supports_candidate" | "dedupe_match" | "external_verification";
};

type CoverEvidenceResult = {
  schemaVersion: 1;
  status: CoverEvidenceStatus;
  stage: CoverEvidenceStage;
  candidate:
    | {
        type: "rule" | "procedure";
        title: string;
        body: string;
        importance: number;
        confidence: number;
      }
    | null;
  references: CoverEvidenceReference[];
  duplicateRefs: Array<{
    knowledgeId: string;
    title: string;
    score?: number;
    reason: string;
  }>;
  toolEvents: Array<{
    name: string;
    ok: boolean;
    metadata?: Record<string, unknown>;
    error?: string;
  }>;
  reason: string | null;
};
```

`candidate` は `knowledge_ready` の時だけ必須にする。rejection / failure の場合は `null` でよい。

`importance` と `confidence` は 0-100 の整数として出力する。0-1 scale は受け付けない。後続の normalize に依存して `1` を `100` と解釈させない。

## 保存要件

新規テーブル: `cover_evidence_results`

主要カラム:

- `id`
- `status`
- `stage`
- `type`
- `title`
- `body`
- `importance`
- `confidence`
- `references` jsonb
- `duplicate_refs` jsonb
- `tool_events` jsonb
- `reason`
- `created_at`
- `updated_at`

保存ルール:

- `find_candidate_results` は候補抽出結果として immutable に近く扱い、cover 判定の詳細を押し込まない。
- `cover_evidence_results.id` は `find_candidate_results.id` への FK にし、別の `find_candidate_result_id` カラムは持たない。
- `reason` は terminal / retry 判定を一覧で見分けるための短い machine-readable code として使う。説明文や LLM の本文は入れず、160 文字以下に制限する。
- `knowledge_ready` でも `knowledge_items` には書かない。
- finalizer は `cover_evidence_results.status='knowledge_ready'` だけを draft 化対象にする。
- finalizer 用に、元候補の `origin`、source references、external references を `find_candidate_results` と `cover_evidence_results.references` から参照できるようにする。
- references には長文本文を保存しない。必要なら excerpt は短く切り、locator / URL を残す。

## Provider 戦略

既定 provider は `groupedConfig.distillation.provider` に従う。現在の既定は `local-llm`。

`auto` の方針:

1. `local-llm` を試す。
2. `parse_failed`、`provider_failed`、外部 evidence tool の形式崩れで retry 可能な時だけ cloud provider を試す。
3. `duplicate`、`near_duplicate`、`insufficient` の業務判定は、理由と references が十分なら cloud retry しない。

`azure-openai` 再試行を行う条件:

- JSON 契約を満たせない。
- dedupe 判定に必要な structured output が欠けている。
- local-llm が tool call を返せず、外部 evidence が必須。

コスト最適化のため、source-only で十分な候補まで Web / MCP / cloud retry に広げない。

## CLI 計画

追加:

- `src/cli/cover-evidence.ts`
- `package.json` script: `cover-evidence`

想定コマンド:

```bash
bun run cover-evidence -- --id <find_candidate_results.id>
bun run cover-evidence -- --id <find_candidate_results.id> --write
bun run cover-evidence -- --id <find_candidate_results.id> --provider azure-openai
bun run cover-evidence -- --id <find_candidate_results.id> --force-refresh-evidence
```

動作:

- 既定は dry run。DB には保存せず、同一 core logic の JSON を stdout に出す。
- `--write` は同じ JSON payload を `cover_evidence_results` に保存する。
- dry run と `--write` で system context、判定ロジック、tool policy を変えない。
- `--force-refresh-evidence` は evidence cache を無視して Web fetch を再試行する。

## 実装フェーズ

### Phase 1: schema / repository / parser

追加:

- migration for `cover_evidence_results`
- `src/modules/coverEvidence/repository.ts`
- `src/modules/coverEvidence/parser.ts`

完了条件:

- `cover_evidence_results.id = find_candidate_results.id` で idempotent に保存できる。
- 契約 JSON を parse し、`candidate` nullable と rejection status を扱える。
- `importance` / `confidence` は 0-100 以外を拒否する。

### Phase 2: source support gate

追加:

- `src/modules/coverEvidence/source-support.service.ts`

完了条件:

- `wiki_file` は `readFile`、`vibe_memory` は `memoryReader` だけで元 evidence に戻る。
- `origin.readRanges` を references に変換できる。
- source に支えられない候補を `insufficient` にできる。

### Phase 3: dedupe gate

追加:

- `src/modules/coverEvidence/dedupe.service.ts`

完了条件:

- `active` と `draft` の両方を対象にする。
- duplicate / near_duplicate に knowledge refs と理由が残る。
- dedupe を通らない候補は `knowledge_ready` にならない。

### Phase 4: web evidence gate

追加:

- `src/modules/coverEvidence/evidence.service.ts`

完了条件:

- `search_web` / `fetch_content` を既存 distillation tool 実装経由で使う。
- toolEvents と cache metadata が保存される。
- fetch 成功なしに外部主張を採用しない。
- provider fallback の失敗理由が追跡できる。

### Phase 5: optional MCP evidence

追加:

- `src/modules/coverEvidence/mcp-evidence.service.ts` または後続 plan

完了条件:

- `context7` / `deepwiki` が無い環境でも通常判定が動く。
- MCP を使った場合だけ references に残る。

### Phase 6: CLI / runner 接続

追加:

- `src/cli/cover-evidence.ts`
- runner の `covering_evidence` phase

完了条件:

- dry run と `--write` が同じ判定 payload を使う。
- target は `cover_evidence_results` 保存成功後だけ `finalizing` に進む。
- `parse_failed` / `tool_failed` / `provider_failed` は retry policy に渡せる。

### Phase 7: finalizeDistille handoff

追加:

- `finalizeDistille` 側で `cover_evidence_results` を読み、draft 作成と embedding を行う。

完了条件:

- `knowledge_ready` 以外は draft 化しない。
- draft 作成と embedding 保存が完了するまで target を `completed` にしない。
- 同じ `cover_evidence_result_id` の retry で duplicate knowledge を作らない。

## 受け入れ基準

- 候補 1 件につき `cover_evidence_results` が最大 1 件だけ作られる。
- `knowledge_ready` は `type/title/body/importance/confidence/references` が必ず埋まる。
- `knowledge_ready` でも `knowledge_items` へ直接 insert しない。
- `duplicate` / `near_duplicate` は `duplicateRefs` を必ず持つ。
- `insufficient` は `reason` を必ず持つ。
- 外部主張を採用した場合、`fetch_content` 成功 evidence が references または toolEvents に残る。
- `parse_failed` / `tool_failed` / `provider_failed` は runner が retry 可能な status として扱える。
- dry run と `--write` は同じ core logic を使い、保存有無だけが違う。
- `finalizeDistille` は `cover_evidence_results.status='knowledge_ready'` だけを draft 化する。
- `bun run verify` が通る。DB 変更がある phase では migration と repository integration test も通す。

## 最初に避けること

- `coverEvidence` で draft knowledge を作らない。
- `findCandidate` の軽い候補 table に evaluation 詳細を詰め込まない。
- dedupe 前に `knowledge_ready` を返さない。
- Web 検索 snippet だけを根拠にしない。
- `context7` / `deepwiki` を初期実装の必須依存にしない。
- provider retry を理由なく増やさない。
- score scale を 0-1 と 0-100 で混在させない。
