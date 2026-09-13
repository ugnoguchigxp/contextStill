# 配布候補の作成と更新

現在の配布候補はpackage/Cargoとも0.1.0、SQLite schema revision 8です。`release-dry-run` workflowは入力tagと両manifestの版を照合し、検証、ビルド、release note、SHA-256 checksumを生成します。GitHub Releaseへ公開する権限・操作は持ちません。ローカル実行は `bun run release:dry-run` です。

macOS arm64でKeychainの合成データ受入を検証しています。Linux・WindowsのOS秘密ストアは未対応で、秘密値は環境変数で供給してください。macOSの実機検証は、そのまま署名済み・公証済み配布物や別利用者の自動起動identityでの保証を意味しません。

## 検証した構成

| 構成 | 秘密値の供給 | 確認結果 |
| --- | --- | --- |
| macOS arm64・開発用CLI/常駐プロセス | Keychainまたは明示的な環境変数 | build、移行、再起動、compile、backup/restoreを実機で確認 |
| macOS・署名済み配布物／LaunchAgentの起動identity | Keychain | この候補では未検証。公開前の確認対象 |
| Linux / Windows | 環境変数経路のみ | OS秘密ストア未対応。今回の実機検証対象外 |

旧版は `ff7703244547f323c9bf31e6d4d7f38ef4e2f3af`、候補は改善実装を含む作業ツリーです。両方のmanifest版は0.1.0、schema revisionは8のため、更新証拠では版番号に加えてbinary checksumを記録します。

## 更新手順

1. 現在の版、DBパス、schema revision、daemon利用者を記録します。
2. 旧平文秘密があれば秘密ストア移行を完了し、キーのrotationと旧backupの扱いを確認します。
3. resident Writerを停止し、`cargo run -q -p context-stilld -- backup create --json` と `backup verify --path <backup-path> --json` でbackupを作成・検証します。
4. 候補版へ更新し、同じDBパス・同じ利用者で起動します。readiness、compile、保存済みrunとevalを確認します。
5. 失敗した場合は、秘密参照を読めて当該schema revisionをサポートする版へ戻します。必要なら停止中にbackupを復元し、秘密値を再入力します。

異なるDBパスへコピーしたbackupは秘密値を自動的に復元しません。新しいschema revisionを認識しない旧版で無理に開いたり、revisionの検査を削除しないでください。

旧リビジョン `ff77032` の0.1.0バイナリから候補版への更新は、合成データの知識・run・evalが残り、新しいcompileが保存されることを確認しました。更新前backupを秘密参照対応の候補版で復元する手順も通しています。再現コマンドは `bun run verify:update /absolute/path/to/baseline/context-stilld` です。このfixtureに旧平文秘密は含めず、秘密の移行・再起動・backup・profile照合は `bun run verify:secrets` で別検証します。

初回公開の判定には、Rust compileへの入口統一の継続検証、サポートする署名・自動起動方式の実機検証が必要です。dry-run manifestはこれらの承認前には `releaseEligible: false` と記録します。ローカルbuild成功だけで公開可能とは判定しません。

## 配布物の署名・起動設定の事前確認

`bun run release:preflight --binary /absolute/path/to/context-stilld --team-id YOURTEAMID --launch-agent-plist /absolute/path/to/agent.plist` は読取専用の確認です。Developer ID署名、期待するTeam ID、hardened runtime、署名timestamp、Gatekeeper判定に加え、指定LaunchAgentの設定・実行中のバイナリパス・利用者を照合します。証明書やLaunchAgentを作成・変更しません。`YOURTEAMID`は実際の10文字のTeam IDへ置き換えてください。

不足条件があればJSONのissuesを出して終了コード1を返します。署名が暗号学的に有効でも、ad-hoc署名やローカル用の署名だけでは公開用の署名として合格させません。この検査の成功だけで公開可能にはせず、署名済みの起動identityによるKeychain利用は別途実機受入が必要です。

2026-09-13時点の環境にあった証明書はローカル署名用のみで、Developer ID Application証明書は確認できませんでした。現在の候補は公開用署名・hardened runtime・timestamp・Gatekeeperの条件を満たさず、配布不可のままです。公開用証明書・Team ID・対象LaunchAgentが確定してから事前確認とKeychain受入を行います。
