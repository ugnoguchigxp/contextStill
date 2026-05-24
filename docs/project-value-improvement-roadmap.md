# memory-router 価値向上ロードマップ

> 対象: ドキュメンテーション、テストカバレッジ向上、軽微な不具合修正を除く価値向上施策
> 作成日: 2026-05-25

## 基本方針

memory-router の価値を上げる主戦場は、品質衛生ではなく「使い続ける理由」と「効果を証明できること」にある。

短期的には local-first MCP memory として十分に価値がある。次の段階では、単なる記憶DBやRAGではなく、実利用で改善され、導入効果を測定できる agent knowledge platform に寄せる。

## 優先施策

| 優先 | 施策 | 作るもの | 価値 |
|---:|---|---|---|
| 1 | Context 品質の評価エンジン | `eval:context` CLI、評価DB、before/after ダッシュボード | memoryRouter を使うと何が良くなるかを証明できる |
| 2 | Active-use feedback loop | context pack への `used` / `not_used` / `wrong` / `missing` 記録、再ランキング、自動 demote 候補 | ナレッジが実利用で育つ |
| 3 | 導入を local appliance 化 | setup wizard、daemon manager、DB/LLM/embedding 状態の self-heal | 初回導入と日常運用の摩擦が大きく下がる |
| 4 | Knowledge pack の import/export | repo/team 単位の knowledge bundle、versioning、差分適用 | OSS/チーム利用で再利用可能な資産になる |
| 5 | Agent integration の拡張 | Claude Code / Cursor / Cline / VS Code などの adapter | MCP サーバーから実際に使う製品へ寄る |
| 6 | Queue と蒸留の自律運用 | backlog triage、provider pressure、cost budget、priority policy UI | 放置しても知識基盤が腐りにくい |
| 7 | Review/Approval workflow の製品化 | 承認キュー、変更理由、影響範囲、rollback、bulk operation | 個人ツールからチーム運用ツールになる |
| 8 | Security / privacy controls | secret redaction、source access policy、workspace isolation、audit export | 企業・業務コードで使いやすくなる |
| 9 | "Why this context?" explainability | 選出理由、落選理由、代替候補、source/evidence chain の UI | 信頼して使える。デバッグも速い |
| 10 | Plugin / extension API | source connector、ranking policy、provider、exporter の拡張点 | プロジェクト固有運用へ適応しやすい |

## 1. Context 品質の評価エンジン

最優先。これはテストカバレッジではなく、プロダクト価値そのものの計測である。

過去タスクを replay して、memoryRouter あり/なし、設定 A/B、knowledge pruning 前後で以下を比較できるようにする。

- 必要な knowledge が context pack に入ったか
- 不要な knowledge が減ったか
- `No Content` / `degraded` が減ったか
- ユーザー修正や追加指示が減ったか
- compile duration と token budget が悪化していないか

開発物:

- `bun run eval:context`
- 評価ケース定義テーブルまたは JSONL
- context pack replay runner
- expected knowledge / forbidden knowledge / missing knowledge の判定
- before/after 比較レポート
- Admin UI の Eval ダッシュボード

期待効果:

README の主張ではなく、実測で価値を説明できる。ranking 変更、provider 設定、knowledge 整理の意思決定も数値で判断できる。

## 2. Active-use feedback loop

active knowledge が増えるほど、検索品質は自然に劣化する。compile 結果に対して実利用フィードバックを集め、ranking と lifecycle に戻す必要がある。

開発物:

- context pack item 単位の `used` / `not_used` / `wrong` / `missing` 記録
- UI からの lightweight feedback 操作
- MCP/CLI からの feedback 登録
- ranking score への反映
- demote / refine appliesTo / split / merge の review candidate 生成
- feedback による regression watch

期待効果:

使うほど knowledge base が締まる。未使用 active knowledge の増加を単なる警告ではなく、改善ループに変換できる。

## 3. Local appliance 化

現状は Postgres、pgvector、LLM、embedding、LaunchAgent、MCP 設定が絡む。価値は高いが、導入と保守の摩擦が大きい。

開発物:

- `memory-router setup` の対話式 wizard
- DB / migration / pgvector / daemon / MCP config の一括検査
- LaunchAgent / Windows Task の status / install / load / restart 管理
- stale worker、stale lock、壊れた test DB migration 履歴の self-heal 提案
- doctor の修復アクション連携

期待効果:

外部利用者の脱落率が下がる。local-first であることが「面倒」ではなく「制御できる」に変わる。

## 4. Knowledge pack import/export

repo で育てた知識を移植可能な成果物にする。

開発物:

- `memory-router export --repo <path>`
- `memory-router import <bundle>`
- bundle metadata、schema version、source link、evaluation result
- 差分 preview と conflict resolution
- team / repo / global scope の扱い

期待効果:

OSS 配布、チーム内共有、環境移行がしやすくなる。memoryRouter の成果物が DB 内だけに閉じなくなる。

## 5. Agent integration の拡張

MCP tool surface は中核だが、利用体験は agent 側の導線で決まる。

開発物:

- Claude Code / Cursor / Cline / VS Code などの adapter
- agent ごとの bootstrap instruction 生成
- context pack の貼り付け・参照・feedback の往復導線
- agent log parser の拡張

期待効果:

memoryRouter が「MCP サーバー」から「複数 agent で使える知識基盤」になる。

## 6. Queue と蒸留の自律運用

distillation backlog は価値の源泉だが、放置すると運用負債にもなる。

開発物:

- backlog triage
- priority policy UI
- provider pressure / rate limit aware scheduling
- cost budget と stop policy
- paused / retryable / stale running の自動分類
- long-running worker の progress visibility

期待効果:

蒸留が止まりにくくなる。大量 source / vibe memory を入れても、運用者が毎回手で直す必要が減る。

## 7. Review/Approval workflow の製品化

チーム利用では、knowledge の自動昇格よりも「なぜこの知識を入れるのか」を管理できることが価値になる。

開発物:

- approval queue
- reviewer assignment
- 変更理由、影響範囲、source evidence の集約
- rollback / deprecate / bulk operation
- approval policy

期待効果:

個人ツールからチーム運用ツールへ寄る。自動蒸留の信頼境界を明確化できる。

## 8. Security / privacy controls

業務コードに入るには、local-first だけでは足りない。何を取り込まないか、何を外部 provider に送らないかを制御する必要がある。

開発物:

- secret redaction
- source access policy
- provider routing policy
- workspace isolation
- audit export
- external fetch / web search の許可境界

期待効果:

企業・業務リポジトリに導入しやすくなる。local-first の訴求が実運用上の安全性に変わる。

## 9. "Why this context?" explainability

context pack の信頼性は、選ばれた理由だけでなく、選ばれなかった理由まで見えると上がる。

開発物:

- selected reason
- suppressed reason
- alternative candidates
- source/evidence chain
- ranking factor breakdown
- UI 上の compare view

期待効果:

context が外れたときに原因を特定しやすい。ranking 改善とユーザー信頼の両方に効く。

## 10. Plugin / extension API

プロジェクトごとの source、ranking、provider、export 需要に合わせるには、コアに全部入れるより拡張点が必要になる。

開発物:

- source connector API
- ranking policy hook
- provider adapter interface
- export/import format hook
- project-local extension discovery

期待効果:

memoryRouter を汎用コアとして保ちながら、個別プロジェクトに深く適応できる。

## 推奨実行順

1. `eval:context` と評価ダッシュボード
2. feedback loop と ranking/lifecycle への反映
3. setup / daemon / self-heal の local appliance 化
4. knowledge pack import/export
5. agent adapters と team approval workflow

この順番なら、まず価値を測定できるようにし、その測定結果を改善ループへ接続し、その後に導入性と共有性を広げられる。
