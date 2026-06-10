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

3. Outcome Predictor
   - Uses existing decision history and deterministic features.
   - Does not train from Knowledge embeddings.
   - Does not change final confidence directly.

## Non-Goals

- Do not add a new embedding model or vectorization pass.
- Do not replace retrieval-scoped evidence with corpus-wide tendencies.
- Do not use the retrieval prior to compute deterministic confidence.
- Do not generate or load a corpus-wide Knowledge Prior. It was removed because it was too broad to help decision quality and added noise.

## Decision-Time Priority

1. Forced rules and deterministic scoring.
2. Current retrieval evidence and Knowledge Assessment.
3. Outcome Predictor as advisory historical signal.
4. Retrieval Knowledge Prior as current-decision background.

When the retrieval prior conflicts with concrete retrieved evidence, the retrieved evidence wins.
