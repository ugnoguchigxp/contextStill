# DeepStillで手動調査する

ContextStillの「調査」画面でテーマを入力すると、DeepStillが実調査を実行します。画面を閉じても調査は継続し、履歴から状態、レポート、引用元を確認できます。KnowledgeとEpisodeへの登録やQueueからの自動委託は行いません。

## 接続の準備

1. DeepStill側で `bun run db:migrate` を実行し、APIとworkerを起動します。ContextStill側では更新した常駐プロセスを起動し、SQLite schema revision 9への移行を完了させます。
2. 32文字以上の同じ秘密値を、DeepStillのAPIプロセスとContextStillの管理APIプロセスの両方に `DEEPSTILL_CONTEXTSTILL_TOKEN` として設定します。値をリポジトリへコミットしないでください。
3. DeepStillのAPIが `127.0.0.1:4310` 以外にある場合は、ContextStill管理APIの `CONTEXT_STILL_DEEPSTILL_URL` にloopbackのHTTP URLを設定します。ブラウザーがDeepStillへ直接接続する設定は不要です。
4. DeepStillのdirect searchと、Settingsで選んだLocal LLMが使えることを確認してから、ContextStillの「調査」を開きます。

ContextStillの Settings → Task Routing で「DeepStill manual research」のLocal LLM endpointを選び、保存してください。手動調査のLLM呼び出しはContextStillを経由してこのendpointへ送られます。DeepStillの単体画面で使う `.env` の `LLM_PROVIDER=codex` やLuna設定は手動調査ジョブには適用されません。手動調査の検索はDeepStillのdirect searchを使います。

ContextStillのAPIが既定の `127.0.0.1:39170` 以外で動く場合は、DeepStillのworkerに `CONTEXTSTILL_ADMIN_API_URL` としてloopbackのHTTP URLを設定してください。共有トークンはDeepStillのworkerにも設定します。Settingsで選んだLocal LLMの接続先やAPIキーはDeepStillのジョブDBへ保存しません。

初版はテーマだけを入力します。上限は15分、検索25回、費用1 USDです。接続やproviderが使えない場合は調査履歴に理由を表示します。部分成果、失敗、取消しは完了と区別されます。

調査結果の引用はDeepStillが保存したsource本文と照合します。ContextStillは元のWebサイトを再取得しないため、画面の出典リンクから原文を確認してください。
