# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md) | `context_decision` を 90 点以上の品質へ引き上げるため、compile、graph、community、landscape、attractor 指標を統合する実装計画 |
| [Applicability And Evidence Boundary Refactor Plan](applicability-evidence-boundary-refactor-plan.md) | applicability 正規化の共通化、sourceSummary と primary evidence の型分離、negative SQLite runtime 統合テスト追加の段階的実装計画 |
| [Tauri Product Readiness Improvement Plan](tauri-product-readiness-improvement-plan.md) | SQLite/Tauri を default product path にし、PostgreSQL/pgvector を advanced server backend として分離しながら README、配布容易性、プロダクト明瞭性を改善する計画 |
| [Desktop Readiness And Doctor States](desktop-readiness-and-doctor-states.md) | Tauri shell 実装前に固定する desktop data path、first-run state、doctor 表示、desktop readiness smoke の設計メモ |
| [Rust Daemon And CLI Boundary Migration Plan](rust-daemon-cli-boundary-migration-plan.md) | Hono を admin UI facade として維持しながら daemon / CLI / MCP / worker / automation / bootstrap 境界を Rust 化し、TypeScript 実装と完成まで両立させる移行計画 |
