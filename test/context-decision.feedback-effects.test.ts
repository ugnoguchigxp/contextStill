import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/modules/context-decision/context-decision.repository.js", () => ({
  getContextDecisionDetail: vi.fn(async () => ({ run: { id: "decision-1" } })),
  insertDecisionFeedbackEffects: vi.fn(async (_input) => [{ id: "effect-1" }]),
  insertDecisionSystemFeedback: vi.fn(async () => ({
    id: "feedback-1",
    outcome: "discarded_pr",
  })),
  listSelectedSupportKnowledgeIds: vi.fn(async () => ["00000000-0000-0000-0000-0000000000aa"]),
  saveHumanDecisionFeedback: vi.fn(async () => ({ id: "human-1", value: "good" })),
}));

describe("context decision feedback effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("system discarded_pr creates applied effects for selected support", async () => {
    const repository = await import(
      "../src/modules/context-decision/context-decision.repository.js"
    );
    const { recordContextDecisionFeedback } = await import(
      "../src/modules/context-decision/context-decision.feedback.service.js"
    );

    const result = await recordContextDecisionFeedback({
      decisionId: "00000000-0000-0000-0000-000000000001",
      source: "system",
      outcome: "discarded_pr",
      metadata: {},
    });

    expect(result).toHaveProperty("feedback");
    expect(repository.insertDecisionFeedbackEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        effects: [
          expect.objectContaining({
            effect: "penalize",
            status: "applied",
          }),
        ],
      }),
    );
  });

  test("system feedback records skipped effect when no support knowledge is attached", async () => {
    const repository = await import(
      "../src/modules/context-decision/context-decision.repository.js"
    );
    vi.mocked(repository.listSelectedSupportKnowledgeIds).mockResolvedValueOnce([]);
    const { recordContextDecisionFeedback } = await import(
      "../src/modules/context-decision/context-decision.feedback.service.js"
    );

    await recordContextDecisionFeedback({
      decisionId: "00000000-0000-0000-0000-000000000001",
      source: "system",
      outcome: "discarded_pr",
      metadata: {},
    });

    expect(repository.insertDecisionFeedbackEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        effects: [
          expect.objectContaining({
            knowledgeId: null,
            effect: "neutral",
            status: "skipped",
          }),
        ],
      }),
    );
  });
});
