# Negative Knowledge Concept

## Purpose

This document defines the concept of negative Knowledge and review corrections in context-still.

It is a concept document, not an implementation plan. The goal is to fix the design vocabulary before changing schemas, MCP tools, distillation prompts, ranking, or UI.

## Problem

Current Knowledge is mostly shaped as reusable guidance:

- rules to follow
- procedures to run
- preferences to preserve
- verification habits to repeat

That is not enough for self-improving development systems. Review findings, regressions, user corrections, and rejected implementation patterns often produce knowledge that is most useful as a warning:

- do not repeat this implementation shape
- this boundary was broken before
- this review finding was valid and required a fix
- this plan looks plausible, but a prior failure says it is risky
- this verification step is required because the failure is easy to miss

These signals should not be treated as ordinary positive guidance. They need their own semantics while still remaining searchable and usable by `context_compile` and `context_decision`.

## Core Distinction

Negative Knowledge is not raw review output.

```text
raw review finding = factual review or correction record
context-still negative Knowledge = distilled reusable warning or failure pattern
```

The source side should keep the review fact when such a ledger exists:

- reviewer model
- finding text
- file or artifact references
- run/task/session references
- accepted or rejected state
- false-positive outcome
- fixed/deferred status
- evidence and verification result

context-still should keep the distilled lesson:

- what failed
- why it mattered
- when it applies
- what to avoid
- how to verify the risk is not present
- how the lesson should influence a future decision

This separation is the reason to use a hybrid design. `polarity` can separate retrieval, but it cannot replace the original review ledger.

This document does not require a specific review producer. Findings may come from humans, local scripts, multiple agent reviewers, or a separate project. context-still should stay loosely coupled and treat source-system data as provenance metadata.

## Polarity

`polarity` should be a fixed semantic field.

```text
positive
negative
neutral
```

Meaning:

- `positive`: support evidence; something to follow or prefer.
- `negative`: risk, counter-evidence, guardrail, prohibition, or failure pattern.
- `neutral`: contextual or verification material that is not inherently for or against a plan.

Polarity is intentionally stricter than tags because `context_decision` needs stable deterministic behavior.

## Intent Tags

Intent should stay flexible.

Do not make the first design depend on a closed enum like:

```text
guidance | warning | failure_pattern | verification | preference
```

Instead, use normalized tags with aliases and maintenance.

Recommended initial tags:

- `guidance`
- `guardrail`
- `prohibition`
- `warning`
- `failure_pattern`
- `review_finding`
- `regression`
- `test_gap`
- `verification`
- `preference`
- `boundary_violation`
- `architecture_risk`
- `security_risk`
- `performance_risk`
- `operational_risk`

The tag set can evolve. Maintenance scripts may merge aliases such as `missing_test`, `test_gap`, and `insufficient_tests`.

Implementation note: intent tags should reuse the existing `knowledge_tag_definitions` model by adding a new tag kind, not by introducing a closed TypeScript enum. The stored Knowledge row should keep normalized tag slugs so DB filters and Decision role mapping do not depend on LLM-only semantic matching.

## Decision Roles

Tags are flexible, but Decision roles should stay fixed.

```text
support
counter_evidence
risk
verification
user_preference
alternative
```

A role mapper should translate Knowledge into decision roles from polarity, tags, retrieval query role, and evidence.

Examples:

| Signal | Decision Role |
|---|---|
| `polarity=positive` + guidance/procedure tags | `support` |
| `polarity=negative` + `failure_pattern` | `risk` or `counter_evidence` |
| `polarity=negative` + `guardrail` / `prohibition` | `risk` |
| `test_gap` / `verification` tags | `verification` |
| preference tags | `user_preference` |

This keeps retrieval flexible while preserving stable decision behavior.

In the current codebase, this maps onto two existing concepts:

- coverage query roles such as `support`, `counter_evidence`, `risk`, and `verification`
- persisted evidence roles such as `selected_support`, `risk_warning`, `user_preference`, and `missing_counter_evidence`

The implementation plan should extend these contracts only where a concrete persisted role is missing.

## Context Compile Behavior

`context_compile` may use negative Knowledge.

However, negative Knowledge must not be rendered as ordinary work instructions. It should appear as guardrails, warnings, risks, or verification requirements.

Expected rendering:

- positive rules: what to follow
- positive procedures: how to proceed
- negative guardrails: what to avoid
- failure patterns: what previously broke
- verification tags: what must be checked

The existing `warnings` section is a natural starting point, but the UI and pack rendering may need a richer guardrail/risk presentation later.

The implementation should not leave this as a plain string-only warning forever. Negative Knowledge needs item identity, source refs, polarity, and feedback metadata, so a structured guardrail section is the target shape.

## Review Correction Registration

Review corrections should be registered through a dedicated bulk-oriented path instead of forcing all review output through generic candidate registration.

Working name:

```text
register_review_corrections
```

Purpose:

- accept review findings that were selected as valid
- preserve source provenance when available
- separate accepted findings from false positives
- produce candidates for negative Knowledge distillation

Only accepted or deferred-but-valid findings should become candidates. Rejected false positives should stay in the source review ledger when one exists and should not become negative Knowledge by default.

## Covering Negative Evidence

Negative Knowledge needs a dedicated evidence coverage step.

Positive coverage asks:

- is this useful guidance?
- is this procedure actionable?
- does the source support it?

Negative coverage asks different questions:

- did the failure or risk really occur?
- was the review finding accepted?
- was the finding fixed or deferred for a valid reason?
- is it a false positive?
- is the lesson reusable outside the exact run?
- should it become a guardrail, failure pattern, prohibition, or verification requirement?

The covering step should use a dedicated System Context and output format.

Suggested distilled format:

```text
Failure:
Impact:
Trigger:
Fix:
Verification:
Decision signal:
```

## Feedback And Scoring

Feedback semantics change with polarity.

For positive Knowledge:

- `used` means the guidance or procedure helped execution.

For negative Knowledge:

- `used` means the warning, risk, or verification requirement helped avoid or catch a problem.

This affects dynamic scoring, UI copy, and usage analytics. A shared storage path can still be used, but scoring and labels must respect polarity.

## Migration Principle

Initial migration should be conservative.

Recommended baseline:

- existing active/draft/deprecated Knowledge defaults to `polarity=positive`
- existing "never", "avoid", "do not", and prohibition-like rules become negative candidates, not automatic negative Knowledge
- promotion from draft negative Knowledge to active negative Knowledge uses the same human review/approval baseline as existing Knowledge
- noisy negative Knowledge uses the same feedback and manual deprecation/editing operation as existing Knowledge
- later cleanup can deduplicate, classify, and seed curated negative Knowledge

Seed/export/import scripts should be updated after the taxonomy stabilizes, not before.

## UI Principle

The Knowledge UI should be refreshed around polarity and review provenance instead of only adding small badges to the existing positive-oriented view.

The UI should make these differences obvious:

- guidance versus guardrail
- failure pattern versus procedure
- raw review finding versus distilled Knowledge
- false-positive review finding versus accepted correction
- support evidence versus risk/counter-evidence

## Non-Goals

- Do not make context-still the code review executor.
- Do not store every review comment as Knowledge.
- Do not turn false positives into negative Knowledge by default.
- Do not make intent a closed enum in the first design.
- Do not mix negative Knowledge into ordinary procedure output without guardrail labeling.
- Do not replace source review provenance with context-still metadata alone when source provenance exists.

## Fixed Baseline Decisions

- Do not make any separate project a prerequisite for negative Knowledge.
- Promotion from draft to active remains human-operated, matching existing Knowledge.
- Wrong, noisy, or misleading negative Knowledge uses existing feedback, review, edit, and `deprecated` operations as the baseline.
