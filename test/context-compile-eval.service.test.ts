import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  recordCompileEval,
  resolveSessionIdFromMeta,
} from "../src/modules/context-compiler/context-compile-eval.service.js";

// repository モック
const mockFindRunIdForCompileEval = vi.fn();
const mockGetCompileRunSessionId = vi.fn();
const mockInsertCompileEval = vi.fn();

vi.mock("../src/modules/context-compiler/context-compile-eval.repository.js", () => ({
  findRunIdForCompileEval: (...args: any[]) => mockFindRunIdForCompileEval(...args),
  getCompileRunSessionId: (...args: any[]) => mockGetCompileRunSessionId(...args),
  insertCompileEval: (...args: any[]) => mockInsertCompileEval(...args),
}));

const validUuid = "00000000-0000-0000-0000-000000000001";
const validRunId = "00000000-0000-0000-0000-000000000002";

describe("context-compile-eval.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveSessionIdFromMeta", () => {
    test("resolves sessionId correctly from various meta keys", () => {
      expect(resolveSessionIdFromMeta({ sessionId: "s1" })).toBe("s1");
      expect(resolveSessionIdFromMeta({ threadId: "t1" })).toBe("t1");
      expect(resolveSessionIdFromMeta({ conversationId: "c1" })).toBe("c1");
      expect(resolveSessionIdFromMeta({ codexSessionId: "cs1" })).toBe("cs1");
      expect(resolveSessionIdFromMeta({ sessionId: "  s1  " })).toBe("s1");
    });

    test("returns undefined if no matching key found", () => {
      expect(resolveSessionIdFromMeta({})).toBeUndefined();
      expect(resolveSessionIdFromMeta({ otherKey: "val" })).toBeUndefined();
      expect(resolveSessionIdFromMeta({ sessionId: "  " })).toBeUndefined();
    });
  });

  describe("recordCompileEval", () => {
    const validInput = {
      relevance: 4,
      actionability: 5,
      coverage: 4,
      clarity: 5,
      specificity: 4,
      outcome: "useful" as const,
      title: "Eval title",
      body: "Eval body",
    };

    test("throws error if runId is omitted and sessionId is also missing", async () => {
      await expect(
        recordCompileEval({
          input: { ...validInput, runId: undefined },
        }),
      ).rejects.toThrow("SESSION_ID_REQUIRED_FOR_RUN_RESOLUTION");
    });

    test("throws error if no compile run found for this session when runId is omitted", async () => {
      mockFindRunIdForCompileEval.mockResolvedValue(null);
      await expect(
        recordCompileEval({
          input: { ...validInput, runId: undefined },
          requestMeta: { sessionId: "s1" },
        }),
      ).rejects.toThrow("RUN_ID_REQUIRED_OR_UNRESOLVED");
    });

    test("throws error if run does not exist", async () => {
      mockGetCompileRunSessionId.mockResolvedValue(null);
      await expect(
        recordCompileEval({
          input: { ...validInput, runId: validRunId },
        }),
      ).rejects.toThrow("CONTEXT_COMPILE_RUN_NOT_FOUND");
    });

    test("throws error if run session mismatch", async () => {
      mockGetCompileRunSessionId.mockResolvedValue({ sessionId: "s-other" });
      await expect(
        recordCompileEval({
          input: { ...validInput, runId: validRunId },
          requestMeta: { sessionId: "s-mine" },
        }),
      ).rejects.toThrow("RUN_SESSION_MISMATCH");
    });

    test("successfully records compile eval when runId is explicitly provided", async () => {
      mockGetCompileRunSessionId.mockResolvedValue({ sessionId: "s1" });
      mockInsertCompileEval.mockResolvedValue({
        id: validUuid,
        runId: validRunId,
        sessionId: "s1",
        avg: 4,
        outcome: "useful",
        title: "Eval title",
        body: "Eval body",
        source: "ui",
        relevance: 4,
        actionability: 5,
        coverage: 4,
        clarity: 5,
        specificity: 4,
        createdAt: new Date("2026-06-10T12:00:00Z"),
        updatedAt: new Date("2026-06-10T12:00:00Z"),
      });

      const result = await recordCompileEval({
        input: { ...validInput, runId: validRunId },
        requestMeta: { sessionId: "s1" },
        source: "ui",
      });

      expect(mockInsertCompileEval).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: validRunId,
          avg: 4,
          source: "ui",
        }),
      );
      expect(result.resolvedFrom).toBe("explicit_run_id");
      expect(result.evaluation.id).toBe(validUuid);
    });

    test("successfully records compile eval when runId is resolved from sessionId", async () => {
      mockFindRunIdForCompileEval.mockResolvedValue({
        runId: validRunId,
        resolvedFrom: "latest_session_compile_result",
      });
      mockGetCompileRunSessionId.mockResolvedValue({ sessionId: "s1" });
      mockInsertCompileEval.mockResolvedValue({
        id: validUuid,
        runId: validRunId,
        sessionId: "s1",
        avg: 4,
        outcome: "useful",
        title: "Eval title",
        body: "Eval body",
        source: "mcp",
        relevance: 4,
        actionability: 5,
        coverage: 4,
        clarity: 5,
        specificity: 4,
        createdAt: new Date("2026-06-10T12:00:00Z"),
        updatedAt: new Date("2026-06-10T12:00:00Z"),
      });

      const result = await recordCompileEval({
        input: { ...validInput, runId: undefined },
        requestMeta: { sessionId: "s1" },
      });

      expect(mockFindRunIdForCompileEval).toHaveBeenCalledWith({ sessionId: "s1" });
      expect(result.resolvedFrom).toBe("latest_session_compile_result");
      expect(result.evaluation.id).toBe(validUuid);
    });
  });
});
