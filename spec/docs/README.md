# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md) | SQLite/sqlite-vec、SQLite-managed queues、Knowledge import/export、Tauri control plane を default local-first baseline にする concept |
| [Portable Knowledge Import/Export Draft Plan](portable-knowledge-import-export-plan.md) | portable Knowledge asset export/import の draft plan。実装前に Slice 0 で SQLite layout audit と整合させる |
| [SQLite Database Layout Audit](sqlite-database-layout-audit.md) | local-first Tauri baseline 向けに、table responsibilities と proposed SQLite file layout を整理する audit |
| [pgvector to SQLite Migration Scope](pgvector-to-sqlite-migration-scope.md) | PostgreSQL/pgvector の各 table、実装利用、live DB activity から SQLite migration scope を分類する |
| [SQLite 自走化 実装計画](sqlite-self-running-implementation-plan.md) | pgvector Docker を日常運用から外し、SQLite backend だけで自走できる状態に到達するための残 TODO と milestone |
