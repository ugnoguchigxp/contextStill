import { describe, expect, test } from "vitest";
import { contextDecisionInputSchema } from "../src/shared/schemas/context-decision.schema.js";
import { scoreContextDecision } from "../src/modules/context-decision/context-decision.scoring.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(): KnowledgeSearchResult {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "procedure",
    status: "active",
    scope: "repo",
    title: "Continue autonomously before asking",
    body: "Use context_decision before asking the user and continue when evidence supports it.",
    confidence: 86,
    importance: 84,
    score: 1,
    appliesTo: {},
    metadata: {},
    sourceRefs: ["file:///nightworkers-contract.md#line:1"],
    hasSourceLinks: true,
    dynamicScore: 25,
    compileSelectCount: 3,
    agenticAcceptCount: 1,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: new Date(),
    updatedAt: new Date(),
    decayFactor: 1,
    applicabilityScore: 12,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: true },
  };
}

describe("NightWorkers context_decision contract", () => {
  test("blocker before user question maps through generic MCP metadata", () => {
    const parsed = contextDecisionInputSchema.parse({
      taskGoal: "Finish implementation without waiting for user confirmation.",
      decisionPoint: "A blocker message would normally ask the user.",
      proposedAction: "Use repo evidence and continue with a narrow implementation.",
      autonomyLevel: "high",
      riskBudget: "medium",
      availableRollback: "git diff can be reverted before commit",
      verificationPlan: "run typecheck and targeted tests",
      knowledgePolicy: "required",
      metadata: {
        nightWorkersTaskId: "task-123",
        blockerSummary: "Need decide whether to ask user or continue",
        todoStatus: "unfinished",
      },
    });

    const scored = scoreContextDecision({
      input: parsed,
      evidence: [{ knowledge: knowledge(), role: "selected_support" }],
      coverage: [
        { queryRole: "support", hitCount: 1 },
        { queryRole: "counter_evidence", hitCount: 0 },
      ],
      relatedBadSignalCount: 0,
    });

    expect(scored.status).toBe("completed");
    expect(scored.confidence).toBeGreaterThan(35);
  });

  test("PR-before metadata stays optional and ContextStill-owned", () => {
    const parsed = contextDecisionInputSchema.parse({
      taskGoal: "Prepare pull request.",
      decisionPoint: "Decide whether to create a PR now.",
      proposedAction: "Create PR after verification passes.",
      autonomyLevel: "high",
      riskBudget: "low",
      knowledgePolicy: "required",
      metadata: {
        branch: "codex/context-decision",
        prUrl: "https://github.com/example/repo/pull/42",
        headSha: "abc123",
      },
    });

    expect(parsed.metadata.branch).toBe("codex/context-decision");
    expect(parsed).not.toHaveProperty("nightWorkersSchema");
  });
});
