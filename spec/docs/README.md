# Internal Design Documents

This directory contains internal implementation plans, design notes, and engineering decision records.

These documents are allowed to discuss unfinished work, implementation constraints, rejected alternatives, and local operational details. Public user/operator documentation belongs in `../pub/`.

| Document | Purpose |
|---|---|
| [MCP Tool Design Best Practices](mcp-tool-design-best-practices.md) | General MCP tool design guidance used by this project |
| [Context Decision Concept](context-decision-concept.md) | Concept for an assertive decision MCP tool that lets coding agents continue with minimal user confirmation and learns from Good/Bad feedback |
| [Context Decision Implementation Plan](context-decision-implementation-plan.md) | Implementation plan for the context_decision MCP tool, persistence, scoring, feedback loop, PR discard detection, WebUI, and NightWorkers contract |
| [Context Decision NightWorkers Contract](context-decision-nightworkers-contract.md) | Optional integration contract for NightWorkers calling ContextStill's context_decision MCP tool without owning ContextStill persistence |
| [DeadZone Knowledge Review Queue Design](deadzone-knowledge-review-ui-plan.md) | Decision-queue design for reviewing DeadZone knowledge with similarity as one signal, not the sole merge criterion |
| [Git History Episode Candidate Plan](git-history-episode-candidate-plan.md) | Plan for deterministic git file/domain history preprocessing that produces design-evolution episode candidates without letting LocalLLM perform git exploration |
| [Negative Knowledge Concept](negative-knowledge-concept.md) | Concept for polarity, flexible intent tags, review correction provenance, and negative evidence coverage |
| [Negative Knowledge Implementation Plan](negative-knowledge-implementation-plan.md) | Implementation plan for polarity, review correction registration, negative evidence coverage, compile guardrails, and decision role mapping |
| [Review And Autonomous Goals Concept](review-and-autonomous-goals-concept.md) | Concept boundary for review-oriented context support, negative Knowledge dependency, NightWorkers-owned goal discovery, and implementation priority |
| [Unused Active Knowledge Utilization Plan](unused-active-knowledge-utilization-plan.md) | Implementation plan for exploration slots, unused Knowledge classification, high-quality unused boost, and reviewed `appliesTo` suggestions |
| [Zero-Config Instant Onboarding Plan](zero-config-instant-onboarding-plan.md) | Internal implementation plan for startup/onboarding |
