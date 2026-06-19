# Internal Design Documents

この directory には、internal implementation plans、design notes、engineering decision records を置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `../pub/` に置く。

| Document | 目的 |
|---|---|
| [MCP Tool Design Best Practices](mcp-tool-design-best-practices.md) | この project で使う一般的な MCP tool design guidance |
| [Context Decision Concept](context-decision-concept.md) | coding agents が最小限の user confirmation で継続し、Good/Bad feedback から学習する assertive decision MCP tool の concept |
| [Context Decision Implementation Plan](context-decision-implementation-plan.md) | `context_decision` MCP tool、persistence、scoring、feedback loop、PR discard detection、WebUI、NightWorkers contract の implementation plan |
| [Context Decision NightWorkers Contract](context-decision-nightworkers-contract.md) | NightWorkers が ContextStill persistence を所有せずに ContextStill の `context_decision` MCP tool を呼ぶための optional integration contract |
| [DB Session And Repository Decoupling Plan](db-session-repository-decoupling-plan.md) | repositories を DB connection singletons から分離し、SQLite write coordination に備える implementation plan |
| [DeadZone Knowledge Review Queue Design](deadzone-knowledge-review-ui-plan.md) | similarity を唯一の merge criterion にせず、DeadZone knowledge を review するための decision-queue design |
| [Git History Episode Candidate Plan](git-history-episode-candidate-plan.md) | LocalLLM に git exploration をさせず、deterministic git file/domain history preprocessing で design-evolution episode candidates を作る plan |
| [Local-First SQLite And Tauri Concept](local-first-sqlite-tauri-concept.md) | SQLite/sqlite-vec、SQLite-managed queues、Knowledge import/export、Tauri control plane を default local-first baseline にする concept |
| [Negative Knowledge Concept](negative-knowledge-concept.md) | polarity、flexible intent tags、review correction provenance、negative evidence coverage の concept |
| [Negative Knowledge Execution Plan](negative-knowledge-execution-plan.md) | dedicated negative coverage table なしで Negative Knowledge を追加する implementation-ready slice plan |
| [Negative Knowledge Implementation Plan](negative-knowledge-implementation-plan.md) | polarity、review correction registration、negative evidence coverage、compile guardrails、decision role mapping の implementation plan |
| [Portable Knowledge Import/Export Draft Plan](portable-knowledge-import-export-plan.md) | portable Knowledge asset export/import の draft plan。実装前に Slice 0 で SQLite layout audit と整合させる |
| [Review And Autonomous Goals Concept](review-and-autonomous-goals-concept.md) | review-oriented context support、negative Knowledge dependency、NightWorkers-owned goal discovery、implementation priority の concept boundary |
| [SQLite Database Layout Audit](sqlite-database-layout-audit.md) | local-first Tauri baseline 向けに、table responsibilities と proposed SQLite file layout を整理する audit |
| [Unused Active Knowledge Utilization Plan](unused-active-knowledge-utilization-plan.md) | exploration slots、unused Knowledge classification、high-quality unused boost、reviewed `appliesTo` suggestions の implementation plan |
| [Zero-Config Instant Onboarding Plan](zero-config-instant-onboarding-plan.md) | startup/onboarding の internal implementation plan |
