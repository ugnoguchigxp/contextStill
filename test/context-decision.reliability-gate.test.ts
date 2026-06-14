import { describe, expect, test } from "vitest";
import { applyContextDecisionReliabilityGate } from "../src/modules/context-decision/context-decision.reliability-gate.js";
import type { DecisionEvidenceCandidate } from "../src/modules/context-decision/context-decision.scoring.js";
import type {
  ContextDecisionKnowledgeAssessment,
  ContextDecisionValue,
} from "../src/shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: "positive",
    intentTags: [],
    title: "Use evidence",
    body: "Evidence backed rule.",
    confidence: 80,
    importance: 80,
    score: 1,
    appliesTo: {},
    metadata: {},
    sourceRefs: ["file:///rule.md#line:1"],
    hasSourceLinks: true,
    dynamicScore: 20,
    compileSelectCount: 1,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date(),
    decayFactor: 1,
    applicabilityScore: 10,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: false },
    ...overrides,
  };
}

function assessment(
  overrides: Partial<ContextDecisionKnowledgeAssessment> = {},
): ContextDecisionKnowledgeAssessment {
  return {
    status: "evaluable",
    recommendedDirection: "execute",
    knowledgeCoverage: 80,
    supportStrength: 80,
    counterEvidenceStrength: 0,
    riskStrength: 0,
    preferenceAlignment: 0,
    applicabilityScore: 80,
    consensusScore: 80,
    conflictScore: 0,
    sourceQualityScore: 80,
    outOfDistributionScore: 0,
    retrievalMethods: ["keyword"],
    reason: "Enough evidence.",
    ...overrides,
  };
}

function judgment(decision: ContextDecisionValue = "execute") {
  return {
    decision,
    confidence: 90,
    mandate: "Proceed.",
    selectedAction: "run",
    rejectedActions: [],
    reasoningSummary: "LLM selected the action.",
  };
}

const noBadFeedback = {
  count: 0,
  strongCount: 0,
  averageConfidence: 0,
  maxConfidence: 0,
};

describe("context decision reliability gate", () => {
  test("escalates execution when usable evidence is missing", () => {
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment({
        status: "no_evidence",
        recommendedDirection: "escalate",
        knowledgeCoverage: 0,
      }),
      evidence: [],
      relatedBadSignalSummary: noBadFeedback,
    });

    expect(result.judgment.decision).toBe("escalate");
    expect(result.judgment.confidence).toBe(34);
    expect(result.gate.appliedRules.map((item) => item.key)).toContain(
      "no_usable_evidence_escalate",
    );
  });

  test("blocks execution when selected risk evidence is strong", () => {
    const riskEvidence: DecisionEvidenceCandidate[] = [
      {
        knowledge: knowledge({
          id: "00000000-0000-0000-0000-000000000002",
          title: "Do not proceed without verification",
          polarity: "negative",
        }),
        role: "risk_warning",
      },
    ];
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment({ riskStrength: 85, recommendedDirection: "reject" }),
      evidence: riskEvidence,
      relatedBadSignalSummary: noBadFeedback,
    });

    expect(result.judgment.decision).toBe("reject");
    expect(result.gate.riskEvidence.forcedDisplay).toBe(true);
    expect(result.gate.riskEvidence.titles).toContain("Do not proceed without verification");
  });

  test("strong prior bad feedback suppresses direct execute", () => {
    const supportEvidence: DecisionEvidenceCandidate[] = [
      { knowledge: knowledge({ title: "Previously bad support" }), role: "selected_support" },
    ];
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment(),
      evidence: supportEvidence,
      relatedBadSignalSummary: {
        count: 1,
        strongCount: 1,
        averageConfidence: 80,
        maxConfidence: 80,
      },
    });

    expect(result.judgment.decision).toBe("revise_and_execute");
    expect(result.judgment.confidence).toBe(64);
    expect(result.gate.appliedRules.map((item) => item.key)).toContain(
      "bad_feedback_suppresses_execute",
    );
  });

  test("weak prior bad feedback is recorded but does not suppress", () => {
    const supportEvidence: DecisionEvidenceCandidate[] = [
      { knowledge: knowledge({ title: "Weakly disputed support" }), role: "selected_support" },
    ];
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment(),
      evidence: supportEvidence,
      relatedBadSignalSummary: {
        count: 1,
        strongCount: 0,
        averageConfidence: 55,
        maxConfidence: 55,
      },
    });

    expect(result.judgment.decision).toBe("execute");
    expect(result.gate.status).toBe("passed");
    expect(result.gate.badFeedback.count).toBe(1);
  });
});
