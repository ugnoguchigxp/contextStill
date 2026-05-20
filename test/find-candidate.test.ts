import { beforeEach, describe, expect, test, vi } from "vitest";
import { runFindCandidate } from "../src/modules/findCandidate/domain.js";
import { parseStorageCandidatesFromLlmOutput } from "../src/modules/findCandidate/parser.js";

const mocks = vi.hoisted(() => ({
  getDistillationTargetStateById: vi.fn(),
  readFileDomain: vi.fn(),
  readVibeMemoryByTokenWindow: vi.fn(),
  runDistillationCompletion: vi.fn(),
  resolveDistillationModel: vi.fn(() => "test-model"),
  insertFindCandidateResult: vi.fn(),
  recordAuditLogSafe: vi.fn(),
}));

vi.mock("../src/modules/selectDistillationTarget/repository.js", () => ({
  getDistillationTargetStateById: mocks.getDistillationTargetStateById,
}));

vi.mock("../src/modules/readFile/domain.js", () => ({
  readFileDomain: mocks.readFileDomain,
}));

vi.mock("../src/modules/memoryReader/reader.service.js", () => ({
  readVibeMemoryByTokenWindow: mocks.readVibeMemoryByTokenWindow,
}));

vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  runDistillationCompletion: mocks.runDistillationCompletion,
  resolveDistillationModel: mocks.resolveDistillationModel,
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  insertFindCandidateResult: mocks.insertFindCandidateResult,
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    findCandidateStarted: "FIND_CANDIDATE_STARTED",
    findCandidateReaderUsed: "FIND_CANDIDATE_READER_USED",
    findCandidateCompleted: "FIND_CANDIDATE_COMPLETED",
    findCandidateFailed: "FIND_CANDIDATE_FAILED",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

describe("runFindCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-1",
      targetKind: "wiki_file",
      targetKey: "rules/testing.md",
    });
    mocks.readFileDomain.mockResolvedValue({
      content: "- Run smoke tests before finalizing implementation changes.",
      totalTokens: 20,
      from: 0,
      toExclusive: 20,
      returnedTokens: 20,
    });
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      await options.toolExecutor(
        {
          id: "tool-1",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ fromToken: 0, readTokens: 20 }),
          },
        },
        {},
      );
      return {
        content: JSON.stringify({
          candidates: [
            {
              title: "Run smoke tests before finalizing changes",
              content: "Run smoke tests before finalizing implementation changes.",
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      };
    });
    mocks.insertFindCandidateResult.mockResolvedValue({ id: "candidate-1" });
  });

  test("provides only the target reader tool and records reads through the executor", async () => {
    const result = await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("まず tool で本文を読んでください"),
          }),
        ]),
      }),
      expect.objectContaining({
        requireToolCall: true,
        toolDefinitions: [
          expect.objectContaining({
            function: expect.objectContaining({ name: "read_file" }),
          }),
        ],
      }),
    );
    expect(mocks.readFileDomain).toHaveBeenCalledWith(
      expect.objectContaining({ path: "rules/testing.md", fromToken: 0 }),
    );
    expect(result.insertedIds).toEqual(["candidate-1"]);
    expect(result.readRanges).toEqual([{ from: 0, toExclusive: 20 }]);
  });

  test("fails when the LLM returns candidates without using the reader tool", async () => {
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({ candidates: [] }),
      toolEvents: [],
      messages: [],
    });

    await expect(
      runFindCandidate({
        targetStateId: "target-1",
        callerMode: "storage",
        provider: "local-llm",
      }),
    ).rejects.toThrow("findCandidate reader tool was not used");
    expect(mocks.readFileDomain).not.toHaveBeenCalled();
  });
});

describe("parseStorageCandidatesFromLlmOutput", () => {
  test("repairs a truncated candidates container from local LLM output", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      '{"candidates":[{"title":"Keep verification concrete","content":"Run the smoke command and preserve returned evidence."}',
    );

    expect(candidates).toEqual([
      {
        title: "Keep verification concrete",
        content: "Run the smoke command and preserve returned evidence.",
      },
    ]);
  });
});
