# 蒸留安定化: 部分読み・コンテキスト圧縮・再開可能化 実装計画

ステータス: 実装反映版

作成日: 2026-05-17

対象リポジトリ: memory-router

この計画は、Wiki の Markdown ファイルや vibe memory のような大きい入力を、LLM に一度で読ませる前提から脱却し、蒸留を小さく進められる処理に変えるための実装計画である。2026-05-17 時点の初期実装では、source/wiki の manual run に Agentic Reader を導入し、自動実行と vibe memory では既定無効にしている。

主目的は、知識候補の品質を上げることだけではない。現在目立っている `llm_timeout`、`llm_empty_response`、長文 source への偏り、失敗時に途中状態が分かりにくい問題を減らし、Doctor で「止まっているのか、読んでいるのか、検証しているのか」が分かるようにする。

## 方針

部分読み、コンテキスト圧縮、再開可能な queue、失敗種別ごとの retry、local-llm circuit breaker、Web evidence cache、HITL backpressure を実装する。

Cheap Prefilter は実装しない。安いルールで候補になりそうなものを選別すると、価値の低いものだけが残ったり、LLM が見る前に重要な材料を落とす危険があるためである。優先順位のための機械的な除外も、この計画の対象外にする。

Document Outline Cache も実装しない。事前に LLM で outline や summary を作ると、候補抽出前の導線が長くなり、蒸留自体より前処理が重くなる。LLM を使わずに作る outline は、価値判断に使うには信頼しにくい。したがって、事前 summary や document outline を cache して選別に使う設計は採らない。

ただし、部分読みのための locator、文字数、heading 名、file path、diff entry ID のような構造メタデータは使う。これは要約でも価値判断でもなく、読み取り位置を指定するための住所情報である。

local-llm 側にはドメインロジックを入れない。local-llm は queue、timeout、health、concurrency、abort などの実行基盤に留める。Wiki や vibe memory の読み方、候補の証跡、Knowledge 化の判断は memoryRouter 側の責務である。

## 現状の問題

現行の source/wiki 蒸留は `source_fragments` を入力単位にしているが、fragment 自体が大きい場合、候補抽出や検証のプロンプトが重くなる。特に BLE 系の長い設計文書では、timeout や empty response が集中している。

vibe memory は、会話本文と agent diff entries が合わさるため、1 件の memory でも入力が膨らみやすい。会話、判断、コマンド、エラー、diff hunk が混ざるため、LLM が一度に読むと、候補化すべき箇所と単なる作業ログの区別が不安定になる。

また、現行の run record は結果の集約には使えるが、処理中にどこまで読んだか、どの候補を検証中か、どの失敗が再試行可能かを十分に表現できない。timeout や provider error が起きると、次回に同じ重い入力を再度投げやすい。

## 目標

蒸留を「大きい入力を一度で LLM に読ませる処理」から、「LLM が必要な箇所を少しずつ読み、予算内で候補化と検証を進める処理」に変える。

LLM には、読む順番と追加読みの必要性を判断させる。ただし、読み込み予算、最大回数、停止条件、証跡保存、再試行方針は memoryRouter が管理する。

候補なしは正常な結果として扱う。候補なしと、LLM/runtime/tool/evidence の失敗は明確に分ける。

Knowledge の根拠は、圧縮文や作業メモではなく、必ず元 source locator または vibe memory / diff entry locator に戻せるようにする。

## 非目標

Cheap Prefilter による事前選別は行わない。

Document Outline Cache による事前 outline / summary 作成は行わない。

全文 summary を作って、それを source の代わりに Knowledge 根拠として使うことはしない。

local-llm に Wiki / vibe memory / Knowledge 化の判断を持たせない。

失敗を隠すために failed run を成功扱いへ書き換えない。

HITL を迂回して draft を active に自動昇格しない。

## 採用した初期設定

Agentic Reader は、source/wiki の manual run だけで有効にする。CLI は `bun run distill:sources -- --agentic-reader` を受け付けるが、自動 LaunchAgent はこの option を渡さない。vibe memory の Agentic Reader も既定では無効にする。

HITL backpressure は、draft backlog が閾値を超えたら新規 draft promotion を止める。候補抽出と検証は継続し、verified candidate を候補テーブルに残して次回再開できるようにする。importance が高い候補だけを例外的に通す分岐は初期実装に入れない。

context compression は永続テーブルに保存しない。読んだ segment の内容は LLM session 内の working context としてだけ使い、永続化するのは read event の locator、hash、文字数、truncated flag、metadata に限定する。`distillation_context_notes` は追加しない。

Web evidence cache の TTL は 7 日を初期値にする。設定名は `MEMORY_ROUTER_DISTILLATION_EVIDENCE_CACHE_TTL_SECONDS` である。

Circuit breaker が開いた場合は、即時 retry しない。対象 job は paused にし、next retry time を設定して次回 interval で再開する。

## 全体アーキテクチャ

新しい蒸留は、次の段階に分ける。

1. 対象 subject を job として登録する。
2. LLM に最小の source brief を渡す。
3. LLM が必要な locator を指定して部分読みする。
4. 読んだ内容を working context として圧縮する。
5. session 内の working context と必要な元 locator から候補を作る。
6. 候補ごとに必要な部分だけ再読込する。
7. Web search / fetch で外部証跡を取る。
8. 候補を verified / rejected / failed / no_candidate に分類する。
9. verified candidate を draft knowledge へ promotion する。ただし HITL backlog が高い場合は promotion を抑制できる。

この流れは一回のプロセスで完走しなくてよい。job と candidate の状態を保存し、次回起動時に途中から再開する。

## データモデル

既存の `vibe_memory_distillation_runs`、`source_distillation_runs`、`distillation_candidates` は維持する。これらは Doctor や既存 UI との互換性があるため、置き換えない。

新規に `distillation_jobs` を追加する。

`distillation_jobs` は、蒸留対象 subject の再開可能な作業単位である。source kind、subject ID、prompt version、input hash、phase、status、attempt count、budget、last error、next retry time、metadata を持つ。

phase は、pending、reading、extracting、verifying、promoting、completed のような大まかな状態だけにする。細かい判断を増やしすぎない。

status は、queued、running、paused、completed、skipped、failed のような運用状態を持つ。

新規に `distillation_read_events` を追加する。

`distillation_read_events` は、LLM がどの locator を、どの目的で読んだかを保存する。source kind、subject ID、job ID、candidate ID、locator、read reason、content hash、char count、createdAt を持つ。本文の丸ごと保存は避け、必要なら短い excerpt と hash に留める。

新規に `distillation_evidence_cache` を追加する。

`distillation_evidence_cache` は Web search / fetch の再利用用 cache である。query、url、content hash、ok、fetchedAt、short excerpt、metadata を持つ。cache は検証補助であり、最終的な source link とは別に扱う。

既存の `distillation_candidates` には、必要なら metadata の中に job ID、read budget consumed、verification budget consumed、retry policy を保存する。カラムを増やしすぎず、まずは既存 metadata を活用する。

## スキーマ詳細

初期実装で追加するテーブルは `distillation_jobs`、`distillation_read_events`、`distillation_evidence_cache` である。context compression 用の永続テーブルは追加しない。

`distillation_jobs` の推奨カラムは、id、source_kind、vibe_memory_id、source_fragment_id、prompt_version、input_hash、status、phase、attempt_count、budget、budget_used、last_error、last_outcome_kind、next_retry_at、locked_by、locked_at、metadata、created_at、updated_at である。

source kind は `vibe_memory` または `source_fragment` である。vibe memory ID と source fragment ID はどちらか一方だけを持つ。これは既存 `distillation_candidates` の source ref 制約と揃える。

status は `queued`、`running`、`paused`、`completed`、`skipped`、`failed` にする。

phase は `pending`、`reading`、`extracting`、`verifying`、`promoting`、`completed` にする。

`budget` と `budget_used` は jsonb にする。初期実装ではカラムを細かく分けず、read count、read chars、LLM calls、search count、fetch count、startedAt のような値を入れる。

`distillation_read_events` のカラムは、id、job_id、candidate_id、source_kind、vibe_memory_id、source_fragment_id、locator、purpose、content_hash、char_count、truncated、metadata、created_at である。

`distillation_evidence_cache` のカラムは、id、tool_name、query_hash、query_text、url、content_hash、ok、excerpt、metadata、fetched_at、created_at、updated_at である。

migration は `drizzle/0018_distillation_jobs_reader_cache.sql` にまとめた。壊れた再ベース migration を避けるため、既存テーブルの `CREATE TABLE` が再生成されていないことを確認してから migrate する。

## 実装対象ファイル

Phase 1 では、DB schema、job repository、CLI、Doctor を触る。

対象は `src/db/schema.ts`、`src/modules/distillation/distillation-job.repository.ts`、`src/modules/distillation/distillation-job.service.ts`、`src/cli/distill-vibe-memory.ts`、`src/cli/distill-sources.ts`、`src/modules/doctor/inspectors/distillation-run.inspector.ts`、`web/src/modules/admin/components/doctor.page.tsx`、関連 test である。

Phase 2 では、部分読み service と internal tool を追加する。

対象は `src/modules/distillation/distillation-reader.service.ts`、`src/modules/distillation/distillation-tools.service.ts`、`src/modules/sources/distillation.service.ts`、`src/modules/vibe-memory/distillation.service.ts`、関連 test である。

Phase 3 では、Agentic Reader session と session 内 working context を追加する。

対象は `src/modules/distillation/distillation-sessions.ts`、`src/modules/distillation/distillation-prompts.ts`、`src/modules/distillation/distillation-candidate-workflow.ts`、関連 test である。

Phase 4 では、retry policy と adaptive shrink を追加する。

対象は `src/modules/distillation/distillation-outcomes.ts`、`src/modules/distillation/distillation-candidate-workflow.ts`、`src/modules/sources/distillation.repository.ts`、`src/modules/vibe-memory/distillation.repository.ts`、関連 test である。

Phase 5 では、local-llm circuit breaker を追加する。

対象は `src/modules/distillation/distillation-runtime.service.ts`、`src/modules/llm/agentic-llm.service.ts`、`src/modules/doctor/inspectors/distillation-run.inspector.ts`、関連 test である。

Phase 6 では、Web evidence cache を追加する。

対象は `src/modules/distillation/distillation-tools.service.ts`、新規 repository、audit log service、関連 test である。

Phase 7 では、HITL backpressure を追加する。

対象は `src/modules/knowledge/knowledge.repository.ts`、`src/modules/distillation/distillation-candidate-workflow.ts`、Doctor inspector、UI、関連 test である。

## 設定と Feature Flag

新しい reader は feature flag で有効化する。

採用した環境変数は、`MEMORY_ROUTER_SOURCE_DISTILLATION_AGENTIC_READER_MANUAL_ENABLED`、`MEMORY_ROUTER_SOURCE_DISTILLATION_AGENTIC_READER_AUTO_ENABLED`、`MEMORY_ROUTER_VIBE_DISTILLATION_AGENTIC_READER_MANUAL_ENABLED` である。

初期値は、source/wiki manual が true、source/wiki auto が false、vibe memory manual が false である。manual controlled run では CLI option `--agentic-reader` で明示的に有効化する。

reader budget 設定は、`MEMORY_ROUTER_DISTILLATION_READER_MAX_READS` と `MEMORY_ROUTER_DISTILLATION_READER_MAX_CHARS_PER_READ` である。初期値は最大 8 read、1 read あたり 6000 文字である。

HITL backpressure は `MEMORY_ROUTER_DISTILLATION_PROMOTION_BACKLOG_THRESHOLD_COUNT` で制御する。初期値は 50 draft である。

Web evidence cache TTL は `MEMORY_ROUTER_DISTILLATION_EVIDENCE_CACHE_TTL_SECONDS` にする。

circuit breaker は `MEMORY_ROUTER_DISTILLATION_CIRCUIT_BREAKER_ENABLED`、`MEMORY_ROUTER_DISTILLATION_CIRCUIT_BREAKER_HEALTH_TIMEOUT_MS`、`MEMORY_ROUTER_DISTILLATION_CIRCUIT_BREAKER_PAUSE_SECONDS` で制御する。

## 既存 workflow への接続

Phase 1 では、既存の候補抽出と検証は変えない。CLI が対象 subject を選んだ後、job を作成または claim し、既存 workflow の開始前後で job status と phase を更新する。

Phase 2 では、部分読み tool を実装しても、既定では既存 workflow を使う。`--agentic-reader` または feature flag が有効な場合だけ reader 経由にする。

Phase 3 では、reader 経由で得た working context を既存の candidate parser と candidate table に流す。候補 parser を置き換えない。

Phase 4 以降では、既存 run table への結果保存は維持する。Doctor で過去 run と新 job の状態を両方見られるようにする。

## 実装前チェックリスト

実装者は、Phase 1 着手前に次を確認する。

現在の worktree が dirty である場合、既存変更を巻き戻さない。

distillation LaunchAgent が running の場合、DB migration 前に実行中 job がないか確認する。

`bun run db:migrate` が現在の DB に対して成功することを確認する。

`drizzle/meta/_journal.json` に不要な再ベース migration が入っていないことを確認する。

`bun run doctor` で現状の baseline を記録する。

local-llm が running の場合でも、テストは mock を優先し、live local-llm に依存しない。

## 部分読み

部分読みは、LLM が source 全体を直接読む代わりに、必要な locator だけを要求できる仕組みである。

Wiki では、既存の `source_fragments` を最初の読み取り単位として使う。fragment が大きい場合は、実行時に Markdown の heading、paragraph、code fence、list block のような境界でさらに slice する。

この slice は cache された outline ではない。価値判断も要約もしない。単に「この fragment のこの範囲を読める」という住所を作るだけである。

vibe memory では、memory 本文、user message、assistant response、command output、error output、agent diff entry、file path、diff hunk を読み取り単位にする。ここでも、選別はしない。LLM が必要な部分を指定して読む。

部分読み tool は、蒸留 runtime 内部の tool として実装する。public MCP tool として露出させる必要はない。

想定 tool は `read_source_segment` と `read_vibe_segment` である。

tool input は厳密 JSON を要求しすぎない。LLM には locator 名または segment ID を指定させる。壊れた tool call 風出力は現行の tool parser の範囲で扱う。

返す内容は、locator、heading または label、content excerpt、char count、content hash、truncated flag に限定する。返却文字数は budget 内で切る。

## Agentic Reader

Agentic Reader は、LLM が読む場所と追加読みの有無を決める蒸留セッションである。

最初に渡すのは source brief だけにする。source brief は summary ではない。subject ID、source kind、title、URI、locator 一覧の一部、文字数、diff entry 数、既知の createdAt など、読み取りに必要な最小情報だけを含める。

LLM は次のいずれかを選ぶ。

読むべき locator を要求する。

候補なしとして終了する。

十分な材料があるとして候補を出す。

候補は、現行と同じく rule または procedure に限定する。

LLM には「具体的な仮説なしに広く読むより、候補なしで停止する」ことを System context で指示する。これにより、無目的な読み続けを避ける。

読み込み回数、読み込み文字数、LLM call 数、Web search 数、fetch 数は memoryRouter が強制する。LLM は上限を超えて読めない。

## コンテキスト圧縮

コンテキスト圧縮は、事前 summary ではなく、読んだ material を同じ LLM session 内の次 step に渡すための working memory として行う。

圧縮対象は、LLM が実際に読んだ segment だけである。まだ読んでいない文書全体を要約しない。

圧縮結果には必ず source locator を残す。例えば、`source: chunk:0014#paragraph:3` や `vibe:diff-entry:<id>` のように、元の証跡へ戻れる形にする。

圧縮文だけを Knowledge の根拠にしてはいけない。promotion 時は、圧縮文に紐づく元 locator を使って evidence を作る。

圧縮の目的は、次の LLM call の入力を短くすることである。候補の採否や信頼度を圧縮文だけで決めない。

圧縮は一段階に留める。圧縮済みメモをさらに圧縮する多段 summary は、情報の劣化が見えづらくなるため実装しない。

圧縮メモは DB に保存しない。永続化するのは、どの locator を読んだかを表す `distillation_read_events` だけである。

## 予算制御

各 job は budget を持つ。

初期値の案は次の通りである。

segment read は最大 4 回。

segment read の 1 回あたり返却文字数は最大 6000 文字。

extraction LLM call は最大 3 回。

verification LLM call は候補ごとに最大 2 回。

Web search は候補ごとに最大 3 回。

fetch は候補ごとに最大 2 回。

LLM request の壁時計時間は 5 分を既定上限にする。

この値は config で変更可能にする。ただし、最初から細かい phase 別設定を増やしすぎない。まずは共通 budget と、source/vibe の上書きだけにする。

予算を使い切った場合は、failed ではなく `budget_exhausted` として分類する。候補が弱いままなら rejected、まだ判断できないなら retryable paused にする。

## 再開可能 queue

CLI は subject を直接処理するだけでなく、`distillation_jobs` を claim して進める。

job claim は DB 上で行う。status が queued または retryable paused の job だけを running にする。

job が running のまま一定時間を超えた場合は stale とみなす。ただし process lock の pid が生きている場合は、勝手に failed にしない。

timeout や provider crash のような transient failure は、subject 個別の failed を増やす前に job を paused に戻す。

candidate 抽出後に失敗した場合は、次回は抽出からやり直さず、保存済み candidate の検証から再開する。

verification の途中で失敗した場合は、candidate status と read events を見て、同じ locator を再読込しすぎないようにする。

## 失敗種別ごとの retry

`no_candidate` と `verification_no_candidate` は基本的に retry しない。source が更新された場合だけ再対象にする。

`llm_timeout` は同じ入力で再試行しない。次回は read budget を小さくする、候補数を減らす、候補周辺 locator だけ読む、Web evidence を先に cache から使う、のいずれかに切り替える。

`llm_empty_response` は 1 回だけ短い final-answer reminder で再要求する。それでも空なら paused または failed にする。

`llm_provider_error` は local-llm health を確認する。provider が不健康なら subject failed ではなく batch paused にする。

`missing_external_evidence` は、同じ検索 query を繰り返さない。query を候補 title / body / source keyword から 1 回だけ変えて再試行する。それでも evidence がなければ rejected または skipped にする。

`missing_verification_tool_evidence` は、候補の verified 扱いを取り消し、verification へ戻す。ただし同じ candidate に対して無限に戻さない。

## Local-LLM Circuit Breaker

蒸留 batch 開始前に local-llm の health を確認する。

health が unreachable、loaded false、ready false、workerAlive false の場合は batch を開始しない。subject 個別の failed も増やさない。

batch 中に health の failedCount が増えた、daemon restart を検知した、または probe が abort された場合は、現在の subject を provider transient として pause する。

local-llm の `inFlight` が長時間変化しない場合は、Doctor に runtime stuck として表示する。

Circuit breaker の目的は、実行基盤の問題を Knowledge 化失敗として記録しないことである。

## Web Evidence Cache

Web search と fetch の結果は、候補検証で再利用できるように cache する。

cache key は、正規化 query、URL、content hash を組み合わせる。

fetch content を丸ごと Knowledge に保存しない。cache に保存する本文は短い excerpt と hash に留める。

同じ候補や近い候補で同じ URL を読む場合、freshness が不要なら cache を使う。

freshness が重要な可能性のある topic は、cache TTL を短くする。これは LLM に判断させてもよいが、最終的な TTL は memoryRouter の設定で制御する。

audit log は、cache hit と live fetch を分けて記録する。

## HITL Backpressure

draft knowledge が大量に溜まっている場合、新規 draft の作成を抑制できるようにする。

backpressure 中でも候補抽出と検証は止めない。ただし verified candidate をすぐ draft knowledge に promotion せず、candidate のまま `ready_for_review` 相当に留める。

importance が高く confidence も十分なものだけ promotion する例外設定は初期実装では持たない。backpressure 中は一律に promotion を止める。

dedupe / merge candidate を優先し、既存 draft と近いものを増やしすぎないようにする。

Doctor と UI には、backpressure により promotion を止めていることを表示する。

## Doctor UI

Doctor には、単なる OK / Skipped / Failed だけではなく、進行状態を出す。

表示したい項目は次の通りである。

LaunchAgent の installed / loaded / running / last exit code。

現在の lock holder pid と createdAt。

現在 running の job phase。

queued / running / paused / completed / failed の job 数。

最新 read event 時刻。

最新 Web search / fetch 時刻。

local-llm health と circuit breaker 状態。

budget exhausted 件数。

provider paused 件数。

HITL backpressure 状態。

これにより、「止まっている」「LLMが読んでいる」「Web evidence を待っている」「vibe が source の共有ロック待ち」の区別がつくようにする。

## System Context

Agentic Reader の System context は短く保つ。

LLM に伝えるべきルールは、次の程度に絞る。

必要な locator だけ読む。

具体的な候補仮説がない場合は、広く読まずに no_candidate を返す。

追加読みは、候補の有無判断または候補検証に必要な場合だけ行う。

予算を意識して、最も情報量が高い locator を選ぶ。

圧縮メモは作業用であり、最終 evidence は元 locator から取る。

procedure は SKILL.md 相当の再利用可能な手順にする。

rule は持続的な制約や判断基準にする。

## 実装フェーズ

### Phase 1: 再開可能 job と Doctor 可視化

`distillation_jobs` を追加する。

source/vibe CLI が subject を直接処理する前に job を作成または claim するようにする。

job phase、status、attempt count、next retry time を保存する。

Doctor に job counts、running phase、lock holder、last read / last tool event を表示する。

この段階では部分読みはまだ入れない。まず「止まっているか進んでいるか」を正しく見えるようにする。

検証は、unit test、DB integration test、`bun run doctor`、source/vibe の `--limit 1 --apply` で行う。

Phase 1 の完了条件は、既存 workflow の結果を変えずに、job の queued、running、completed、skipped、failed、paused が DB と Doctor で見えることである。source/vibe の共有ロック待ちは running だけではなく、job phase または metadata で lock waiting と分かるようにする。

### Phase 2: 部分読み tool

Wiki source の read locator を実装する。

vibe memory の read locator を実装する。

read events を保存する。

LLM が直接全文を受け取る既存経路を残しつつ、設定で agentic reader を有効化できるようにする。

この段階では候補抽出の結果は既存 workflow に流す。

検証は、長い BLE 文書の一部 locator を読む unit test、vibe memory の diff entry locator を読む unit test、tool event audit test で行う。

Phase 2 の完了条件は、LLM を呼ばずに read locator が deterministic に動くことである。ここでは候補品質を評価しない。

### Phase 3: Agentic Reader と working context compression

source brief から読み始める extraction session を追加する。

LLM が `read_source_segment` / `read_vibe_segment` を使って必要箇所を読むようにする。

読んだ内容だけを session 内で短く統合する。

候補抽出 prompt は、working context と元 locator の組み合わせから候補を出すように変更する。

圧縮メモだけで promotion できないことを test する。

Phase 3 の完了条件は、`--agentic-reader --limit 1 --apply` で read event と candidate が同じ job に紐づいて保存され、圧縮メモ本文が永続化されないことである。

### Phase 4: 失敗種別 retry と adaptive shrink

outcome kind ごとに retry policy を実装する。

`llm_timeout` 後は同じ入力で再試行しない。

`llm_empty_response` は 1 回だけ短い reminder で再要求する。

provider failure は subject failed ではなく provider paused にできるようにする。

Doctor に retry policy と next retry time を表示する。

Phase 4 の完了条件は、`llm_timeout` 後の再実行が同じ巨大入力を投げないこと、`no_candidate` が retry queue に戻らないこと、provider failure が subject failed と区別されることである。

### Phase 5: Local-LLM Circuit Breaker

batch 開始前 health check を追加する。

batch 中の health snapshot を job metadata に保存する。

local-llm が不健康なときは job を paused にし、個別 run の failed を増やさない。

Doctor に circuit breaker open / closed を表示する。

Phase 5 の完了条件は、local-llm unhealthy の mock で、個別 subject failed を増やさず job が paused になることである。

### Phase 6: Web Evidence Cache

`distillation_evidence_cache` を追加する。

search / fetch tool service で cache hit と live request を分ける。

audit log に cache hit を残す。

verification は cache evidence と live evidence を同じ形式で扱えるようにする。

Phase 6 の完了条件は、同じ query / URL の二度目の検証で live fetch ではなく cache hit が audit log に残ることである。

### Phase 7: HITL Backpressure

draft backlog を見て promotion を制御する。

backpressure 中は verified candidate を candidate のまま残せるようにする。

Doctor と UI に promotion paused reason を出す。

Phase 7 の完了条件は、draft backlog が閾値を超えた状態で verified candidate が draft knowledge に promotion されず、candidate として残ることである。

## 既存処理との互換性

既存の `distill:vibe-memory` と `distill:sources` は残す。

既存の run table と Doctor summary は残す。

新しい agentic reader は feature flag で有効化する。最初は source/wiki のみに有効化し、安定後に vibe memory へ広げる。

既存の候補 parser、緩い JSON 修復、tool call object 除外、tool evidence 必須化は維持する。

既存の `distillation_candidates` は引き続き候補の SSoT として使う。

## 品質ゲート

各 Phase で最低限、typecheck、関連 unit test、Doctor smoke を実行する。

DB migration を追加する Phase では、test DB への `bun run db:migrate` を必ず実行する。

長文 source の regression として、BLE 系 Markdown fragment を対象にした `--limit 1 --apply` の controlled run を行う。

local-llm が不健康な場合の test は mock provider で行い、live local-llm に依存しない。

Web search / fetch は audit log に `live` と `cache_hit` の区別が残ることを test する。

## 成功条件

Doctor で、source/vibe distillation が running / queued / paused / completed のどれにいるか分かる。

長文 source で、1 回の LLM call に全文を渡さず、read events が残る。

timeout 後に同じ巨大入力を再投入しない。

local-llm が不健康なとき、個別 source / vibe memory の failed が増えない。

Web evidence が取得済みの場合、同じ URL を不要に fetch しない。

HITL backlog が高いとき、draft knowledge が無制限に増えない。

Knowledge の source refs は、圧縮メモではなく元 locator を指す。

## 実装順の推奨

最初に Phase 1 を実装する。進行状態が見えないまま部分読みを入れると、問題が runtime なのか reader なのか分からなくなるためである。

次に Phase 2 と Phase 3 を実装する。ここが timeout と empty response の削減に最も効く。

その後、Phase 4 と Phase 5 で失敗時の動きを安定させる。

最後に Phase 6 と Phase 7 で運用効率を上げる。

この順番なら、蒸留を止めずに段階的に安全性を上げられる。
