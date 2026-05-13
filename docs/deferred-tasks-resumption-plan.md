# Deferred Tasks Resumption Plan

作成日: 2026-05-13

## 目的

`docs/initial-implementation-plan.md` で意図的に保留した項目を、安全に再開して完了させるための実行計画。

対象は次の2本柱に限定する。

1. テスト拡張
2. doctor 診断粒度拡張

## 実行ステータス

2026-05-13 時点で Phase 1-4 を完了。

2026-05-14 に追加再開した「計画ギャップ解消」も完了。

- `includeTrial` セマンティクス修正（trial のみ注入）
- retrieval mode ごとの knowledge/evidence routing 実装
- code context retrieval 実装（code symbol + file hint fallback）
- lifecycle manager 最小実装
- `bun run verify` / `bun run test:all` 通過

## 対象スコープ

### A. テスト拡張

- repository insert/search の DB integration
- `context_compile` の token budget / degraded reason 境界ケース
- CLI compile JSON 出力の E2E
- MCP tool / resources schema snapshot

### B. doctor 診断拡張

- index freshness
- run health（degraded 傾向）
- DB 基盤診断（接続可否に加え、拡張・主要テーブル・基本件数）

## 完了定義（DoD）

- `bun run verify` が通る
- DB integration test は明示フラグで ON/OFF できる
- doctor が `ok | degraded | failed` を返し、理由を JSON で説明できる
- doctor 出力が CI/手動双方で再利用できる固定 JSON 形式である
- 既存の `context_compile` / importer / MCP server の既存挙動を壊さない

## 実行順序

### Phase 1: Test 基盤整備

目的: DB依存テストを安全に追加できる土台を先に作る。

実装対象:

- `test/helpers/` を新設
  - DB接続可否チェック
  - テスト前後のテーブルクリア
  - integration 実行ガード（例: `MEMORY_ROUTER_RUN_DB_TESTS=1`）
- `package.json` scripts へ integration 用エントリを追加
  - `test:unit`
  - `test:integration`

### Phase 2: Repository / Service Integration Test

目的: 永続化境界と検索境界を固定する。

実装対象:

- `test/repositories.integration.test.ts`
  - knowledge upsert/search（status/type filter含む）
  - evidence source/fragment upsert+search
  - compile run + pack item 永続化
- `test/context-compiler.integration.test.ts`
  - token budget で item が削減されるケース
  - `*_FAILED` と `NO_*_MATCH` の degraded reason 分離
  - `skill_context` の type 優先探索

### Phase 3: CLI / MCP Contract Test

目的: 外部公開インターフェースを固定する。

実装対象:

- `test/cli.compile.e2e.test.ts`
  - `bun run compile --json` の JSON parse 検証
  - 必須フィールド検証（`runId`, `status`, `retrievalMode`, `diagnostics`）
- `test/mcp.contract.test.ts`
  - `context_compile` tool input schema snapshot
  - `resources/list` 名称・URI snapshot
  - `resources/read` の主要応答形 snapshot

### Phase 4: doctor 診断拡張

目的: 「DB到達性のみ」から運用診断へ拡張する。

実装対象:

- `src/shared/schemas/doctor.schema.ts` を追加（出力 SSoT）
- `src/modules/doctor/doctor.service.ts` を追加
  - DB接続
  - `vector` extension 有無
  - 主要テーブル存在チェック
  - 直近 run health（例: 直近20件の degraded 比率）
  - freshness（最新 run 時刻、しきい値超過時 degraded）
- `src/cli/doctor.ts` を service 呼び出しへ置換
- 必要なら `src/mcp/server.ts` resource に `memory-router://health/doctor` を追加

## ファイル変更マップ

- docs
  - `docs/initial-implementation-plan.md`（進捗反映）
  - `docs/deferred-tasks-resumption-plan.md`（本書）
- test
  - `test/helpers/*`
  - `test/repositories.integration.test.ts`
  - `test/context-compiler.integration.test.ts`
  - `test/cli.compile.e2e.test.ts`
  - `test/mcp.contract.test.ts`
- src
  - `src/shared/schemas/doctor.schema.ts`
  - `src/modules/doctor/doctor.service.ts`
  - `src/cli/doctor.ts`
  - （必要時）`src/mcp/server.ts`
- config
  - `package.json` scripts
  - （必要時）`.env.example` に doctor/test 用閾値設定を追加

## リスクと対策

- DB integration の不安定化
  - 対策: 実行フラグで隔離し、unit をデフォルト維持
- snapshot の過剰固定
  - 対策: 仕様上重要なフィールドのみ固定し、時刻/IDは正規化
- doctor の責務肥大化
  - 対策: 初回は read-only health 診断に限定し、修復機能は入れない

## 受け入れチェックリスト

- [x] `test:unit` / `test:integration` の分離ができている
- [x] 保留していた4系統のテスト項目がすべて実装されている
- [x] doctor が `status` と `reasons` を返す
- [x] doctor が freshness / degraded rate を返す
- [x] `bun run verify` が通る
- [x] 2026-05-14 の計画ギャップ解消項目が実装・検証済み
