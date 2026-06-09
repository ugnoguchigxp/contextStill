import { describe, expect, test } from "vitest";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";
import {
  resolveContextDecisionOutcome,
  scoreContextDecision,
} from "../src/modules/context-decision/context-decision.scoring.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
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
  taskGoal: "finish implementation",
  decisionPoint: "continue or ask user",
  options: [],
  autonomyLevel: "high" as const,
  riskBudget: "medium" as const,
  knowledgePolicy: "required" as const,
  metadata: {},
};

describe("context decision scoring", () => {
  test("required Knowledge with no selected support degrades to zero confidence", () => {
    const result = scoreContextDecision({
      input: baseInput,
      evidence: [],
      coverage: [{ queryRole: "support", hitCount: 0 }],
      relatedBadSignalCount: 0,
    });

    expect(result.status).toBe("degraded");
    expect(result.confidence).toBe(0);
    expect(result.trace.forcedRules).toContain("knowledge_required_without_selected_support");
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

  test("option selection without proposed action is execute, not revise", () => {
    const result = resolveContextDecisionOutcome({
      input: {
        ...baseInput,
        knowledgePolicy: "optional",
        options: ["run the focused verification"],
      },
      selectedAction: "run the focused verification",
      confidence: 65,
    });

    expect(result).toBe("execute");
  });

  test("option selection that changes a proposed action is revise_and_execute", () => {
    const result = resolveContextDecisionOutcome({
      input: {
        ...baseInput,
        knowledgePolicy: "optional",
        proposedAction: "ask the user",
        options: ["continue implementation"],
      },
      selectedAction: "continue implementation",
      confidence: 65,
    });

    expect(result).toBe("revise_and_execute");
  });
});
