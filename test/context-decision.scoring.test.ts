import { describe, expect, test } from "vitest";
import { scoreContextDecision } from "../src/modules/context-decision/context-decision.scoring.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: overrides.polarity ?? "positive",
    intentTags: overrides.intentTags ?? [],
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

const baseInput = {
  decisionPoint: "continue or ask user",
  retrievalHints: { technologies: ["typescript"], changeTypes: [], domains: [] },
  metadata: {},
};

describe("context decision scoring", () => {
  test("no selected support degrades the decision without forcing zero confidence", () => {
    const result = scoreContextDecision({
      input: baseInput,
      evidence: [],
      coverage: [{ queryRole: "support", hitCount: 0 }],
      relatedBadSignalCount: 0,
    });

    expect(result.status).toBe("degraded");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.trace.forcedRules).toContain("no_selected_support_evidence");
  });

  test("missing counter evidence coverage does not raise confidence by itself", () => {
    const result = scoreContextDecision({
      input: baseInput,
      evidence: [{ knowledge: knowledge(), role: "selected_support" }],
      coverage: [
        { queryRole: "support", hitCount: 1 },
        { queryRole: "counter_evidence", hitCount: 0 },
      ],
      relatedBadSignalCount: 0,
    });

    expect(result.confidence).toBeGreaterThan(0);
    expect(result.trace.counterScore).toBe(0);
  });

  test("historical bad signals lower confidence", () => {
    const withoutBad = scoreContextDecision({
      input: baseInput,
      evidence: [{ knowledge: knowledge(), role: "selected_support" }],
      coverage: [{ queryRole: "support", hitCount: 1 }],
      relatedBadSignalCount: 0,
    });
    const withBad = scoreContextDecision({
      input: baseInput,
      evidence: [{ knowledge: knowledge(), role: "selected_support" }],
      coverage: [{ queryRole: "support", hitCount: 1 }],
      relatedBadSignalCount: 3,
    });

    expect(withBad.confidence).toBeLessThan(withoutBad.confidence);
  });

  test("risk warnings are guardrail signals, not automatic confidence penalties", () => {
    const support = knowledge();
    const withoutRisk = scoreContextDecision({
      input: baseInput,
      evidence: [{ knowledge: support, role: "selected_support" }],
      coverage: [{ queryRole: "support", hitCount: 1 }],
      relatedBadSignalCount: 0,
    });
    const withRisk = scoreContextDecision({
      input: baseInput,
      evidence: [
        { knowledge: support, role: "selected_support" },
        {
          knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000002" }),
          role: "risk_warning",
        },
      ],
      coverage: [
        { queryRole: "support", hitCount: 1 },
        { queryRole: "risk", hitCount: 1 },
      ],
      relatedBadSignalCount: 0,
    });

    expect(withRisk.trace.riskSignalScore).toBeGreaterThan(0);
    expect(withRisk.trace.counterScore).toBe(0);
    expect(withRisk.confidence).toBe(withoutRisk.confidence);
  });
});
