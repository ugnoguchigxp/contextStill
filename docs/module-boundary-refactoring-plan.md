# モジュール境界リファクタリング計画: knowledge lifecycle と distillation target

この計画は、`src/modules/lifecycle` と `src/modules/distillationRepair` を廃止し、実際の責務に合う既存ドメインへ統合するための実装計画である。対象は次の2つに限定する。

- ナレッジステータス遷移・検索ステータス解決を `src/modules/knowledge` へ統合する。
- 蒸留ターゲットの選択・状態遷移・メンテナンス・修復を `src/modules/distillationTarget` へ統合する。

このリファクタリングでは API 仕様、DB schema、MCP tool 名、CLI 引数、ビジネス上の状態遷移ルールは変更しない。主目的は物理モジュール名と責務を一致させ、今後の修復・再実行・優先度制御の変更箇所を明確にすることである。

## 1. 現状確認

### 1.1 `lifecycle` の実態

現行ファイルは `src/modules/lifecycle/lifecycle.service.ts` のみで、次の2関数を提供している。

- `canTransitionKnowledgeStatus(from, to)`: `KnowledgeStatus` の許可遷移を判定する。
- `resolveKnowledgeSearchStatuses({ retrievalMode, includeDraft })`: knowledge search で対象にする status を解決する。

参照元は次の2箇所に限定される。

- `src/mcp/tools/knowledge.tool.ts`
- `src/modules/knowledge/knowledge.service.ts`

この責務はシステム全体の lifecycle ではなく `knowledgeItems` の lifecycle であるため、独立した `lifecycle` モジュールではなく `knowledge` モジュール内に置く。

### 1.2 `selectDistillationTarget` / `distillationRepair` の実態

現行の `src/modules/selectDistillationTarget` は、名前上は選択処理に見えるが、実際には次を含む。

- `domain.ts`: 蒸留ターゲット種別、候補、選択ロジック。
- `inventory.service.ts`: kind ごとの対象候補収集。
- `repository.ts`: claim、release、状態更新系 repository の再 export。
- `repository-state-transitions.ts`: target state の作成・claim・pause・complete などの永続化。
- `repository-maintenance.ts`: retryable paused の release、stale running の recovery、統計取得。
- `manual-pause.ts`: manual pause 判定。
- `priority-group.ts`: 優先度グループ解決。
- `repository-helpers.ts`: 時刻・stale threshold など repository 補助。

`src/modules/distillationRepair/repair.service.ts` は、上記の `repository` / `manual-pause` / `priority-group` に強く依存し、`distillationTargetStates` の状態を診断・修復する service である。これは LLM 実行やプロンプトを扱う `src/modules/distillation` ではなく、蒸留ターゲット状態管理のユースケースとして `distillationTarget` に統合する。

### 1.3 空ディレクトリ

`src/modules/distillationPipeline` は現時点で空ディレクトリである。参照と中身がないことを実装直前に再確認したうえで削除する。

確認コマンド:

```bash
find src/modules/distillationPipeline -maxdepth 2 -print -ls
rg -n "distillationPipeline" src test docs package.json
```

## 2. 目標構造

実装後の `src/modules` 配下は次の境界にする。

```text
src/modules/
  knowledge/
    knowledge-lifecycle.service.ts
    knowledge.service.ts
    knowledge.repository.ts
    ...
  distillationTarget/
    domain.ts
    inventory.service.ts
    manual-pause.ts
    priority-group.ts
    repair.service.ts
    repository.ts
    repository-helpers.ts
    repository-maintenance.ts
    repository-state-transitions.ts
```

廃止するパス:

- `src/modules/lifecycle/`
- `src/modules/distillationRepair/`
- `src/modules/selectDistillationTarget/`
- `src/modules/distillationPipeline/`（空であることを再確認してから削除）

`src/modules/distillation/` は LLM 実行・プロンプト・証拠取得の境界として維持し、今回の移動先にはしない。

## 3. 境界ルール

### 3.1 `knowledge` lifecycle

`knowledge-lifecycle.service.ts` は DB に触れない純粋な domain service とする。

- `KnowledgeStatus` の遷移表を持つ。
- retrieval mode と `includeDraft` から検索対象 status を返す。
- `knowledge.repository.ts` や MCP tool から呼ばれても副作用を持たない。
- API schema、MCP schema、DB schema は変更しない。

### 3.2 `distillationTarget` service / repository

`distillationTarget` 配下では、service と repository の責務を次のように分ける。

- `repair.service.ts` はユースケース層とする。
- `repair.service.ts` は CLI 入力、設定値、dry-run/apply、action report、manual review の要否、file lock 削除の安全判定を扱う。
- `repository-maintenance.ts` は DB 永続化と集計を担当する。
- repository 関数は引数で渡された `staleSeconds`、`maxAttempts`、`limit`、`distillationVersion` を使い、CLI policy や表示用 report の判断を持たない。
- 今回の主目的は物理境界の整理であり、状態遷移の仕様変更はしない。

現行 `repository-maintenance.ts` には `APP_CONSTANTS` を参照する既定値処理がある。責務分離を完全にする場合は、移動後の追加 PR で既定値解決を `repair.service.ts` または呼び出し元 service に寄せ、repository は明示引数を要求する形へ縮小する。ただし、この追加整理は今回の import 移動と同時に行うと差分が大きくなるため、下記の Workstream 4 に分ける。

## 4. 影響範囲

実装前に次のコマンドで現行参照を再取得し、ここに列挙したファイルとの差分があれば追加で修正する。

```bash
rg -n "lifecycle\.service|selectDistillationTarget|distillationRepair|distillationPipeline" src test --glob '*.ts'
rg --files test | rg '(lifecycle|select-distillation-target|distillation-repair|find-candidate)'
```

### 4.1 production code

`lifecycle` 移動で修正するファイル:

- `src/mcp/tools/knowledge.tool.ts`
- `src/modules/knowledge/knowledge.service.ts`

`selectDistillationTarget` から `distillationTarget` へのリネームで修正するファイル:

- `src/modules/doctor/inspectors/distillation-run.inspector.ts`
- `src/modules/findCandidate/domain.ts`
- `src/modules/findCandidate/repository.ts`
- `src/modules/landscape/landscape-review-candidate.repository.ts`
- `src/modules/registerCandidate/register-candidate.service.ts`

`distillationRepair` 統合で修正するファイル:

- `src/cli/distill-repair.ts`
- `src/modules/distillationTarget/repair.service.ts`（移動後の内部 import）

### 4.2 test code

`lifecycle` 移動で修正・リネームするテスト:

- `test/lifecycle.service.test.ts` -> `test/knowledge-lifecycle.service.test.ts`

`selectDistillationTarget` リネームで修正・リネームするテスト:

- `test/select-distillation-target.test.ts` -> `test/distillation-target.test.ts`
- `test/select-distillation-target-helpers.test.ts` -> `test/distillation-target-helpers.test.ts`
- `test/select-distillation-target-inventory.test.ts` -> `test/distillation-target-inventory.test.ts`
- `test/select-distillation-target-maintenance.test.ts` -> `test/distillation-target-maintenance.test.ts`
- `test/select-distillation-target-repository.test.ts` -> `test/distillation-target-repository.test.ts`
- `test/select-distillation-target-repository-full.test.ts` -> `test/distillation-target-repository-full.test.ts`

import だけを修正するテスト:

- `test/distillation-repair.service.test.ts`
- `test/find-candidate.test.ts`
- `test/find-candidate-repository.test.ts`（参照がある場合）

## 5. 実装手順

### Workstream 1: `knowledge` lifecycle 統合

1. `src/modules/lifecycle/lifecycle.service.ts` を `src/modules/knowledge/knowledge-lifecycle.service.ts` に移動する。
2. `test/lifecycle.service.test.ts` を `test/knowledge-lifecycle.service.test.ts` に移動する。
3. import を次のように変更する。

```ts
// src/mcp/tools/knowledge.tool.ts
import { canTransitionKnowledgeStatus } from "../../modules/knowledge/knowledge-lifecycle.service.js";

// src/modules/knowledge/knowledge.service.ts
import { resolveKnowledgeSearchStatuses } from "./knowledge-lifecycle.service.js";
```

4. `src/modules/lifecycle/` が空になったら削除する。
5. `rg -n "lifecycle\.service|modules/lifecycle|../lifecycle" src test` が 0 件であることを確認する。
6. `bunx vitest run test/knowledge-lifecycle.service.test.ts` を実行する。
7. `bun run typecheck` を実行する。

受け入れ条件:

- `KnowledgeStatus` の許可遷移が変更されていない。
- `learning_context` と `includeDraft` の検索 status 解決が変更されていない。
- MCP tool の `update_knowledge` は既存と同じ遷移拒否を行う。

### Workstream 2: `selectDistillationTarget` を `distillationTarget` にリネーム

1. `src/modules/selectDistillationTarget/` を `src/modules/distillationTarget/` にリネームする。
2. production code の import を `../distillationTarget/...` または `../../distillationTarget/...` へ変更する。
3. test file 名を `select-distillation-target-*` から `distillation-target-*` へ変更する。
4. test 内の `vi.mock(...)` と dynamic import の文字列もすべて `distillationTarget` へ変更する。
5. describe 名は必要に応じて `distillationTarget ...` に直す。関数名 `selectDistillationTarget` は公開 domain 関数名として維持してよい。
6. `rg -n "selectDistillationTarget|select-distillation-target" src test` を実行する。
7. import path と test file 名の旧名は 0 件にする。ただし関数名 `selectDistillationTarget` と describe 文に残すかどうかは意図的に判断する。
8. 対象テストを実行する。

対象テスト:

```bash
bunx vitest run \
  test/distillation-target.test.ts \
  test/distillation-target-helpers.test.ts \
  test/distillation-target-inventory.test.ts \
  test/distillation-target-maintenance.test.ts \
  test/distillation-target-repository.test.ts \
  test/distillation-target-repository-full.test.ts \
  test/find-candidate.test.ts \
  test/find-candidate-repository.test.ts
```

受け入れ条件:

- `src/modules/selectDistillationTarget/` が存在しない。
- production import に `selectDistillationTarget` path が残っていない。
- test の mock path と dynamic import path が新 path に揃っている。
- domain 関数 `selectDistillationTarget` の挙動は変更されていない。

### Workstream 3: `distillationRepair` を `distillationTarget` に統合

1. `src/modules/distillationRepair/repair.service.ts` を `src/modules/distillationTarget/repair.service.ts` に移動する。
2. 移動後の内部 import を同一モジュール内の `./priority-group.js`、`./domain.js`、`./manual-pause.js`、`./repository.js` に変更する。
3. `src/cli/distill-repair.ts` の import を `../modules/distillationTarget/repair.service.js` に変更する。
4. `test/distillation-repair.service.test.ts` の import と mock path を `distillationTarget` に変更する。
5. `src/modules/distillationRepair/` が空になったら削除する。
6. `src/modules/distillationPipeline/` が空で、実参照がないことを再確認して削除する。
7. 旧 path 検索を実行する。

```bash
rg -n "distillationRepair|modules/distillationRepair|distillationPipeline" src test docs package.json
```

8. 対象テストと CLI dry-run を実行する。

```bash
bunx vitest run test/distillation-repair.service.test.ts test/distillation-target-maintenance.test.ts
bun run src/cli/distill-repair.ts --kind auto --json
```

DB 接続が必要な環境では、既存の test DB default に合わせて次の形で実行する。

```bash
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/memory_router_test} \
  bun run src/cli/distill-repair.ts --kind auto --json
```

受け入れ条件:

- `runDistillationRepair` の report shape が変更されていない。
- `--kind auto|wiki|vibe|candidate|web`、`--version`、`--limit`、`--stale-seconds`、`--max-attempts`、`--apply`、`--json` の CLI 引数が維持されている。
- dry-run では DB 更新や lock 削除が行われない。
- apply 時だけ safe action が適用される。

### Workstream 4: repository policy の後続整理

この workstream は Workstream 1-3 の import 移動が通った後に行う。差分を小さく保つため、同じ PR に含める場合でもコミットまたは review 単位を分ける。

1. `repository-maintenance.ts` の関数が `APP_CONSTANTS` に依存している箇所を洗い出す。
2. `recoverStaleDistillationTargets`、`releaseRetryablePausedDistillationTargets`、統計取得関数について、既定値解決を呼び出し元 service へ寄せられるか判断する。
3. repository 関数の引数を必須化する場合は、既存 caller と tests を同時に更新する。
4. 状態遷移の意味、retry 上限、manual pause、skipped/completed/pending の扱いは変更しない。

受け入れ条件:

- repository は永続化・集計中心になり、CLI/report policy を持たない。
- service は dry-run/apply、既定値、warning、manual review 要否を組み立てる。
- DB row の更新内容が既存テストで保証されている。

## 6. 検証計画

### 6.1 workstream ごとの最小検証

Workstream 1 後:

```bash
bunx vitest run test/knowledge-lifecycle.service.test.ts
bun run typecheck
```

Workstream 2 後:

```bash
bunx vitest run \
  test/distillation-target.test.ts \
  test/distillation-target-helpers.test.ts \
  test/distillation-target-inventory.test.ts \
  test/distillation-target-maintenance.test.ts \
  test/distillation-target-repository.test.ts \
  test/distillation-target-repository-full.test.ts \
  test/find-candidate.test.ts \
  test/find-candidate-repository.test.ts
bun run typecheck
```

Workstream 3 後:

```bash
bunx vitest run test/distillation-repair.service.test.ts test/distillation-target-maintenance.test.ts
bun run src/cli/distill-repair.ts --kind auto --json
bun run typecheck
```

### 6.2 repo gate

最終的に次を実行する。

```bash
bun run verify
```

`bun run verify` は現行 `package.json` 上、次を含む。

- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `bun run test:unit`
- `bun run build:web`

MCP tool の import 変更まで含めて疎通確認する場合は、追加で次を実行する。

```bash
bun run verify:mcp
```

`verify:mcp` は test DB への migration、MCP contract test、MCP smoke、doctor を含む。Postgres test DB が起動していない環境では失敗するため、その場合は DB 起動状態を明記して再実行する。

### 6.3 旧名残存チェック

最終差分では、次の検索を実行して旧 module path が残っていないことを確認する。

```bash
rg -n "modules/lifecycle|../lifecycle|lifecycle\.service" src test
rg -n "modules/selectDistillationTarget|../selectDistillationTarget|../../selectDistillationTarget" src test
rg -n "modules/distillationRepair|../distillationRepair|distillationRepair" src test
rg -n "distillationPipeline" src test docs package.json
```

`selectDistillationTarget` という関数名を残す場合は、path ではなく domain 関数名として残っていることを確認する。

## 7. ロールバック方針

この変更は DB schema と public tool/CLI contract を変えないため、ロールバックはファイル移動と import path の復元で対応できる。

- Workstream 1 で問題が出た場合は `knowledge-lifecycle.service.ts` を `lifecycle.service.ts` に戻し、2つの import を戻す。
- Workstream 2 で問題が出た場合は `distillationTarget` ディレクトリ名と test file 名を旧名へ戻し、import path を戻す。
- Workstream 3 で問題が出た場合は `repair.service.ts` を `distillationRepair` へ戻し、CLI と test import を戻す。
- Workstream 4 は責務整理を含むため、Workstream 1-3 とは別コミットにしておくと切り戻しが容易になる。

## 8. 完了条件

この計画の完了条件は次の通り。

- `src/modules/lifecycle/`、`src/modules/selectDistillationTarget/`、`src/modules/distillationRepair/`、空の `src/modules/distillationPipeline/` が存在しない。
- `src/modules/knowledge/knowledge-lifecycle.service.ts` が lifecycle 関数を提供している。
- `src/modules/distillationTarget/repair.service.ts` が `runDistillationRepair` を提供している。
- production code と test code の import path が新モジュール名に揃っている。
- `bun run verify` が成功している。
- MCP 疎通まで確認する場合は `bun run verify:mcp` も成功している、または test DB 未起動などの環境要因が明記されている。
