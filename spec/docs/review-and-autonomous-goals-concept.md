# Review And Autonomous Goals Concept

> Created: 2026-06-11
> Scope: contextStill plus optional NightWorkers integration

## Purpose

This document defines the concept boundary for review-oriented context support and autonomous goal discovery.

The goal is not to introduce a new review engine in contextStill. The goal is to make existing contextStill primitives more useful for review workflows, then let NightWorkers own repository inspection, review execution, goal approval, and queue execution.

## Core Boundary

contextStill owns long-lived reusable knowledge and decision support:

- task-specific `context_compile` output
- Knowledge retrieval, ranking, and feedback
- negative Knowledge, guardrails, and failure patterns
- `context_decision` judgment support
- candidate registration and compile evaluation

NightWorkers owns project state and side effects:

- file tree inspection via existing worker tools (list_dir, read_file, search_files, find_file)
- diff, grep, and test execution via worker tools (git_diff, git_status, run_command, run_verification)
- rubric-based review pipeline (deterministic evaluator, LLM reviewer, firewall, merger)
- review finding ledger and evidence pack collection
- verification evidence
- goal proposal, approval, and execution queue
- Night Mode and safety policy enforcement

NightWorkers already has a rubric-based review evaluation system with two built-in rubrics (`basic-coding-run` and `review-ready-run`), a deterministic evaluator, an LLM reviewer stub, a firewall that prevents LLM from overriding deterministic blocking findings, and a merger that combines deterministic and LLM results. The review concept here extends that existing pipeline rather than replacing it.

This split keeps contextStill reusable and avoids giving it file read, shell execution, or project mutation responsibilities.

## Review Concept

Review support should be implemented as an extension of existing contextStill surfaces, not as a new standalone MCP tool family.

The first review path should be:

```text
NightWorkers or another review producer
  -> accepted review correction
  -> contextStill register_review_corrections
  -> candidate for negative Knowledge
  -> distilled guardrail / failure pattern
  -> context_compile review_context guardrails
  -> context_decision risk / counter-evidence / verification roles
```

`register_review_corrections` is a bulk variant of the existing `register_candidates` MCP tool, specialized for review-origin candidates. It should create candidates through the same distillation pipeline (findCandidate → coverEvidence → finalizeDistille) rather than bypassing it. The only difference is the origin metadata (`review_correction` origin kind) and default polarity (`negative`).

Raw review findings and their lifecycle should stay outside contextStill. contextStill should store only distilled, reusable lessons plus provenance metadata.

## Negative Knowledge Dependency

Review support depends on the Negative Knowledge direction already described in:

- [Negative Knowledge Concept](negative-knowledge-concept.md)
- [Negative Knowledge Implementation Plan](negative-knowledge-implementation-plan.md)

The important contracts are:

- `polarity = positive | negative | neutral`
- flexible `intentTags`, not a closed enum
- accepted review corrections become candidates
- negative Knowledge renders as guardrails, risks, failure patterns, or verification requirements
- `context_decision` maps negative signals into stable decision roles

This concept should not bypass that plan with a separate `register_review_finding` ledger inside contextStill.

## context_compile Review Direction

`context_compile` already has `review_context` as a retrieval mode. Review support should strengthen that path.

Initial behavior:

- preserve existing ranking, token budgeting, duplicate suppression, and agentic refinement
- keep ordinary positive rules and procedures separate from negative guardrails
- render negative Knowledge with identity and source refs, not only plain warning strings
- prefer short, actionable review cues over long provenance payloads

Later behavior:

- add `reviewScope` only after negative Knowledge metadata is available
- add `perspective` filtering for narrow review passes such as correctness, test coverage, security, or data integrity
- avoid making perspective routing a separate engine unless runtime ownership genuinely diverges from `context_compile`

## context_decision Review Direction

`context_decision` should remain a separate decision layer from `context_compile`.

For review workflows, it should consume negative Knowledge as risk, counter-evidence, or verification evidence. It should not become a raw review runner and should not treat missing counter-evidence as strong proof.

Useful review decision points include:

- whether a finding should block completion
- whether a change should be revised before execution
- whether a PR or run should be discarded, retried, or escalated
- whether a proposed autonomous goal is safe enough to queue

## Autonomous Goal Concept

Autonomous goal discovery means finding plausible next work from evidence, not inventing work from model speculation.

Allowed discovery sources:

- accepted review findings (from NightWorkers rubric evaluation pipeline)
- failed tests or verification records
- incomplete task todos (needs_human or pending status in taskRunTodos)
- explicit TODO or FIXME markers (discovered via worker tool grep)
- dependency updates available (detected by project-owned tooling)
- configuration or architecture drift detected by project-owned tooling
- contextStill landscape gaps, when exposed as evidence rather than commands
- prior decision outcomes such as failed, regression_found, discarded_pr, or user_overrode

Goal execution should remain gated:

```text
Discover
  -> Propose
  -> Human approve or defer
  -> Queue
  -> Execute
  -> Verify
  -> Learn
```

contextStill should not own the goal table or execution lifecycle. It should provide supporting Knowledge, decision evidence, and post-outcome learning hooks.

## Safety Model

The safe default is proposal-first.

No autonomous code-changing goal should execute without an explicit approval path. Even after approval, execution must be constrained by:

- maximum concurrent goals
- maximum retries per goal
- required verification evidence
- destructive operation restrictions
- timeout per goal
- escalation on schema, security, public API, or unclear decision risk

Night Mode can run approved goals, but newly discovered goals should stay proposed until approved.

## Non-Goals

For the first implementation slice, do not build:

- a new contextStill review engine
- raw review finding storage in contextStill
- file read or shell execution in contextStill
- autonomous file edits from contextStill
- Goal approval UI in contextStill
- Issue or PR integration in contextStill
- broad Night Mode orchestration
- a separate Knowledge store inside NightWorkers

## Implementation Priority

1. Implement Negative Knowledge schema and shared contracts.
2. Return polarity and intent metadata consistently from text and vector retrieval.
3. Add bulk `register_review_corrections` that creates candidates only.
4. Render negative Knowledge in `context_compile` `review_context` as guardrails and verification requirements.
5. Map negative Knowledge into `context_decision` risk, counter-evidence, and verification roles.
6. Add narrow `reviewScope` and `perspective` support to `context_compile`.
7. Define the NightWorkers integration contract for accepted corrections and review evidence.
8. Only then start autonomous goal discovery in NightWorkers.

## First Milestone

The first milestone should prove the review learning loop without building autonomous goals:

```text
accepted correction
  -> register_review_corrections
  -> negative candidate
  -> active negative Knowledge
  -> context_compile review_context includes guardrail
  -> context_decision records risk / verification evidence
```

Completion criteria:

- existing positive Knowledge behavior remains backward compatible
- negative Knowledge is searchable and inspectable
- review corrections do not use `knowledge_review_queue`
- raw findings remain owned by the source system
- compile and decision outputs distinguish support from risk
