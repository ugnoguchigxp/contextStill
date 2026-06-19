# Context Compile Mode Concept

## Purpose

This document defines the concept of Compile Mode for `context_compile`.

Compile Mode lets a caller choose how much retrieval effort and risk checking a compile run should spend before producing a task context pack.

This is a concept document, not an implementation plan. It does not define API schemas, ranking formulas, database changes, UI wireframes, or migration steps.

## Problem

`context_compile` currently serves tasks with different cost and certainty needs:

- a quick implementation that needs only the most obvious project rules
- a normal coding task that benefits from query expansion and adjacent procedures
- a high-risk task where prior failures, negative Knowledge, and counter-evidence matter

Using one retrieval depth for all of these cases creates two bad outcomes:

- lightweight tasks receive more context than they can use
- risky tasks may miss guardrails because the compile path was optimized for speed

Compile Mode should make the intended depth explicit without turning `context_compile` into separate tools.

## Modes

The initial conceptual modes are:

```text
keyword
query
deep
```

| Mode | Intent | Retrieval Shape | Expected Use |
|---|---|---|---|
| `keyword` | Lightweight compile | Tags, explicit keywords, direct matches, high-confidence rules | Small edits, known files, quick orientation |
| `query` | Standard compile | Keyword retrieval plus query expansion and related procedures | Normal implementation, refactors, focused planning |
| `deep` | Risk-aware compile | Multiple retrieval candidates, negative Knowledge, counter-evidence, and verification cues | Architecture changes, regressions, reviews, high-cost decisions |

The names describe retrieval posture, not model quality. `deep` is not inherently "better"; it is more expensive and should be used when risk or ambiguity justifies the extra context.

## Keyword Mode

`keyword` mode should favor directness.

It is appropriate when the caller already knows the domain, change type, repository, or specific component. The compiled pack should stay short and prefer:

- exact domain and technology matches
- high-confidence active rules
- clearly applicable procedures
- concise warnings only when directly matched

`keyword` mode should not perform broad exploration. Missing related material is acceptable if the caller asked for a fast, narrow pack.

## Query Mode

`query` mode is the default standard posture.

It should use the caller's goal, domains, technologies, and change types to broaden retrieval enough to find adjacent guidance. The compiled pack may include:

- direct matches
- nearby tags and aliases
- procedures that match the task shape
- relevant prior corrections when they are strongly connected
- a small number of verification reminders

`query` mode should balance recall and compactness. It should not include a large risk appendix unless the risk is clearly connected to the task.

## Deep Mode

`deep` mode is for tasks where missing context is more costly than spending additional retrieval effort.

It should explicitly look for:

- negative Knowledge
- prior failure patterns
- accepted review corrections
- counter-evidence against the obvious plan
- verification requirements caused by known regressions
- conflicting guidance that needs to be surfaced

The output should still be curated. `deep` mode should not dump every related item. It should explain why high-risk or negative items were included and how they should influence the task.

## Negative Knowledge Relationship

Compile Mode is especially useful once negative Knowledge exists as a first-class signal.

Expected behavior:

- `keyword`: include negative Knowledge only on strong direct matches.
- `query`: include negative Knowledge when it is clearly relevant to the task shape.
- `deep`: actively search for negative Knowledge, counter-evidence, and verification risks.

Negative Knowledge must not be rendered as ordinary instructions. It should appear as guardrails, risks, failure patterns, or verification requirements.

## Context Pack Contract

Compile Mode changes the retrieval posture, not the core contract of `context_compile`.

Every mode should still produce a compact, task-specific context pack. The caller should not need to understand internal retrieval mechanics to use the output.

The pack should make the selected mode visible enough for evaluation:

```text
Compile mode: keyword | query | deep
```

This visibility helps `compile_eval` feedback distinguish "the pack was too shallow" from "the pack was correctly lightweight for the requested mode."

## Boundary

contextStill owns:

- mode semantics
- retrieval posture
- pack composition
- Knowledge and negative Knowledge selection
- compile evaluation feedback

Callers own:

- when to request a deeper mode
- task execution
- file reads, shell commands, and repository mutation
- verification runs
- user approval for risky work

This keeps `context_compile` focused on context assembly instead of turning it into an execution planner.

## Non-Goals

Do not use this concept to introduce:

- separate MCP tools for each mode
- automatic code execution from `context_compile`
- file-system inspection inside contextStill
- a new Knowledge store
- a closed enum of every possible task type
- a guarantee that `deep` mode always finds every risk
- UI-heavy workflow management inside contextStill

## Adoption Principle

The first adoption slice should preserve existing `context_compile` behavior as the standard path.

Conceptually:

```text
unspecified mode -> query
```

`keyword` and `deep` should be opt-in until evaluation evidence shows which tasks benefit from each mode.

`compile_eval` should become the feedback loop for tuning mode behavior. Useful feedback includes whether the pack was too shallow, too broad, missing negative evidence, or overfilled with weakly related items.
