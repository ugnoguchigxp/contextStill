import { describe, expect, test } from "vitest";
import {
  assessContextDecisionKnowledge,
  buildContextDecisionCandidateTraces,
} from "../src/modules/context-decision/context-decision.knowledge-assessment.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: overrides.polarity ?? "positive",
    intentTags: overrides.intentTags ?? [],
    title: "Evidence based action",
    body: "Use existing repository evidence before asking the user.",
    confidence: 84,
    importance: 82,
    score: 0.4,
    appliesTo: {},
    metadata: {},
    sourceRefs: ["memory://rule"],
    hasSourceLinks: true,
    dynamicScore: 12,
    compileSelectCount: 2,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    decayFactor: 1,
    applicabilityScore: 42,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: false },
    ...overrides,
  };
}

describe("context decision knowledge assessment", () => {
  test("uses keyword and facet traces without requiring new vectorization", () => {
    const support = knowledge();
    const risk = knowledge({
      id: "00000000-0000-0000-0000-000000000002",
      title: "Verify before finishing",
      score: 0.1,
      applicabilityScore: 20,
    });
    const coverage = [
      { queryRole: "support" as const, hits: [support], selectedKnowledgeIds: [support.id] },
      { queryRole: "counter_evidence" as const, hits: [], selectedKnowledgeIds: [] },
      { queryRole: "risk" as const, hits: [risk], selectedKnowledgeIds: [risk.id] },
      { queryRole: "user_preference" as const, hits: [], selectedKnowledgeIds: [] },
      { queryRole: "verification" as const, hits: [risk], selectedKnowledgeIds: [] },
      { queryRole: "alternative" as const, hits: [], selectedKnowledgeIds: [] },
    ];
    const traces = buildContextDecisionCandidateTraces(coverage);
    const assessment = assessContextDecisionKnowledge({
      evidence: [
        { knowledge: support, role: "selected_support" },
        { knowledge: risk, role: "risk_warning" },
      ],
      coverage,
      candidateTraces: traces,
      relatedBadSignalCount: 0,
    });

    expect(traces.every((trace) => trace.vectorStatus === "unavailable")).toBe(true);
    expect(assessment.status).toBe("evaluable");
    expect(assessment.recommendedDirection).toBe("execute");
    expect(assessment.retrievalMethods).toContain("hybrid");
  });

  test("no support or preference evidence is no_evidence", () => {
    const assessment = assessContextDecisionKnowledge({
      evidence: [],
      coverage: [
        { queryRole: "support", hits: [], selectedKnowledgeIds: [] },
        { queryRole: "counter_evidence", hits: [], selectedKnowledgeIds: [] },
        { queryRole: "risk", hits: [], selectedKnowledgeIds: [] },
        { queryRole: "user_preference", hits: [], selectedKnowledgeIds: [] },
        { queryRole: "verification", hits: [], selectedKnowledgeIds: [] },
        { queryRole: "alternative", hits: [], selectedKnowledgeIds: [] },
      ],
      candidateTraces: [],
      relatedBadSignalCount: 0,
    });

    expect(assessment.status).toBe("no_evidence");
    expect(assessment.recommendedDirection).toBe("escalate");
  });

  test("strong counter evidence changes direction", () => {
    const support = knowledge();
    const counter = knowledge({
      id: "00000000-0000-0000-0000-000000000003",
      score: 0.9,
      applicabilityScore: 60,
    });
    const coverage = [
      { queryRole: "support" as const, hits: [support], selectedKnowledgeIds: [support.id] },
      {
        queryRole: "counter_evidence" as const,
        hits: [counter, counter, counter, counter],
        selectedKnowledgeIds: [],
      },
      { queryRole: "risk" as const, hits: [], selectedKnowledgeIds: [] },
      { queryRole: "user_preference" as const, hits: [], selectedKnowledgeIds: [] },
      { queryRole: "verification" as const, hits: [], selectedKnowledgeIds: [] },
      { queryRole: "alternative" as const, hits: [], selectedKnowledgeIds: [] },
    ];
    const assessment = assessContextDecisionKnowledge({
      evidence: [{ knowledge: support, role: "selected_support" }],
      coverage,
      candidateTraces: buildContextDecisionCandidateTraces(coverage),
      relatedBadSignalCount: 0,
    });

    expect(["reject", "revise_and_execute"]).toContain(assessment.recommendedDirection);
    expect(assessment.conflictScore).toBeGreaterThanOrEqual(42);
  });

  test("strong selected risk evidence rejects the action", () => {
    const support = knowledge();
    const risk = knowledge({
      id: "00000000-0000-0000-0000-000000000004",
      title: "Never run destructive filesystem commands from an ambiguous directory",
      body: "Do not run rm -rf unless the working directory and target path are confirmed.",
      score: 0.7,
      applicabilityScore: 70,
      confidence: 96,
      importance: 98,
    });
    const coverage = [
      { queryRole: "support" as const, hits: [support], selectedKnowledgeIds: [support.id] },
      { queryRole: "counter_evidence" as const, hits: [risk], selectedKnowledgeIds: [] },
      { queryRole: "risk" as const, hits: [risk], selectedKnowledgeIds: [risk.id] },
      { queryRole: "user_preference" as const, hits: [], selectedKnowledgeIds: [] },
      { queryRole: "verification" as const, hits: [risk], selectedKnowledgeIds: [] },
      { queryRole: "alternative" as const, hits: [], selectedKnowledgeIds: [] },
    ];
    const assessment = assessContextDecisionKnowledge({
      evidence: [
        { knowledge: support, role: "selected_support" },
        { knowledge: risk, role: "risk_warning" },
      ],
      coverage,
      candidateTraces: buildContextDecisionCandidateTraces(coverage),
      relatedBadSignalCount: 0,
    });

    expect(assessment.riskStrength).toBeGreaterThanOrEqual(88);
    expect(assessment.recommendedDirection).toBe("reject");
  });

  test("records duplicate suppression separately from rank rejection", () => {
    const item = knowledge();
    const traces = buildContextDecisionCandidateTraces([
      {
        queryRole: "risk",
        hits: [item],
        selectedKnowledgeIds: [],
        duplicateSuppressedKnowledgeIds: [item.id],
      },
    ]);

    expect(traces[0]?.selected).toBe(false);
    expect(traces[0]?.rejectionReason).toContain("duplicate suppressed");
  });
});
