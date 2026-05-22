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
              type: "procedure",
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
        usageSource: "find-candidate",
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
    expect(mocks.insertFindCandidateResult).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({ type: "procedure" }),
      }),
    );
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

  test("preloads vibe memory with memory_reader before asking the LLM for candidates", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readVibeMemoryByTokenWindow.mockResolvedValue({
      content:
        "ASSISTANT: For memoryRouter distillation checks, inspect launchd, logs, queue, and DB before changing code.",
      totalTokens: 24,
      from: 0,
      toExclusive: 24,
      returnedTokens: 24,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "procedure",
            title: "Check live distillation state before changing code",
            content:
              "When memoryRouter distillation appears stalled, inspect launchd, logs, queue, and DB state before changing code.",
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
      readTokens: 50,
      maxReads: 2,
      memoryReaderMode: "original",
    });

    expect(mocks.readVibeMemoryByTokenWindow).toHaveBeenCalledWith({
      vibeMemoryId: "memory-1",
      fromToken: 0,
      readTokens: 50,
      mode: "original",
    });
    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("vibe memory の content"),
          }),
          expect.objectContaining({
            role: "tool",
            name: "memory_reader",
            content: expect.stringContaining("launchd"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("上の memory_reader tool result"),
          }),
        ]),
      }),
      expect.objectContaining({
        requireToolCall: false,
        maxToolRounds: 1,
        usageSource: "find-candidate",
      }),
    );
    expect(result.readRanges).toEqual([{ from: 0, toExclusive: 24 }]);
    expect(result.insertedIds).toEqual(["candidate-1"]);
  });

  test("allows additional vibe memory reads after the deterministic first read", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readVibeMemoryByTokenWindow
      .mockResolvedValueOnce({
        content: "first memory window",
        totalTokens: 100,
        from: 0,
        toExclusive: 50,
        returnedTokens: 50,
      })
      .mockResolvedValueOnce({
        content: "second memory window",
        totalTokens: 100,
        from: 50,
        toExclusive: 100,
        returnedTokens: 50,
      });
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      await options.toolExecutor({
        id: "tool-2",
        function: {
          name: "memory_reader",
          arguments: JSON.stringify({ fromToken: "50", readTokens: "50", mode: "compressed" }),
        },
      });
      return {
        content: JSON.stringify({ candidates: [] }),
        toolEvents: [],
        messages: [],
      };
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "cli_text",
      provider: "local-llm",
      readTokens: 50,
      maxReads: 2,
    });

    expect(mocks.readVibeMemoryByTokenWindow).toHaveBeenCalledTimes(2);
    expect(result.readRanges).toEqual([
      { from: 0, toExclusive: 50 },
      { from: 50, toExclusive: 100 },
    ]);
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

  test("keeps rule/procedure type hints when the LLM provides them", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "procedure",
            title: "Run focused verify before finalizing",
            content: "Run the focused test, inspect the returned evidence, then finalize.",
          },
        ],
      }),
    );

    expect(candidates).toEqual([
      {
        type: "procedure",
        title: "Run focused verify before finalizing",
        content: "Run the focused test, inspect the returned evidence, then finalize.",
      },
    ]);
  });

  test("accepts a flat single-candidate JSON object", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        type: "rule",
        title: "Prefer flat output",
        body: "Local LLM output should stay flat and omit non-essential fields.",
      }),
    );

    expect(candidates).toEqual([
      {
        type: "rule",
        title: "Prefer flat output",
        content: "Local LLM output should stay flat and omit non-essential fields.",
      },
    ]);
  });

  test("falls back to plain text candidate blocks when JSON parsing fails", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      [
        "TYPE: procedure",
        "TITLE: Verify pipeline before finalize",
        "CONTENT:",
        "1. Run typecheck.",
        "2. Run focused tests.",
        "3. Confirm evidence payload before finalize.",
      ].join("\n"),
    );
    expect(candidates).toEqual([
      {
        type: "procedure",
        title: "Verify pipeline before finalize",
        content:
          "1. Run typecheck.\n2. Run focused tests.\n3. Confirm evidence payload before finalize.",
      },
    ]);
  });
});
