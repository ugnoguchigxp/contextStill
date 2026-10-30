このプロジェクトでの作業を開始する際、最初に一度だけ `initial_instructions` MCP ツールを実行してください。以降の個別のタスクごとに実行する必要はありません。

## Spec HTML documents

- 内部設計書、実装計画、恒久contract、調査結果は `spec/docs/` 直下へSpec HTMLとして置く。公開ユーザー／運用ドキュメントである `spec/docs/pub/` はMarkdownのまま維持する。
- 各HTML fileは主言語を示す `lang` 属性を持つ1つの `article` をrootとし、`h1`を1つだけ置く。`html`、`head`、`body`、文書固有CSS、独自navigationは追加しない。
- linkとassetは `spec/docs/` 内へ置き、相対URLで参照する。重要な要件、結論、数値はHTML本文だけでも理解できる形で残す。
- 進行中または現行実装が参照する文書は `spec/docs/` 直下、実装済みまたは後続計画で置換済みの文書は `spec/docs/.archived/` 直下へ置く。ViewerのArchive／Restore操作を使ってよい。
- 文書を作成・編集したら `bun run spec:fix` で安全な修正と整形を適用し、完了前に `bun run spec:check` を実行する。

## 実装の規則

- WebとCLIはAPIを使い、DBを直接開かない。DBを開くのはbackend process（`api/application/server.ts`）とmaintenance command（`api/application/commands/*`）だけで、どちらも `openStore` のOS lockを通るため、同時にwriterになれるのは1 processだけ。backendが動いている間にcommandを実行すると `database_writer_owned`（exit code 3）で終わる。
- domainの業務判断・SQL・試験は各domainに置く。下位は上位を参照しない（tierと依存は `scripts/domains.ts`、検査は `scripts/boundaries.ts`）。domainは外部へ `index.ts` と `contracts/` だけを公開し、domainから `api/application` はimportしない。複数domainの書き込みは、1つの `store.write` の中で各domainの `index.ts` が公開する同期関数を呼んで行う。
- serverを無断で起動・停止・再起動しない。テストも `Bun.serve`・常駐process・live LARM・外部networkを使わない（`scripts/test-preload.ts` が `fetch` と `Bun.serve` を塞ぐ）。HonoとMCPは `app.request()`、DBは一時ディレクトリ、LARMは注入した `fetch` で試す。
- 秘密（`.env*`、Keychain、`data/keys/`）を読まない・ログやDBや応答へ出さない。環境変数は `api/application/config.ts` の `resolveConfig` だけが読み、表にない変数は無視する。
- 旧版は `legacy/v1` branchと `~/Code/contextStill-legacy` にある。旧版のport（39171、39172）とpathは設定で拒否する。
- 検証は `bun run verify`（format:check、lint、typecheck、boundaries、test、spec:check）。domain単位は `bun run test:domain -- <name>`。
- 設計の正本は `spec/docs/contextstill-v2-n0-n1-implementation-plan.html`。契約（`contracts/`、`repository/migrations.ts`）を変えたくなったら、変更せずに設計書で合意を取る。
