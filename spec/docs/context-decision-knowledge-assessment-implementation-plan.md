# Context Decision Knowledge Assessment Implementation Plan

## Current Scope

Context Decision should evaluate retrieved Knowledge deterministically, then use the LLM only to choose a final structured decision from the available evidence. Knowledge-derived prior material is reference-only and must not become a score, confidence source, or hard authority.

## Implemented Components

1. Knowledge Assessment
   - Builds role-specific coverage for support, counter evidence, user preference, risk, verification, and alternatives.
   - Records candidate traces with retrieval method, selected/rejected state, and deterministic feature scores.
   - Produces an assessment object with coverage, support, counter, risk, preference alignment, consensus/conflict, source quality, and out-of-distribution signals.

2. Retrieval Knowledge Prior
   - Stored in `confidenceTrace.knowledgePrior`.
   - Source is `retrieval_prior_v1`.
   - Built only from candidates retrieved for the current decision.
   - Kept as `referenceOnly: true` and `notUsedForScoring: true`.
   - This is the existing current prior and remains unchanged in role.

3. Corpus Knowledge Prior
   - Stored in `confidenceTrace.corpusKnowledgePrior` when a generated artifact exists.
   - Source is `corpus_prior_v1`.
   - Generated from active Knowledge rows without creating or updating embeddings.
   - Saved as `artifacts/context-decision/knowledge-prior.json`.
   - Loaded during Context Decision as background reference material for the LLM.
   - Kept as `referenceOnly: true` and `notUsedForScoring: true`.

4. Outcome Predictor
   - Uses existing decision history and deterministic features.
   - Does not train from Knowledge embeddings.
   - Does not change final confidence directly.

## Corpus Prior Operation

Generate a dry-run preview:

```sh
bun run knowledge:train-prior --dry-run
```

Write the artifact used by Context Decision:

```sh
bun run knowledge:train-prior --apply
```

Optional output path:

```sh
bun run knowledge:train-prior --apply --output artifacts/context-decision/knowledge-prior.json
```

## Non-Goals

- Do not add a new embedding model or vectorization pass.
- Do not require every Knowledge item to have an embedding before it can inform the corpus prior.
- Do not replace retrieval-scoped evidence with corpus-wide tendencies.
- Do not use either prior to compute deterministic confidence.

## Decision-Time Priority

1. Forced rules and deterministic scoring.
2. Current retrieval evidence and Knowledge Assessment.
3. Outcome Predictor as advisory historical signal.
4. Retrieval Knowledge Prior as current-decision background.
5. Corpus Knowledge Prior as global background tendency.

When the priors conflict with concrete retrieved evidence, the retrieved evidence wins.
