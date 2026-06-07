# Internal Design Documents

This directory contains internal implementation plans, design notes, and engineering decision records.

These documents are allowed to discuss unfinished work, implementation constraints, rejected alternatives, and local operational details. Public user/operator documentation belongs in `../pub/`.

| Document | Purpose |
|---|---|
| [MCP Tool Design Best Practices](mcp-tool-design-best-practices.md) | General MCP tool design guidance used by this project |
| [DeadZone Knowledge Review Queue Design](deadzone-knowledge-review-ui-plan.md) | Decision-queue design for reviewing DeadZone knowledge with similarity as one signal, not the sole merge criterion |
| [Git History Episode Candidate Plan](git-history-episode-candidate-plan.md) | Plan for deterministic git file/domain history preprocessing that produces design-evolution episode candidates without letting LocalLLM perform git exploration |
| [Zero-Config Instant Onboarding Plan](zero-config-instant-onboarding-plan.md) | Internal implementation plan for startup/onboarding |
