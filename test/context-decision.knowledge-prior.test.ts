import { describe, expect, test } from "vitest";
import type { ContextDecisionCandidateTrace } from "../src/modules/context-decision/context-decision.knowledge-assessment.js";
import { buildContextDecisionKnowledgePrior } from "../src/modules/context-decision/context-decision.knowledge-prior.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: overrides.polarity ?? "positive",
    intentTags: overrides.intentTags ?? [],
    title: "Proceed with evidence",
    body: "Use evidence before asking.",
    confidence: 80,
    importance: 80,
    score: 0.4,
    appliesTo: {},
    metadata: {},
    sourceRefs: [],
    hasSourceLinks: false,
    dynamicScore: 0,
    compileSelectCount: 0,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    decayFactor: 1,
    applicabilityScore: 0,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: false },
    ...overrides,
  };
}

function trace(
  overrides: Partial<ContextDecisionCandidateTrace> = {},
): ContextDecisionCandidateTrace {
  return {
    knowledgeId: "00000000-0000-0000-0000-000000000001",
    chunkId: null,
    role: "support",
    retrievalMethod: "keyword",
    vectorStatus: "unavailable",
    vectorSimilarity: null,
    keywordScore: 40,
    facetScore: 0,
    sourceQualityScore: 45,
    feedbackSignalScore: 50,
    finalCandidateScore: 60,
    selected: true,
    selectionReason: "top support candidate",
    rejectionReason: null,
    ...overrides,
  };
}

describe("context decision knowledge prior", () => {
  test("builds a reference-only prior from selected evidence", () => {
    const prior = buildContextDecisionKnowledgePrior({
      evidence: [{ knowledge: knowledge(), role: "selected_support" }],
      candidateTraces: [trace()],
    });

    expect(prior.status).toBe("available");
    expect(prior.referenceOnly).toBe(true);
    expect(prior.notUsedForScoring).toBe(true);
    expect(prior.signals.join("\n")).toContain("support");
  });

  test("does not pretend limited candidates are scoring evidence", () => {
    const prior = buildContextDecisionKnowledgePrior({
      evidence: [],
      candidateTraces: [trace({ selected: false })],
    });

    expect(prior.status).toBe("limited");
    expect(prior.notUsedForScoring).toBe(true);
    expect(prior.evidenceCount).toBe(0);
  });
});
