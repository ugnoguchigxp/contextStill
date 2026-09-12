# 依存関係の監視

DependabotはルートのBun・Cargo lockfileを週次で確認します。`dependency-audit` workflowは週次・手動でBun 1.3.14とcargo-audit 0.22.2を実行し、全severityのraw reportと判定をartifactに保存します。BunのHigh/Critical、RustSecの未例外化advisory、監査不能は失敗です。RustSecはCVSS vectorを保つため、この運用では低severityを含め全検出を保守的に失敗扱いにします。

タイムアウトは各監査120秒です。空出力、異常終了、未知のJSON形式を検出なしに変換しません。GitHub Actionsの失敗通知は利用者の通知設定に従います。リポジトリへのworkflow追加だけでは通知先設定や定期実行履歴の確認は完了しません。

例外は `scripts/testing/audit-exceptions.json` にtool、advisory ID、理由、owner、ISO形式の期限を記録します。期限切れ・必須項目欠落で監査は失敗します。例外とlockfileの変更は通常のPRレビュー対象です。

## URL依存

SheetJSは配布元 `https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz` の0.20.2を利用しています。integrityはbun.lockのsha512値で固定しています。npm版へ置換していません。更新確認はSheetJSの公式配布・release情報と配布物のintegrity照合で行います。registry監査がURL配布物の中身や配布元の侵害まで評価することは保証できません。

ローカルでは `bun run audit:dependencies` を実行します。監査専用の一時ディレクトリへmanifestとlockfileをコピーし、プロジェクトの.envを読み込ませません。

2026-09-13のGitHub API確認では、secret scanningとpush protectionは有効、Dependabot security updatesは無効、CodeQL default setupは未設定でした。新しい監査workflowはまだdefault branchへ反映されていません。これらの設定を無断で変更してはいません。
