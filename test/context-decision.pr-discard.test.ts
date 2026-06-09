import { execFile } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../src/modules/context-decision/context-decision.repository.js", () => ({
  getContextDecisionDetail: vi.fn(async () => ({
    run: { createdAt: "2026-06-09T00:00:00.000Z" },
  })),
  hasDiscardedPrFeedback: vi.fn(async () => false),
  insertDecisionFeedbackEffects: vi.fn(async () => []),
  insertDecisionSystemFeedback: vi.fn(async () => ({
    id: "feedback-1",
    outcome: "discarded_pr",
  })),
  listContextDecisionPrScanCandidates: vi.fn(async () => [
    {
      id: "00000000-0000-0000-0000-000000000001",
      metadata: { prUrl: "https://github.com/example/repo/pull/42", branch: "codex/test" },
      createdAt: "2026-06-09T00:00:00.000Z",
    },
  ]),
  listSelectedSupportKnowledgeIds: vi.fn(async () => ["00000000-0000-0000-0000-0000000000aa"]),
}));

function mockGhPrState(state: string) {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const cb = args.findLast((arg) => typeof arg === "function") as
      | ((error: Error | null, stdout: string, stderr: string) => void)
      | undefined;
    cb?.(
      null,
      JSON.stringify({
        number: 42,
        state,
        url: "https://github.com/example/repo/pull/42",
        headRefName: "codex/test",
      }),
      "",
    );
    return {} as never;
  }) as never);
}

describe("context decision PR discard scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("dry-run plans feedback for a closed linked PR", async () => {
    mockGhPrState("CLOSED");
    const { scanContextDecisionPrDiscards } = await import(
      "../src/modules/context-decision/context-decision.pr-discard.service.js"
    );

    const result = await scanContextDecisionPrDiscards({ apply: false });

    expect(result.status).toBe("ok");
    expect(result.feedbackCreated).toBe(0);
    expect(result.items[0]?.action).toBe("planned_feedback");
  });

  test("apply creates discarded_pr feedback for a closed linked PR", async () => {
    mockGhPrState("CLOSED");
    const { scanContextDecisionPrDiscards } = await import(
      "../src/modules/context-decision/context-decision.pr-discard.service.js"
    );
    const repository = await import(
      "../src/modules/context-decision/context-decision.repository.js"
    );

    const result = await scanContextDecisionPrDiscards({ apply: true });

    expect(result.feedbackCreated).toBe(1);
    expect(repository.insertDecisionSystemFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "discarded_pr" }),
    );
    expect(repository.insertDecisionFeedbackEffects).toHaveBeenCalled();
  });

  test("apply records skipped effect when closed PR has no selected support knowledge", async () => {
    mockGhPrState("CLOSED");
    const repository = await import(
      "../src/modules/context-decision/context-decision.repository.js"
    );
    vi.mocked(repository.listSelectedSupportKnowledgeIds).mockResolvedValueOnce([]);
    const { scanContextDecisionPrDiscards } = await import(
      "../src/modules/context-decision/context-decision.pr-discard.service.js"
    );

    const result = await scanContextDecisionPrDiscards({ apply: true });

    expect(result.feedbackCreated).toBe(1);
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

  test("unconfirmed PR state skips writes and reports degraded", async () => {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const cb = args.findLast((arg) => typeof arg === "function") as
        | ((error: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      cb?.(new Error("gh missing"), "", "missing");
      return {} as never;
    }) as never);
    const { scanContextDecisionPrDiscards } = await import(
      "../src/modules/context-decision/context-decision.pr-discard.service.js"
    );

    const result = await scanContextDecisionPrDiscards({ apply: true });

    expect(result.status).toBe("degraded");
    expect(result.feedbackCreated).toBe(0);
    expect(result.items[0]?.action).toBe("skipped");
  });
});
