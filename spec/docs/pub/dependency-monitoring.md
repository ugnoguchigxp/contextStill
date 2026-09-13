# 依存関係の監視

DependabotはルートのBun・Cargo lockfileとdocker-compose.yml、GitHub Actionsを週次で確認します。Composeには専用の `docker-compose` ecosystemを使います（[GitHub公式仕様](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)）。`dependency-audit` workflowは週次・手動でBun 1.3.14とcargo-audit 0.22.2を実行し、全severityのraw reportと判定をartifactに保存します。BunのHigh/Critical、RustSecの未例外化advisory、監査不能は失敗です。RustSecはCVSS vectorを保つため、この運用では低severityを含め全検出を保守的に失敗扱いにします。

Bunの直接通信は30秒、再試行は45秒、Cargo監査は120秒で打ち切ります。Bunのプロセスがタイムアウト・起動失敗した場合だけ、隔離directoryのbunfig.tomlへ一時的なloopback registryを設定して再試行します。Bun自身がlockfileから作る監査リクエストを、curlで同じnpm公式のHTTPS advisory endpointへ転送します。TLS検証を無効化せず、送信先は固定、追加の認証headerは転送しません。curlが利用できない場合や再試行が失敗した場合も監査不能として失敗します。直接通信の失敗と再試行に用いたtransportはreportへ残します。空出力、異常終了、未知のJSON形式を検出なしに変換しません。GitHub Actionsの失敗通知は利用者の通知設定に従います。リポジトリへのworkflow追加だけでは通知先設定や定期実行履歴の確認は完了しません。

例外は `scripts/testing/audit-exceptions.json` にtool、advisory ID、理由、owner、ISO形式の期限を記録します。期限切れ・必須項目欠落で監査は失敗します。例外とlockfileの変更は通常のPRレビュー対象です。

## URL依存

SheetJSは配布元 `https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz` の0.20.2を利用しています。integrityはbun.lockのsha512値で固定しています。npm版へ置換していません。更新確認はSheetJSの公式配布・release情報と配布物のintegrity照合で行います。registry監査がURL配布物の中身や配布元の侵害まで評価することは保証できません。

ローカルでは `bun run audit:dependencies` を実行します。監査専用の一時ディレクトリへmanifestとlockfileをコピーし、プロジェクトの.envを読み込ませません。

2026-09-13のGitHub API確認では、secret scanningとpush protectionは有効、Dependabot security updatesは無効、CodeQL default setupは未設定でした。監査workflowはdefault branchへ反映済みですが、実行履歴・通知の確認は保留しています。これらの設定を無断で変更してはいません。

2026-09-13の通信修正後は監査が完了し、Bun側で15件（High 7件・Moderate 8件）を検出しました。Highの内訳はTiptap、fast-uri（4件）、js-yaml、smol-tomlです。検出を抑制する例外追加や依存バージョンの更新は行っていません。Cargo側は検出なしでした。これらは実行時点の結果であり、最新状態は再監査で確認してください。
