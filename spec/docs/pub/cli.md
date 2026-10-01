# CLI Reference

Run commands from the repository root.

## Setup and Health

| Command | Description |
|---|---|
| `bun run startup` | Interactive dry-run startup and health plan for the advanced server setup path |
| `bun run startup -- --apply` | Apply advanced server startup changes after review |
| `bun run init:project -- --json` | Initialize project state and print next actions |
| `bun run setup:mcp-config` | Write URL-based MCP registration for Codex and Antigravity |
| `bun run doctor` | Full health report |
| `bun run db:migrate` | Apply database migrations |
| `bun run db:seed` | Upsert seed knowledge |
| `bun run db:seed:export` | Export knowledge seed data |

## Rust Daemon Boundary Preview

`context-stilld` is the Rust boundary host under migration. It is safe to use for path/status/preflight inspection and delegated lifecycle experiments, but it is not the default replacement for TypeScript commands yet.

| Command | Description |
|---|---|
| `cargo run -q -p context-stilld -- paths --json` | Resolve app data, logs, run, backup, and SQLite paths |
| `cargo run -q -p context-stilld -- status --json` | Report Rust-managed process state from pid/state files |
| `cargo run -q -p context-stilld -- bootstrap preflight --json` | Read-only first-run readiness summary |
| `cargo run -q -p context-stilld -- bootstrap init --json` | Explicitly create app data/logs/run/backup directories |
| `cargo run -q -p context-stilld -- doctor summary --json` | Desktop-focused summary that delegates full detail to `bun run doctor` |
| `cargo run -q -p context-stilld -- backup preflight --json` | Check SQLite path and active managed writers before an offline Rust backup |
| `cargo run -q -p context-stilld -- backup preflight --require-idle --json` | Fail if Rust-managed writer processes are active |
| `bun run sqlite:backup --json` | Create an offline backup after stopping the resident writer |
| `bun run sqlite:backup:verify --path /absolute/backup.sqlite --json` | Verify integrity, references, schema and SHA-256 without modifying the file |
| `bun run verify:onboarding` | Isolated first-use, dependency recovery and backup/restore smoke |
| `cargo run -q -p context-stilld -- mcp endpoint --json` | Print the daemon-owned streamable HTTP MCP endpoint URL and readiness |
| `cargo run -q -p context-stilld -- mcp status --json` | Report the managed MCP endpoint worker state |
| `cargo run -q -p context-stilld -- mcp sessions --json` | List daemon-visible MCP sessions and close reasons |
| `cargo run -q -p context-stilld -- mcp smoke --json` | Check endpoint readiness and exposed tool inventory |
| `cargo run -q -p context-stilld -- mcp start\|stop` | Legacy endpoint-worker lifecycle helper; clients should use URL registration, not command spawning |
| `cargo run -q -p context-stilld -- queue start\|stop\|status` | Run Rust queue maintenance, stop stale managed state, or report queue scheduler status |
| `cargo run -q -p context-stilld -- queue inspect --json` | Read live SQLite queue counts, active provider leases, active target ids, worker pid, and last heartbeat |
| `cargo run -q -p context-stilld -- agent-log-sync run\|stop\|status` | Delegate agent log sync lifecycle |
| `cargo run -q -p context-stilld -- agent-log-sync run --wait --json` | Run one-shot sync and record exit status |
| `cargo run -q -p context-stilld -- admin-api start\|stop\|status` | Start/stop Hono admin API for UI/operator sessions only; start waits for readiness |
| `cargo run -q -p context-stilld -- runtime sidecars --json` | List remaining TypeScript sidecars, fallback classifications, runtime status, and removal task ids |

Focused pre-switch smoke scripts:

```bash
bun run rust:mcp:smoke
bun run rust:queue:smoke
bun run rust:admin-api:smoke
bun run rust:agent-log-sync:smoke
```

The `CONTEXT_STILL_DAEMON_MANAGED_MCP`, `CONTEXT_STILL_DAEMON_MANAGED_QUEUE`, `CONTEXT_STILL_DAEMON_MANAGED_AGENT_LOG_SYNC`, and `CONTEXT_STILL_DAEMON_MANAGED_ADMIN_API` flags are currently observable in `status --json`; they do not change package script defaults yet.

## Compile and Knowledge

| Command | Description |
|---|---|
| `bun run compile --goal "<goal>" --repo-path "$PWD"` | Compile task-specific context |
| `bun run eval:context` | Run deterministic context evaluation tooling |
| `bun run import:wiki <path>` | Import Markdown source tree |
| `bun run import:markdown <file>` | Import one Markdown file |
| `bun run backfill:knowledge-project-context` | Backfill project context metadata |
| `bun run backfill:knowledge-value` | Backfill value metrics |
| `bun run backfill:knowledge-source-links` | Backfill source evidence links |
| `bun run backfill:knowledge-origin-links` | Backfill origin trace links |
| `bun run knowledge:apply-feedback-quality` | Apply feedback-derived quality adjustments |

## Decisions

| Command | Description |
|---|---|
| `bun run decision:pr-discard-scan -- --dry-run` | Preview `discarded_pr` feedback for closed PRs linked from Context Decision metadata |
| `bun run decision:pr-discard-scan -- --apply` | Create `discarded_pr` system feedback and effects for confirmed closed linked PRs |
| `bun run decision:pr-discard-scan -- --since <iso-date>` | Limit the scan to recent decision runs |

## Distillation Queue

| Command | Description |
|---|---|
| `bun run queue:finding:once` | Run one finding-candidate cycle |
| `bun run queue:episode-distiller:once` | Run one episode-distiller cycle |
| `bun run queue:covering:once` | Run one evidence-coverage cycle |
| `bun run queue:merge-review:once` | Run one DeadZone merge-review cycle |
| `bun run queue:finalize:once` | Run one finalization cycle |
| `bun run queue:merge-activation-finalize:once` | Run one merge-activation finalization cycle |
| `bun run queue:migrate:dry-run` | Preview queue migration mapping |
| `bun run queue:migrate:write` | Write queue migration mapping rows |
| `bun run distill:reprocess-rejected` | Reprocess rejected candidates where eligible |

## Agent Logs and Automation

| Command | Description |
|---|---|
| `bun run sync:agent-logs` | One-time Codex / Antigravity / Claude log sync |
| `bun run automation:context-stilld -- install` | Install macOS LaunchAgent for resident `context-stilld run` |
| `bun run automation:context-stilld -- load` | Load resident daemon and unload legacy queue / agent-log-sync LaunchAgent owners |
| `bun run automation:context-stilld -- status` | Inspect resident daemon LaunchAgent and legacy owner state |

## Landscape

| Command | Description |
|---|---|
| `bun run landscape -- --window-days 30` | Generate a landscape snapshot |
| `bun run landscape -- --window-days 30 --json` | Emit full snapshot JSON |
| `bun run landscape -- --queue --queue-source replay_compare,landscape_snapshot` | Materialize review items |
| `bun run landscape -- --queue-list --queue-status pending` | List review items |
| `bun run landscape -- --queue-create-candidates --queue-status pending` | Create candidate drafts from review items |

## Development and Verification

| Command | Description |
|---|---|
| `bun run dev` | Start Vite dev server with API |
| `bun run start:api` | Start API server |
| `cargo run -q -p context-stilld -- mcp start` | Start the local streamable HTTP MCP endpoint |
| `bun run typecheck` | TypeScript check |
| `bun run lint` | Biome lint |
| `bun run format:check` | Biome format check |
| `bun run test:unit` | Unit tests |
| `bun run test:integration` | Destructive integration tests against a test DB |
| `bun run verify` | Daily fast quality gate without DB/MCP/queue dependencies |
| `bun run verify:fast` | Alias for the daily fast quality gate |
| `bun run verify:sqlite` | SQLite local backend verification |
| `bun run verify:desktop-readiness` | Desktop/local readiness preflight |
| `bun run verify:mcp` | Rust MCP endpoint smoke plus SQLite MCP smoke |
| `bun run verify:queue:smoke` | Queue operational smoke against a test DB |
| `bun run verify:full` | Release/full gate: fast verify, SQLite verify, and Rust daemon verify |

## Examples

```bash
bun run compile --goal "fix context compiler ranking" \
  --repo-path "$PWD" \
  --change-types bugfix,backend \
  --technologies bun,typescript \
  --domains context-compiler \
  --json
```

```bash
bun run landscape -- --queue-create-candidates --queue-status pending --queue-limit 20
bun run queue:covering:once
```

## Wiki CLI

同じMacの信頼する呼出元向けに、専用領域の一覧・読取り・作成・更新を提供します。本文は明示したUTF-8ファイルまたはstdinからだけ取得します。

サーバー側では既存Wiki/GitとGit identityを用意し、環境に次を指定します。CLIがサービスやGitを自動初期化することはありません。

- CONTEXT_STILL_WIKI_CLI_NAMESPACE: 専用領域のslug（例 notes）。未設定なら入口は無効。
- CONTEXT_STILL_DB_BACKEND=sqlite: CLI書込みはSQLiteのみ対応。
- CONTEXT_STILL_EMBEDDING_PROVIDER=disabled: 初期版のCLI書込みで必要。本文と検索用テキスト断片は登録されます。
- CONTEXT_STILL_ADMIN_API_KEY: 既存管理キー。CLI側にも秘密を扱う仕組みから環境へ渡します。

CLIの接続先は CONTEXT_STILL_WIKI_API_URL、既定値は http://127.0.0.1:39170 です。明示port付きの数値loopback HTTPだけを許可し、redirectは拒否します。MCP接続先や.envを探索しません。Bun自体の.env読取りも避けるには、以下のように --no-env-file を指定します。

~~~bash
bun --no-env-file /absolute/path/contextStill/src/cli/context-still.ts wiki list --json
bun --no-env-file /absolute/path/contextStill/src/cli/context-still.ts wiki get notes/example --json
bun --no-env-file /absolute/path/contextStill/src/cli/context-still.ts wiki get notes/example --format markdown
~~~

書込みではUUIDを生成して呼出元で保存し、同じ本文・オプションと組にして再試行時にも使用します。createにはtitle、updateにはgetで得たversionが必要です。--stdinと--file、--extractと--no-extractは、それぞれ一方だけを指定します。初期版はWiki抽出workerが版固定に対応していないため、--extractを保存前にEXTRACTION_UNSUPPORTEDで拒否します。

~~~bash
REQUEST_ID="$(uuidgen)"
# REQUEST_IDを呼出元の状態へ保存する。再試行では再生成しない。
bun --no-env-file /absolute/path/contextStill/src/cli/context-still.ts wiki create notes/example \
  --title "題名" --file ./note.md --no-extract --request-id "$REQUEST_ID" --json
# VERSIONはget --jsonのpage.versionを取得し、次のrequest IDとともに保存する。
bun --no-env-file /absolute/path/contextStill/src/cli/context-still.ts wiki update notes/example \
  --file ./note.md --if-version "$VERSION" --no-extract --request-id "$REQUEST_ID" --json
~~~

get --format markdownは本文だけを返します。入力のfrontmatterは拒否し、updateでは既存metaと省略したtitleを維持します。本文は8MiB以下、JSON requestと保存Markdownは16MiB以下、応答は32MiB以下、一覧は1000件までです。slugはNFCで指定し、全体1024 UTF-8 bytes、segmentごと255 bytesまでです。大文字小文字の別表記による同一ファイルへのアクセスは拒否します。無効なslug、領域外、symlink、Gitのignore対象、古い版、他のstage済み変更、対象ページの手動変更は拒否します。保存前に共通の秘密除去とMarkdownのサニタイズを行います。

JSON応答のfileState、indexState、extractionState、knowledgeStateは別の状態です。indexState=readyはソースと検索用断片の反映であり、蒸留済みKnowledgeやSAAAのsearch_knowledgeへの反映を意味しません。管理キー自体は既存管理APIにもアクセスできるため、この領域制限は信頼するクライアント向けです。

終了コードは0=成功、1=内部エラー、2=入力/サイズ/未対応機能、3=接続設定/認証、4=対象なし、5=既存/競合、6=接続/timeout/依存先/lock busy、7=部分完了です。JSONモードは単一JSONをstdoutへ返します。

### 部分完了と復旧

終了7ではphaseとoperationIdを確認し、同じrequest IDと同じ入力で再実行します。Git保存後の索引失敗は、新しいcommitを作らず索引処理を再試行します。同じIDの別入力は409で拒否します。完了済みIDの再試行は当時の結果を返すため、現在版が必要ならgetを行います。

WRITE_OUTCOME_UNKNOWN（終了6）は書込み結果が不明です。自動再送は行いません。同じID・同じ入力で明示的に再試行します。未完了ページへ新しいIDで書き込むことはできず、未完了operationがある間は既存管理UIのWiki変更も停止します。

operation記録は既存アプリデータ領域のrun/wiki配下へ、Wiki rootのSHA-256ごとのowner-onlyディレクトリに保存します。共有lockとruntimeの対応記録はGitディレクトリ内のwiki-cliに置きます。これにより別のアプリデータ設定からも同じlockを使います。異なるoperation領域への切替えはWIKI_RUNTIME_MISMATCHで拒否します。記録には本文・キーを保存しません。記録は自動削除せず、10000件で新規書込みを停止します。既存IDの再試行と読取りは可能です。

プロセス終了後にlockが残った場合はGitディレクトリ内のwiki-cli/write.lock/owner.jsonのpidを確認し、該当APIと同時writerを停止した上で、保存MarkdownのhashとGit履歴・operation記録を照合します。pidが不明または生存する間はlockを除去しません。確証がある場合だけ管理者が残存lockを取り除き、同じIDで再試行します。operation記録の削除、git reset/stash、部分保存の自動rollbackは行いません。RECOVERY_REQUIREDが続く場合は管理者が照合を完了するまで変更を停止します。

既存importerや手動Git操作など、共通lockに参加しないwriterを同時に動かさないでください。

操作記録が破損している場合や、Git indexの対象内容が操作の保存版と異なる場合はRECOVERY_REQUIREDで停止し、手動stageを上書きしません。別ページのcommitが後から追加されても、対象ページのoperation markerと保存hashが一致すれば未完phaseを復旧します。writer不調による復旧失敗も、既に保存済みなら部分完了（終了7）のまま返します。CLIはHTTP statusだけで成功判定せず、応答の状態・slug・operationIdを照合します。
