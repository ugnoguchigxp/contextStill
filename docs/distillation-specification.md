# 蒸留仕様書

ステータス: 現行実装レビュー版

作成日: 2026-05-17

対象リポジトリ: memory-router

この文書は、現在の蒸留ロジックを読むための仕様書である。理想案や将来計画ではなく、現行コードが実際に行っている処理を基準に書いている。

## 目的

memory-router の蒸留は、会話ログや wiki ソースをそのまま knowledge として保存する機能ではない。元ソースから、将来の coding agent が `context_compile` で再利用できる小さな `rule` または `procedure` を作るための変換パイプラインである。

蒸留が作る knowledge は、必ず draft として保存される。自動で active にはしない。これは、蒸留結果を人間や別の運用フローで確認できる余地を残すためである。

蒸留の大きな特徴は、LLM に一度で最終 knowledge を作らせない点である。まず元ソースだけから候補を出し、その候補を別セッションで検証し、Web 検索または URL fetch の証拠を伴うものだけを knowledge 化する。候補がない場合は正常な skip として扱われる。

## レビュー結果の要約

現行の構造は、蒸留の入口、候補抽出、候補保存、候補検証、Knowledge 作成、監査ログ、doctor 表示が概ね分離されている。vibe memory と source/wiki の差分は各サービスに閉じており、候補検証や LLM 実行、ツール実行、候補パースは共通モジュールに寄せられている。

LLM に厳密な JSON を強制しすぎない設計も入っている。候補抽出の出力は、最小 JSON、緩い JSON 風表記、ラベル付き自然言語、途中まで壊れた JSON の一部復元を受け入れる。最終的に正規化できないものは候補なしとして落とす。これは Gemma 系の出力揺れに対して実用的な設計になっている。

Web 検索と fetch は、検証セッションで能動的に使わせる設計になっている。`apply` 実行時は、候補検証に成功した tool event がない verified candidate を promotion しない。過去に verified になっていた候補でも、tool evidence が残っていない場合は失敗扱いに戻して再評価対象にする。

同時実行対策は CLI 層に入っている。vibe memory 蒸留と source 蒸留は、それぞれ個別ロックを持ちつつ、共有の蒸留ロックも使う。これにより、同じ種類の二重起動を防ぎ、別種類の蒸留が同時に LLM へ流れ込むことも避ける。

レビューで見えた注意点のうち、現在の実装では timeout 設定は共通の `distillation.timeoutMs` に寄せている。旧 `MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS` は互換 fallback としてだけ読む。過去の score gate 由来の `distillationTools.minCandidateScore` と `below_quality_threshold` は、現行の設定型と outcome から外している。運用メトリクスでは、検証後に正規化できた候補数を `verificationCandidateCount`、実際に検証を試みた回数を `verificationAttemptCount` として記録する。旧 `rawCandidateCount` と `verificationSessionCount` は互換 alias として残る。

これにより、doctor や audit log では「候補なし」「検証候補なし」「tool evidence 不足」「品質問題」「LLM failure」を分けて読める。

## 主な実装ファイル

蒸留 CLI は `src/cli/distill-vibe-memory.ts` と `src/cli/distill-sources.ts` にある。

CLI のファイルロックは `src/cli/file-lock.ts` にある。

vibe memory の蒸留サービスは `src/modules/vibe-memory/distillation.service.ts` と `src/modules/vibe-memory/distillation.repository.ts` にある。

wiki/source の蒸留サービスは `src/modules/sources/distillation.service.ts` と `src/modules/sources/distillation.repository.ts` にある。

候補抽出、候補検証、候補テーブルの状態遷移は `src/modules/distillation/distillation-candidate-workflow.ts` と `src/modules/distillation/distillation-candidate.repository.ts` にある。

LLM 呼び出し、tool loop、provider 切り替えは `src/modules/distillation/distillation-runtime.service.ts` にある。

プロンプトは `src/modules/distillation/distillation-prompts.ts` にある。

候補パースと候補品質チェックは `src/modules/distillation/distillation-candidates.ts` にある。

Web 検索と fetch は `src/modules/distillation/distillation-tools.service.ts` にある。

skip や failure の outcome 分類は `src/modules/distillation/distillation-outcomes.ts` にある。

LLM 出力の緩い JSON パースは `src/lib/llm-output-parser.ts` にある。

Knowledge の保存は `src/modules/knowledge/knowledge.repository.ts` の `upsertKnowledgeFromSource` を使う。

重複判定は `src/lib/knowledge-dedup.ts` を使う。

doctor の蒸留可視化は `src/modules/doctor/inspectors/distillation-run.inspector.ts`、`src/modules/doctor/inspectors/vibe-distillation.inspector.ts`、`src/modules/doctor/inspectors/source-distillation.inspector.ts` にある。

## 入力ソース

蒸留対象は 2 種類ある。

1 つ目は vibe memory である。これは `vibe_memories` の 1 レコードと、それに紐づく `agent_diff_entries` を入力にする。会話内容、セッション ID、memory type、作成日時、agent diff のファイル名、変更種別、言語、シンボル、行番号、diff hunk が候補抽出の材料になる。

2 つ目は source/wiki である。これは `sources` と `source_fragments` から取得した 1 fragment を入力にする。source kind、source ID、source URI、source title、source content hash、fragment ID、locator、heading、fragment content が候補抽出の材料になる。現行の source kind は wiki のみである。

どちらの入力も、蒸留対象として扱う前に input hash を作る。input hash は、同じ元ソース、同じ prompt version、同じ入力内容を再処理しないための識別子である。

vibe memory の input hash は、memory 本文と memory の基本属性に加え、関連 diff entry の内容から作られる。

source/wiki の input hash は、source ID、source kind、source URI、source content hash、fragment ID、locator、heading、content から作られる。

## 実行入口

vibe memory の蒸留は `bun run distill:vibe-memory` から実行する。内部では `src/cli/distill-vibe-memory.ts` が `distillVibeMemories` を呼ぶ。

source/wiki の蒸留は `bun run distill:sources` から実行する。内部では `src/cli/distill-sources.ts` が `distillSources` を呼ぶ。

どちらの CLI も `--apply` を付けたときだけ、run record、candidate record、knowledge draft などを永続化する。`--dry-run` または `--apply` なしでは、候補抽出と検証は行うが、run record や knowledge の保存は行わない。audit log の started/finished は apply なしでも記録される。

vibe memory CLI は `--limit`、`--session-id`、`--vibe-memory-id`、`--include-processed` を受け取る。`--vibe-memory-id` はカンマ区切りと複数回指定の両方を受け入れる。

source/wiki CLI は `--limit`、`--source-kind`、`--uri`、`--include-processed` を受け取る。現行で `--source-kind` として受け入れる値は wiki のみである。`--uri` はローカル path として解決される。

## ロックと同時実行

蒸留 CLI はファイルロックを使う。vibe memory 蒸留は個別ロックとして `logs/vibe-distillation.lock` を使う。source/wiki 蒸留は個別ロックとして `logs/source-distillation.lock` を使う。

さらに、両者は共有ロックとして `logs/distillation.lock` を使う。共有ロックは、vibe memory と source/wiki が同時に LLM へリクエストを投げることを避けるためのロックである。

ロックファイルには pid、作成時刻、ラベルが保存される。ロック取得時に既存ロックがあり、その pid がまだ生きている場合は stale とはみなさない。pid が死んでいる場合はロックを削除して再取得する。pid が判定できない壊れたロックの場合は、ファイルの age が TTL を超えたときだけ stale とみなす。

同じ種類の蒸留が既に動いている場合、個別ロックの取得で失敗する。別種類の蒸留が動いている場合、個別ロックは取得できるが、共有ロックで待機する。

共有ロックの既定 TTL は 7200 秒である。蒸留ジョブが長時間詰まった場合でも、正常な pid が生きている限りは勝手に壊さない。

## 設定

provider は `MEMORY_ROUTER_DISTILLATION_PROVIDER` で選ぶ。値は local-llm、azure-openai、bedrock、auto を想定している。既定は local-llm である。

auto の場合、local-llm、Azure OpenAI、Bedrock の順に、設定済み provider を試す。1 回成功すると、その runtime client 内では成功した provider を pinned provider として使い続ける。失敗した場合は、auto であれば次の provider に進む。auto でない場合はその失敗をそのまま投げる。

LLM request timeout は `MEMORY_ROUTER_DISTILLATION_TIMEOUT_MS` で設定する。現在の既定は 300000 ミリ秒、つまり 5 分である。古い `MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS` は fallback として残っているが、蒸留 LLM 呼び出しの本命設定は共通の distillation timeout である。

vibe memory の既定 batch size は 10、最大入力文字数は 6000、最大出力 token は 2048 である。

source/wiki の既定 batch size は 10、最大入力文字数は 12000、最大出力 token は 2048 である。

候補検証で使う tool loop の最大 round は既定 4 である。Web 検索や fetch の各 HTTP request timeout は既定 10000 ミリ秒である。tool result の最大文字数は既定 6000 文字である。検索結果件数は既定 3 件である。1 入力から最終的に扱う候補数の上限は既定 2 件である。

失敗 run の再試行抑制時間は既定 21600 秒、つまり 6 時間である。直近 6 時間以内に failed run がある対象は、`--include-processed` なしでは通常の選択対象から外れる。

候補の採否は score threshold ではなく、検証結果、tool evidence、外部証拠、本文品質で決まる。LLM が返す confidence と importance は knowledge の評価値として保存するが、候補を機械的に score で落とす設定は持たない。

## 処理対象の選択

vibe memory は、`listVibeMemoriesForDistillation` で選ばれる。`--include-processed` がない場合、同じ prompt version で ok または skipped の run が既にある memory は除外される。同じ prompt version の failed run があり、その updatedAt が failure retry delay 内であれば、それも除外される。

vibe memory の並び順は、推定入力サイズが小さい順、その後 createdAt、id の順である。推定入力サイズは memory content の長さと関連 diff hunk の合計長から求める。

source/wiki は、`listSourceFragmentsForDistillation` で選ばれる。`--include-processed` がない場合、同じ prompt version で ok または skipped の run が既にある fragment は除外される。直近の failed run が retry delay 内にある fragment も除外される。

source/wiki の並び順は、source の updatedAt、source id、fragment createdAt、fragment id の順である。

## 1 段階目: 候補抽出

候補抽出は、元ソースだけを見て candidate を作る段階である。この段階では Web 検索や fetch を完了しようとしない。プロンプトも、1 段階目では外部検証を行わず、入力証拠から候補を抽出するように書かれている。

候補抽出の system prompt は、vibe memory と wiki で共通部分を持つ。共通部分では、出力対象を compile-ready knowledge に限定し、知識タイプを rule と procedure のみに制限する。会話要約、ドキュメント要約、changelog、メモを作らないように指示する。

rule は、持続的な制約、方針、不変条件、意思決定を表す。

procedure は、再利用可能な手順、コマンドフロー、運用スキル、レビュー手順を表す。

候補は小さく、context compile の pack に入る粒度である必要がある。ただし、関連する rule や procedure を細切れにしすぎない。関連する判断や手順は、1 つの再利用可能な knowledge に集約する。

vibe memory 固有の system prompt は、会話ログを承認済み knowledge ではなく証拠として扱う。持続的なユーザー嗜好、repo 運用ルール、再利用可能な手順、安定したレビュー制約を優先する。agent diff entries は根拠として使うが、コピー用ソースコードとして扱わない。

wiki 固有の system prompt は、wiki ソースを人手で作られた証拠として扱い、そのまま knowledge にしない。長い説明や背景や設計メモは、再利用可能な rule/procedure に圧縮する。

候補抽出の model call は `enableTools: false` で実行される。ここで tool call が返ってきても、runtime は通常の tool loop を使わない。

## 候補出力形式

LLM には厳密な JSON だけを求めない。推奨は最小 JSON だが、自然言語のラベル付き出力も受け入れる。

候補に必要な中心情報は type、title、body である。confidence と importance は任意であり、判断可能な場合だけ 0 から 100 の値として扱う。sourceRefs、evidenceRefs、rationale は parser 上は受け取れるが、prompt 上は原則出さない方針である。

候補なしの場合は、空配列、none、no candidate、no candidates、候補なし、なし、などが候補なしとして扱われる。

## 候補パースと修復

候補パースは、LLM 出力の揺れをかなり許容する。

まず厳密な JSON として読む。読めない場合は、Markdown code fence、JSONP 風の wrapper、BOM、スマートクォート、Python 風の None/True/False、コメント、末尾カンマ、単一引用符、bare key、途中で閉じていない配列や object などを補正して読む。

Bun の JSON5 parser が使える場合は JSON5 としても読む。

全体を読めない場合でも、`candidates` らしい配列の中から、完了している object だけを取り出して復元する。これにより、途中で切れた JSON から先頭の完全な候補だけを回収できる。

JSON 風の候補が見つからない場合は、ラベル付き自然言語として読む。type、title、body、confidence、importance、rationale、sourceRefs、evidenceRefs のラベルを認識する。body と rationale は複数行を受け取れる。

JSON object の候補では、title、heading、summary を title として扱う。body、description、content、details を body として扱う。以前問題になった tool call object を knowledge と誤認しないため、`name` は title の fallback として使わない。

tool call object は候補から除外する。`name` と `arguments` を持つ object、または `function.name` と `function.arguments` を持つ object は tool call とみなす。

type は rule または procedure のみである。type、kind、category のいずれかに procedure を含む場合は procedure、rule を含む場合は rule とする。type が空なら rule が fallback になる。rule/procedure と判断できない文字列なら候補から落とす。

confidence と importance は 0 から 100 の score に正規化される。空や不正値なら confidence は 65、importance は 55 になる。0 より大きく 1 未満の小数は 100 倍される。1 は 1 として扱われる。

同じ type、title、body の候補は重複排除される。

## 候補テーブル

`--apply` 実行時、抽出された候補は `distillation_candidates` に保存される。保存時の status は extracted である。

candidate は、元ソース、prompt version、input hash、candidate index の組み合わせで一意になる。vibe memory 由来の場合は vibe memory ID を使い、source/wiki 由来の場合は source fragment ID を使う。

候補テーブルには、source kind、vibe memory ID または source fragment ID、run ID、input hash、prompt version、model、candidate index、type、title、body、confidence、importance、status、rejection reason、knowledge ID、tool events、metadata、evaluatedAt、createdAt、updatedAt が保存される。

source kind は vibe_memory または source_fragment である。source ref はどちらか一方だけを持つ。vibe memory ID と source fragment ID を同時に持つことは許されない。

候補 status は extracted、evaluating、verified、promoted、rejected、failed のいずれかである。

extracted は、1 段階目で抽出され、まだ検証されていない候補である。

evaluating は、検証 worker が claim して処理中の候補である。

verified は、検証セッションで採用可能と判断されたが、まだ knowledge として promotion されていない候補である。

promoted は、draft knowledge として保存された、または既存 knowledge への重複 merge として扱われた候補である。

rejected は、検証は完了したが採用されなかった候補である。

failed は、検証中にエラーになった候補、tool evidence が不足した候補、または stale evaluating として reclaim された候補である。failed は再試行対象に戻る。

## 保存済み候補の優先順位

`--apply` 実行時は、新しい抽出よりも保存済み候補を優先する。

まず promotion 可能な verified candidate を探す。verified candidate に成功した検証 tool evidence が残っていれば、LLM を呼ばずにその候補を accepted entry として返す。

verified candidate でも tool evidence がない場合は、その候補を failed に戻す。rejection reason は verification_tool_evidence_missing になる。その後、unevaluated candidate を探して再検証へ進む。

promotion ready がなければ、extracted または failed の候補を探す。このとき、古い evaluating 候補は stale として failed に戻される。stale 判定の閾値は、共通 distillation timeout の 2 倍と 60 秒の大きい方である。現在の既定値では 5 分の 2 倍なので 10 分である。

保存済み候補が見つかれば、抽出セッションは再実行しない。見つからなければ、新しい候補抽出を行い、その結果を候補テーブルへ upsert する。

## 候補の claim

候補検証前に、候補は evaluating に claim される。claim は、status が extracted または failed のときだけ成功する。

他の worker がすでに claim した候補は検証しない。検証対象すべてで claim に失敗した場合は、concurrent claim conflict としてエラーになる。

この仕組みにより、同じ候補を複数 worker が同時に検証することを避けている。

## 2 段階目: 候補検証

候補検証は、1 候補ごとに新しい LLM セッションとして実行される。

検証セッションの user message には、元ソース全体を連結した SOURCE_EVIDENCE と、検証対象 candidate の CANDIDATE_TO_VERIFY が入る。SOURCE_EVIDENCE は user role の message 内容を連結したものである。

検証セッションの system prompt は、前段の候補を鵜呑みにせず、元ソースと外部証拠で検証してから最終 knowledge を返すように指示する。公開仕様、URL、ライブラリ/API、料金、最新挙動に関わる主張は search_web と fetch_content で確認する。

検証セッションは `requireToolCall: true` で実行される。最初の round では tool choice が required になる。LLM が tool call せずに本文を返した場合、runtime は 1 回だけ追加指示を返し、search_web または fetch_content を呼ぶよう再促す。

検証セッションで URL が SOURCE_EVIDENCE または CANDIDATE_TO_VERIFY に含まれる場合、prompt はまず fetch_content で URL を確認するように求める。検索結果 snippet だけを根拠にせず、外部主張は fetch_content の成功結果に基づける。

検証後の最終 knowledge は、元 candidate 1 件につき最大 1 件である。候補全体が検証不能であれば空 candidate とする。

procedure の検証 prompt は、SKILL.md と同等に再利用できる運用知識として仕上げるように指示する。body には、いつ使うか、前提、順序付きワークフロー、確認方法、避けるべき過剰実装、検証可能な成功条件を含める。

rule の検証 prompt は、同じ判断に属する関連ルールを 1 つの coherent な knowledge に集約するように指示する。body には、適用条件、守るべき制約、例外、次回の coding agent が判断できる境界を含める。

## LLM runtime

LLM runtime は OpenAI style の chat completion と Bedrock Converse の両方を扱う。

local-llm は `/v1/chat/completions` に POST する。stream は false、temperature は 0、priority は low で送る。tool が有効な場合は tool definitions と tool choice を送る。

Azure OpenAI は configured deployment の chat completions endpoint に POST する。temperature は 0、max completion tokens に maxTokens を使う。

Bedrock は ConverseCommand を使う。system message、user/assistant/tool message、toolUse、toolResult を Bedrock の形式へ変換する。

OpenAI style response では、最初の choice の message.content と tool_calls を読む。content が string ならその文字列、string でなければ null とする。

Bedrock response では、text block を改行で連結し、toolUse block を tool call として扱う。

tool call の function arguments は、string であればそのまま、object であれば JSON string にする。arguments がなければ空 object とする。tool call ID がなければ `tool-call-N` を補う。

runtime は tool round を最大設定回数まで繰り返す。tool call が返った場合は assistant message と tool result message を会話に追加し、次 round に進む。tool round 上限を超えても tool call が返る場合はエラーになる。

最終 assistant content が空文字だった場合は、1 回だけ再 prompt する。再 prompt では、空配列または TYPE / TITLE / BODY のラベル付きテキストを返すように促す。

最終 assistant content が null で tool call もない場合は、assistant content missing としてエラーになる。

## Web 検索と fetch tool

蒸留 tool は search_web と fetch_content の 2 つだけである。

search_web は、公開ドキュメント、仕様、API、package、証拠中 URL の確認に使う。BRAVE_SEARCH_API_KEY がある場合は Brave Search API を使う。Brave が未設定または失敗した場合は DuckDuckGo HTML 検索に fallback する。

search_web の結果には、query、results、そして検索 snippet だけを保存 knowledge の十分な根拠にしないようにする instruction が含まれる。

fetch_content は、公開 URL を取得し、HTML を cleaned text にして返す。fetch_content は最終的な外部証拠の中心であり、URL 依存の主張を採用するには fetch_content の成功が必要である。

fetch_content は SSRF 対策を持つ。http と https 以外の protocol は拒否する。localhost、localhost suffix、169.254.169.254、private IPv4、loopback IPv4、private/loopback/link-local IPv6、IPv4 mapped IPv6 の private address は拒否する。

redirect は最大 5 hop まで追う。redirect 先も同じ URL safety check を通す。redirect location がない redirect、private endpoint への redirect、redirect limit 超過は失敗になる。

直接 fetch が失敗した場合、ブロック系エラーでなければ Jina reader の `r.jina.ai` 経由で fallback する。fallback も同じ fetch path を通る。

HTML は script、style、noscript、svg、nav、header、footer、aside を落とし、sanitize-html でタグを除去し、空白を compact にする。text/plain など HTML でなさそうな content は空白 compact のみを行う。

tool result は最大文字数に truncate される。truncate された場合でも metadata には元 text の contentChars が残る。

tool call は成功・失敗にかかわらず audit log に記録される。search_web は DISTILLATION_WEB_SEARCH、fetch_content は DISTILLATION_FETCH_CONTENT として記録される。payload には callId、toolName、ok、durationMs、query または URL、resultCount、finalUrl、contentChars、redirectCount、error などが入る。

## 候補採否

検証セッションから返った candidate は、さらにローカルの validation gate を通る。

まず URL 依存の外部証拠を確認する。candidate の title、body、rationale、sourceRefs、evidenceRefs に URL が含まれる場合、または元入力に URL が含まれる場合は、成功した fetch_content が必要である。成功 fetch がなければ rejectedInvalidEvidence になる。

次に candidate の品質を確認する。title または body が tool 名だけの場合は rejectedLowQuality になる。body が短すぎる場合も rejectedLowQuality になる。title と body が同一の場合も rejectedLowQuality になる。

title の最小長は、空白を除いて 3 文字である。body の最小長は、空白を除いて 24 文字である。

tool 名だけの判定対象は、現行 tool である search_web と fetch_content である。引用符や backtick、末尾の `()` が付いていても tool 名だけとみなす。

accepted candidate は、外部証拠 gate と品質 gate の両方を通った候補である。

`--apply` 実行時は、検証セッションが search_web または fetch_content の成功 tool event を 1 つも残していない場合、その candidate は accepted にならない。候補自体が妥当そうに見えても、verification_tool_evidence_missing として failed になる。

## Knowledge 化

accepted candidate が 0 件なら、その元ソースの run は skipped になる。候補なし、検証結果なし、外部証拠不足、品質不足などは outcomeKind と legacy reason に分類される。

accepted candidate が 1 件以上あれば、`--apply` の場合だけ embedding を生成し、Knowledge 化に進む。embedding の入力は title と body を改行でつないだ文字列である。

Knowledge 化の前に重複判定を行う。重複判定は、まず embedding による vector search で既存 knowledge 候補を取得し、その後 body の bigram similarity で比較する。body similarity threshold は 0.92、topK は 5 である。body が短い場合は title similarity も補助的に使う。

重複と判定された場合、新しい knowledge は挿入しない。既存 knowledge ID を knowledgeIds に入れる。candidate row は promoted になり、knowledgeId には既存 ID が入る。metadata には dedupMerged と dedupReason が入る。

重複でない場合、`upsertKnowledgeFromSource` で draft knowledge を作る。type は rule または procedure、status は draft、scope は repo である。confidence と importance は candidate の値を使い、embedding も保存する。

vibe memory 由来の sourceUri は `vibe-memory://<memory id>` である。metadata には、source、source kind、vibe memory ID、session ID、memory type、source createdAt、source content hash、repo path、repo key、input hash、model、prompt version、candidate index、rationale、source refs、evidence refs、tool event count が入る。

source/wiki 由来の sourceUri は `source-fragment://<fragment id>` である。metadata には、source、source kind、source ID、source document URI、source title、source content hash、source fragment ID、locator、heading、repo path、repo key、input hash、model、prompt version、candidate index、rationale、source refs、evidence refs、tool event count が入る。

source/wiki 由来の knowledge は、`knowledge_source_links` でも source fragment と link される。重複 merge の場合も、既存 knowledge に source link を追加する。vibe memory 由来には専用の source link table はなく、metadata と candidate/run の参照で追跡する。

`upsertKnowledgeFromSource` は、metadata の sourceUri と contentHash が一致する既存 knowledge があれば update する。なければ insert する。insert/update のどちらでも lastVerifiedAt は更新される。

Knowledge 作成または更新は audit log にも記録される。新規作成は KNOWLEDGE_CREATED、更新は KNOWLEDGE_UPDATED、status が変われば KNOWLEDGE_STATUS_CHANGED も記録される。

## Run record

vibe memory の run は `vibe_memory_distillation_runs` に保存される。source/wiki の run は `source_distillation_runs` に保存される。どちらも `--apply` のときだけ保存される。

run status は ok、skipped、failed のいずれかである。

ok は、accepted candidate があり、Knowledge 化または dedup merge まで進んだ run である。

skipped は、処理は壊れていないが、保存すべき knowledge がなかった run である。候補なし、検証候補なし、外部証拠不足、品質不足、混合 reject などがここに入る。

failed は、LLM timeout、provider error、parse error、processing error、concurrent claim conflict など、処理経路として失敗した run である。

run record には、candidateCount、knowledgeIds、error、inputHash、promptVersion、model、toolEvents、metadata が入る。

metadata には outcomeKind、jsonRepaired、verificationCandidateCount、verificationAttemptCount、rawCandidateCount、extractionCandidateCount、extractionRawCandidateCount、verificationSessionCount、extractionResponseChars、verificationResponseChars、usedStoredCandidates、failedCandidateCount、concurrentClaimMissCount、acceptedCandidateCount、dedupSkippedCount、rejectedLowQualityCount、rejectedInvalidEvidenceCount、toolEventCount、responseChars などが入る。rawCandidateCount は verificationCandidateCount、verificationSessionCount は verificationAttemptCount の旧互換フィールドとして扱う。

source/wiki では、run の tool events から `source_distillation_evidence` も作る。tool name、URL、ok、content hash、metadata が保存される。vibe memory では separate evidence table はなく、run と candidate の toolEvents を見る。

候補 row には、run record 作成後に vibeMemoryRunId または sourceRunId が attach される。これにより、candidate と run の紐づきが後から追える。

## Outcome 分類

成功系の outcome は candidate_ready、knowledge_created、knowledge_deduped である。

candidate_ready は dry run の成功である。apply しない場合、accepted candidate があっても knowledge は作らないため、この outcome になる。

knowledge_created は apply 実行で accepted candidate があり、新規作成または一部作成まで進んだ場合である。

knowledge_deduped は apply 実行で accepted candidate があり、その全件が既存 knowledge との重複として扱われた場合である。

skip 系の outcome は no_candidate、verification_no_candidate、missing_verification_tool_evidence、missing_external_evidence、invalid_candidate、mixed_candidate_rejections、candidate_rejected である。

no_candidate は、抽出段階または保存済み候補の読み出しで検証対象候補が 0 件だった場合である。

verification_no_candidate は、抽出候補はあったが、検証セッションから正規化できる候補が 0 件だった場合である。

missing_verification_tool_evidence は、apply 時に成功した検証 tool evidence がなく、外部証拠不足として failed candidate が出た場合である。

missing_external_evidence は、候補または入力が URL に依存しているのに、成功 fetch_content がなかった場合である。

invalid_candidate は、body が短すぎる、title/body が同一、tool 名だけ、などの品質問題だけで rejected された場合である。

mixed_candidate_rejections は、複数種別の reject や failed candidate が混ざった場合である。

candidate_rejected は、上記に分類できない reject である。

failure 系の outcome は llm_timeout、llm_empty_response、llm_unparseable、llm_provider_error、concurrent_claim_conflict、processing_error である。

llm_timeout は、error message に timeout または timed out が含まれる場合である。

llm_empty_response は、assistant content がない場合である。空文字は一度だけ再 prompt されるため、再 prompt 後も成立しなかった場合に問題化する。

llm_unparseable は、parse_or_repair failure と判断された場合、または JSON repair 後も無効だった場合である。

llm_provider_error は、failure kind が llm_call だった場合である。

concurrent_claim_conflict は、候補がすでに別 worker に claim されていた場合である。

processing_error は、それ以外の処理エラーである。

現行の outcome には score threshold 専用の分類を持たない。doctor の fallback も、外部証拠不足、品質 reject、candidate failure の組み合わせだけで分類する。

## Audit log

蒸留 run の開始時には、VIBE_DISTILLATION_RUN_STARTED または SOURCE_DISTILLATION_RUN_STARTED が記録される。payload には apply、model、promptVersion、limit、includeProcessed、sessionId、vibeMemoryIdCount、sourceKind、uri などが入る。

蒸留 run の終了時には、VIBE_DISTILLATION_RUN_FINISHED または SOURCE_DISTILLATION_RUN_FINISHED が記録される。payload には ok、apply、model、promptVersion、processed、skipped、failed、knowledgeCount、outcomeKindCounts、skipReasonCounts、failureKindCounts、jsonRepairedCount、失敗対象や skip 対象の抜粋が入る。

search_web と fetch_content は、それぞれ DISTILLATION_WEB_SEARCH と DISTILLATION_FETCH_CONTENT として記録される。検証 candidate の auditContext が渡るため、source kind、source ID、input hash、prompt version、candidate row ID、candidate index、candidate type、candidate title と関連づけられる。

audit log の記録は safe wrapper を使う。audit_logs table が存在しないなどの理由で記録に失敗しても、蒸留本体は止めない。ただし、想定外の insert failure は warning として出る。

## Doctor 表示

doctor は vibe distillation と source distillation を別々に見る。

doctor は LaunchAgent の installed/loaded 状態、run count、ok/skipped/failed の件数、last run、last ok run、skip reason counts、outcome kind counts を表示する。

doctor が run count を作るときは、同じ対象ごとの最新 run だけを見る。vibe memory では vibe_memory_id ごとの最新 run、source/wiki では source_fragment_id ごとの最新 run である。

doctor は run metadata の outcomeKind があればそれを使う。古い run に outcomeKind がない場合は、status と metadata の legacy field から outcome を推定する。

LaunchAgent が未インストールなら setup script の install を next action に出す。インストール済みだが未ロードなら load を出す。run がない場合は手動実行を促す。成功 run がない場合や最新成功が古い場合も next action を出す。

## 自動実行

vibe memory 蒸留の LaunchAgent label は `com.memory-router.vibe-distillation` である。source/wiki 蒸留の LaunchAgent label は `com.memory-router.source-distillation` である。

setup script は、それぞれ `scripts/setup-distillation-automation.sh` と `scripts/setup-source-distillation-automation.sh` である。

run-once では project root に移動し、`bun run db:migrate` を実行してから該当蒸留 CLI を `--apply` 付きで実行する。

LaunchAgent の working directory は project root である。これにより、既定の logs path や source root が project root 基準で解決される。

## 失敗と再試行

LLM request が timeout した場合、現在の既定では 5 分で abort される。これは memory-router のクライアント側 timeout であり、local-llm の server 設定を上書きするものではない。

Web 検索や fetch の HTTP request timeout は LLM request timeout とは別で、既定 10 秒である。

対象選択では、直近の failed run が retry delay 内にあるものを除外する。これにより、同じ失敗対象を短時間で繰り返し処理し続けることを避ける。

candidate row の failed は、再評価対象に戻る。次回 apply 実行時に同じ input hash と prompt version の failed candidate があれば、それを再 claim して検証する。

evaluating のまま残った candidate は、stale threshold を超えた時点で failed に戻される。これは worker 死亡や process abort の後に詰まり続けることを避けるためである。

run service の catch で失敗した場合、run record は failed になる。エラーが LLM call 前または LLM response 前なら responseChars は undefined になり、failureKind は llm_call になる。responseChars がある状態で JSON/assistant content 系のエラーなら parse_or_repair、それ以外は processing になる。

## 現行仕様としての境界

蒸留は raw transcript や wiki body を直接 compile context に混ぜない。必ず rule/procedure の candidate を経由する。

蒸留は active knowledge を直接作らない。draft knowledge までで止める。

蒸留は facts、lessons、notes、summaries という別種の knowledge type を作らない。type は rule と procedure のみである。

蒸留は、検索 snippet だけで外部主張を採用しない。URL 依存の候補には fetch_content の成功が必要である。

蒸留は、LLM に厳密 JSON を強制しない。LLM には最小限の構造を出させ、受け取り側で緩く修復・正規化する。

蒸留は、tool call JSON を knowledge として保存しない。`search_web` や `fetch_content` だけの title/body は品質 gate で落とす。

蒸留は、候補なしを異常扱いしない。候補なしは skipped の正常な一種である。

蒸留は、local-llm 全体の queue や他クライアントの同時実行を制御しない。制御しているのは memory-router の distillation CLI 同士の同時実行である。

## 運用時の読み方

doctor で failed が多い場合は、まず outcomeKind を見る。llm_timeout なら LLM request timeout、local-llm の queue、同時実行、モデル応答時間を疑う。llm_provider_error なら provider 設定、local-llm endpoint、Azure/Bedrock credentials を見る。

skipped が多い場合は、no_candidate、verification_no_candidate、missing_verification_tool_evidence、missing_external_evidence、invalid_candidate のどれが多いかを見る。

no_candidate が多い場合は、元ソースに持続的 rule/procedure がないだけの可能性がある。これは必ずしも異常ではない。

verification_no_candidate が多い場合は、抽出候補はあるが検証セッションで採用できる形になっていない。候補粒度や検証 prompt を見る。

missing_verification_tool_evidence が多い場合は、LLM が required tool call を守れていない、tool call parser が期待形式を拾えていない、または tool 実行が失敗している可能性がある。audit log の DISTILLATION_WEB_SEARCH と DISTILLATION_FETCH_CONTENT を見る。

missing_external_evidence が多い場合は、入力や candidate が URL に依存しているのに fetch_content が成功していない。URL safety block、HTTP failure、redirect、Jina fallback の失敗を見る。

invalid_candidate が多い場合は、LLM が短すぎる body、tool 名だけ、title/body 同一など、knowledge として再利用できない候補を返している。抽出 prompt と検証 prompt の粒度を見る。

knowledge_deduped が多い場合は、蒸留は機能しているが、既存 knowledge と重複している。source/wiki では source link が追加されるため、重複でも証拠関連付けとして意味がある。

## テストで守られている主な仕様

候補 parser は、途中で切れた JSON から完全な candidate だけを復元する。

候補 parser は、緩い JSON 風の表記を受け入れる。

候補 parser は、tool call JSON を candidate として扱わない。

候補 validation は、tool 名だけ、短すぎる body、title/body 同一の candidate を reject する。

runtime は tool call を実行し、tool result を conversation に戻してから最終 answer を受け取る。

runtime は検証セッションで最初の tool call を required にできる。

runtime は required tool call を LLM が飛ばしたとき、1 回だけ再 prompt する。

runtime は空文字 response に対して 1 回だけ再 prompt する。

候補 workflow は、保存済み unevaluated candidate を新規抽出より優先する。

候補 workflow は、複数抽出候補を保存してから、それぞれを検証する。

候補 workflow は、tool evidence のない verified candidate を再検証対象に戻す。

候補 workflow は、verification tool evidence が欠けている apply candidate を failed として retryable にする。

候補 workflow は、別 worker に claim 済みの candidate を検証しない。

tool service は、Brave が使えるときは Brave を使い、失敗時は DuckDuckGo に fallback する。

tool service は、fetch_content の HTML sanitization、Jina fallback、localhost/private IP/redirect block を守る。

## 既知の注意点

LLM request timeout は共通の `distillation.timeoutMs` だけを使う。旧 env `MEMORY_ROUTER_VIBE_DISTILLATION_TIMEOUT_MS` は fallback 互換としてだけ意味がある。

候補採否は score threshold ではなく、confidence/importance と validation gate が中心である。confidence/importance は LLM に厳密な JSON を強制せず、取れた場合だけ正規化して使う。

score threshold 専用の outcome は持たない。品質 reject は invalid_candidate、複数理由が混ざる場合は mixed_candidate_rejections に寄る。

`verificationAttemptCount` は実際に検証を試みた回数である。旧 `verificationSessionCount` は互換 alias として残る。

`verificationCandidateCount` は検証セッションから正規化できた candidate 件数である。旧 `rawCandidateCount` は互換 alias として残る。

vibe memory には source/wiki の `source_distillation_evidence` に相当する別 evidence table がない。vibe memory の証拠は run/candidate の toolEvents と audit log で追う。

失敗 path でも、tool 実行まで到達していれば runtime error に toolEvents を付けて上位へ渡し、failed run record と candidate failure metadata に toolEventCount を残す。LLM 呼び出し前の provider error など、tool 実行前の失敗では toolEvents は空になる。

## 変更時の注意

プロンプトを強くしすぎて、LLM に厳密 JSON だけを要求しない。現行方針は、LLM には最小限の構造を促し、受け取り側が緩く修復・正規化することである。

tool use の強制をローカル正規表現や細かい個別条件だけに寄せすぎない。現在は system prompt、required tool choice、再 prompt、tool evidence gate の組み合わせで成立している。

候補がないことをエラーにしない。候補なしは有効な結果であり、doctor では no_candidate として分類する。

candidate table を bypass して直接 knowledge を作らない。apply 時の再試行、claim、verified/promotion、dedup、doctor 分類が candidate table に依存している。

URL 依存の主張を search result snippet だけで保存しない。fetch_content の成功を必要条件にする。

source/wiki と vibe memory の差分を共通 workflow に押し込みすぎない。入力構築、repo scope、source link、metadata はそれぞれの service に固有の責務として残す。

doctor の outcome 追加時は、run metadata、outcome classifier、doctor fallback、UI 表示、テストを同時に更新する。

DB schema を変える場合は、Drizzle schema、migration、snapshot、repository、テストを合わせて更新する。特に candidate status や source kind は check constraint と TypeScript type の両方に反映する。

CLI のロックを変える場合は、個別ロックと共有ロックの両方を維持する。個別ロックは同種の二重起動防止、共有ロックは vibe/source 間の LLM 同時実行防止という別の役割を持つ。

## 仕様上の完了条件

蒸留 run が成功したと言えるのは、元ソースから rule/procedure candidate が抽出され、candidate が検証セッションで Web 検索または fetch の tool evidence を伴って確認され、ローカル validation gate を通過し、重複判定後に draft knowledge として保存または既存 knowledge に merge された場合である。

蒸留 run が正常に skip されたと言えるのは、LLM や処理経路は壊れていないが、保存すべき reusable rule/procedure が見つからなかった、または検証・外部証拠・品質の条件を満たす候補がなかった場合である。

蒸留 run が failed と言えるのは、LLM provider、timeout、assistant response、parse/recovery、candidate claim、DB/embedding/processing のいずれかで処理継続できないエラーになった場合である。

この 3 つを区別することが、蒸留運用の基本である。候補なしを failure と混同せず、failure を skip と混同せず、dedup を未作成と混同しないことが重要である。
