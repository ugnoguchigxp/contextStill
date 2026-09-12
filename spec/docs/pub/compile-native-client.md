# CLI・APIとRust compileの接続

SQLite構成のCLI、管理API/UI、init-projectは、起動済みのcontext-stilldへ接続します。MCPと同じRust検索方式を使い、Rustがrunとsnapshotを一度だけ保存します。通常のMCP公開引数とtext応答は変更しません。

常駐プロセスが停止中、DBの設定が不一致、protocol非互換の場合はエラーになります。別のDBや旧TS検索へ自動的に切り替えません。CLIを使う前に別のターミナルで `bun run start` を起動し、readinessを確認してください。

内部接続はloopback限定、既存Writerのbearer tokenで認証し、Origin付きリクエストを拒否します。DB fingerprintは利用者が設定したSQLiteパスと照合します。任意DBパスをリクエストへ指定することはできません。

## 引数の扱い

| 引数 | 動作 |
| --- | --- |
| goal、changeTypes、technologies、domains、projectRef、repoKey、repoPath | Rustの共通検索へ渡します。 |
| source、sessionId | 内部metadataとしてrunへ保存します。MCP公開引数ではありません。 |
| retrievalMode | 明示値を優先し、未指定ならchangeTypesから導きます。検索方式自体はresidentの設定を共有します。 |
| intent | 互換用の診断metadataとして保存します。 |
| tokenBudget | 内部APIで128〜8,192。runtimeの上限を適用し、有効な上限を内部応答へ含めます。出力は完全な根拠単位で省略し、途中で文を切りません。byte数を保守的なtoken上限として使うため、短い予算では収録量が少なくなる場合があります。 |
| includeDraft | falseまたは未指定に対応。trueは未対応エラーです。 |
| files、queryEmbedding | 値が渡された場合は未対応エラーです。 |
| securityIntelligenceShadow | 明示された場合だけlegacy互換処理を使います。通常のRust compileとは別の実験経路です。 |
| Postgres構成 | 明示的なlegacy互換経路を維持します。Rust/SQLiteとの検索品質の同一性は保証しません。 |

既存CLIで削除済みの `--token-budget` などのflagは復活させません。APIで出力予算を使った結果がpartial/degradedなら診断を確認してください。No Contentのrunにevalを強制することはありません。init-projectは根拠がある場合でもdegradedなら導入成功と判定しません。

これは現在の `split_legacy_rank` 等のresident設定を共通利用する変更です。FTS、新しいranker、holdout評価の昇格を自動的に行う変更ではありません。
