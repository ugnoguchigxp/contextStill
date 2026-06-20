# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [Episodic Memory Context View Concept](episodic-memory-context-view-concept.md) | EpisodeCard、Ref、Audit log、hybrid retrieval を分離し、`context_compile` と `context_decision` で Episode 記憶を使うための concept |
| [Episodic Memory Context View 実装計画](episodic-memory-context-view-implementation-plan.md) | EpisodeCard を raw memory と durable Knowledge の中間層として段階導入するための schema、MCP/API、compile/decision integration、検証 milestone |
| [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md) | `context_decision` を 90 点以上の品質へ引き上げるため、compile、graph、community、landscape、attractor 指標を統合する実装計画 |
| [Applicability And Evidence Boundary Refactor Plan](applicability-evidence-boundary-refactor-plan.md) | applicability 正規化の共通化、sourceSummary と primary evidence の型分離、negative SQLite runtime 統合テスト追加の段階的実装計画 |
| [Finalize 匿名化 Distillation 実装計画](finalize-anonymized-distillation-implementation-plan.md) | finalize 段階で匿名化、保存前説明、保守的整形、procedure 再構成補助を追加し、draft knowledge の機密保持と再利用性を高める実装計画 |
| [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md) | SQLite/sqlite-vec、SQLite-managed queues、Knowledge import/export、Tauri control plane を default local-first baseline にする concept |
| [Portable Knowledge Import/Export Draft Plan](portable-knowledge-import-export-plan.md) | portable Knowledge asset export/import の draft plan。実装前に Slice 0 で SQLite layout audit と整合させる |
| [SQLite Database Layout Audit](sqlite-database-layout-audit.md) | local-first Tauri baseline 向けに、table responsibilities と proposed SQLite file layout を整理する audit |
| [pgvector to SQLite Migration Scope](pgvector-to-sqlite-migration-scope.md) | PostgreSQL/pgvector の各 table、実装利用、live DB activity から SQLite migration scope を分類する |
| [SQLite 自走化 実装計画](sqlite-self-running-implementation-plan.md) | pgvector Docker を日常運用から外し、SQLite backend だけで自走できる状態に到達するための残 TODO と milestone |
