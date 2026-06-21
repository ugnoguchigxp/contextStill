import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { runFindCandidate } from "../src/modules/findCandidate/domain.js";
import { parseStorageCandidatesFromLlmOutput } from "../src/modules/findCandidate/parser.js";

type RuntimeProviderName = "openai" | "azure-openai" | "bedrock" | "local-llm" | "codex";
type RuntimeRouteMock = {
  provider: string;
  model: string;
  fallback: RuntimeProviderName[];
  azureDeploymentSlots?: number[];
};

const mocks = vi.hoisted(() => ({
  getDistillationTargetStateById: vi.fn(),
  readFileDomain: vi.fn(),
  readVibeMemoryByTokenWindow: vi.fn(),
  getVibeMemoryDescriptor: vi.fn(),
  runDistillationCompletion: vi.fn(),
  resolveDistillationModel: vi.fn(() => "test-model"),
  resolveRouteModelForProvider: vi.fn(
    (params: { routeModel?: string; localLlmModel?: string }) =>
      params.localLlmModel ?? params.routeModel ?? "test-model",
  ),
  ensureRuntimeSettingsLoaded: vi.fn(async () => {}),
  resolveFindCandidateRoute: vi.fn(
    (): RuntimeRouteMock => ({
      provider: "local-llm",
      model: "test-model",
      fallback: [] as RuntimeProviderName[],
    }),
  ),
  insertFindCandidateResult: vi.fn(),
  createEpisodeCard: vi.fn(),
  getEpisodeCardBySource: vi.fn(),
  recordAuditLogSafe: vi.fn(),
}));

vi.mock("../src/modules/distillationTarget/repository.js", () => ({
  getDistillationTargetStateById: mocks.getDistillationTargetStateById,
}));

vi.mock("../src/modules/readFile/domain.js", () => ({
  readFileDomain: mocks.readFileDomain,
}));

vi.mock("../src/modules/memoryReader/reader.service.js", () => ({
  readVibeMemoryByTokenWindow: mocks.readVibeMemoryByTokenWindow,
  getVibeMemoryDescriptor: mocks.getVibeMemoryDescriptor,
}));

vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  runDistillationCompletion: mocks.runDistillationCompletion,
  resolveDistillationModel: mocks.resolveDistillationModel,
  resolveRouteModelForProvider: mocks.resolveRouteModelForProvider,
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  insertFindCandidateResult: mocks.insertFindCandidateResult,
}));

vi.mock("../src/modules/episodic-memory/episode-card.repository.js", () => ({
  createEpisodeCard: mocks.createEpisodeCard,
  getEpisodeCardBySource: mocks.getEpisodeCardBySource,
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

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: mocks.ensureRuntimeSettingsLoaded,
  resolveFindCandidateRoute: mocks.resolveFindCandidateRoute,
}));

describe("runFindCandidate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.distillation.findCandidateProvider = "local-llm";
    groupedConfig.distillation.findCandidateTimeoutMs = 600_000;
    groupedConfig.distillationTools.findCandidateMaxToolCalls = 8;
    mocks.resolveFindCandidateRoute.mockImplementation(
      (): RuntimeRouteMock => ({
        provider: groupedConfig.distillation.findCandidateProvider,
        model: "test-model",
        fallback: [] as RuntimeProviderName[],
      }),
    );
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
              sourceSummary:
                "The source says to run smoke tests before finalizing implementation changes.",
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      };
    });
    mocks.insertFindCandidateResult.mockResolvedValue({ id: "candidate-1" });
    mocks.getEpisodeCardBySource.mockResolvedValue(null);
    mocks.createEpisodeCard.mockResolvedValue({ id: "episode-1" });
    mocks.getVibeMemoryDescriptor.mockResolvedValue(null);
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
            role: "system",
            content: expect.stringContaining("汎用的に使える知識として体裁を整える"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Use when: / Workflow: / Verification: / Avoid:"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("失敗原因、修正方法、検証方法"),
          }),
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("negative の rule 候補として出す"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("まず tool で本文を読んでください"),
          }),
        ]),
      }),
      expect.objectContaining({
        fallbackOrder: [],
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
        candidate: expect.objectContaining({
          type: "procedure",
          polarity: "positive",
          sourceSummary:
            "The source says to run smoke tests before finalizing implementation changes.",
        }),
      }),
    );
  });

  test("normalizes negative procedure candidates to rules before storage", async () => {
    mocks.runDistillationCompletion.mockImplementation(async (_request, options) => {
      await options.toolExecutor({
        id: "tool-1",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ fromToken: 0, readTokens: 20 }),
        },
      });
      return {
        content: JSON.stringify({
          candidates: [
            {
              type: "procedure",
              polarity: "negative",
              title: "Do not skip queue event checks",
              content: "Skipping queue event checks can hide stale worker state.",
              sourceSummary: "The source describes a stale worker diagnosis failure.",
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      };
    });

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(mocks.insertFindCandidateResult).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          type: "rule",
          originalType: "procedure",
          polarity: "negative",
        }),
      }),
    );
  });

  test("uses configured findCandidate timeout and tool-call limit", async () => {
    groupedConfig.distillation.findCandidateTimeoutMs = 123_000;
    groupedConfig.distillationTools.findCandidateMaxToolCalls = 12;

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        maxToolRounds: 12,
        timeoutMs: 123_000,
      }),
    );
  });

  test("defaults wiki candidate extraction to the configured findCandidate provider", async () => {
    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
      }),
      expect.objectContaining({
        providerSetting: "local-llm",
      }),
    );
  });

  test("allows OpenAI/Azure candidate extraction by provider setting", async () => {
    groupedConfig.distillation.findCandidateProvider = "azure-openai";

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
      }),
      expect.objectContaining({
        fallbackOrder: [],
        providerSetting: "azure-openai",
      }),
    );
  });

  test("passes configured task-route fallback order when provider is not explicitly overridden", async () => {
    mocks.resolveFindCandidateRoute.mockReturnValue({
      provider: "openai",
      model: "test-model",
      fallback: ["local-llm", "bedrock"] as RuntimeProviderName[],
    });

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        providerSetting: "openai",
        fallbackOrder: ["local-llm", "bedrock"],
      }),
    );
  });

  test("passes configured Azure deployment slots when provider is not explicitly overridden", async () => {
    mocks.resolveFindCandidateRoute.mockReturnValue({
      provider: "azure-openai",
      model: "test-model",
      fallback: ["local-llm"] as RuntimeProviderName[],
      azureDeploymentSlots: [2],
    });

    await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
    });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        providerSetting: "azure-openai",
        azureDeploymentSlots: [2],
      }),
    );
  });

  test("preloads wiki content before Codex candidate extraction and passes the configured Codex model", async () => {
    mocks.resolveFindCandidateRoute.mockReturnValue({
      provider: "codex",
      model: "gpt-5.4-mini",
      fallback: [] as RuntimeProviderName[],
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "procedure",
            title: "Run smoke tests before finalizing changes",
            content: "Run smoke tests before finalizing implementation changes.",
            sourceSummary:
              "The source says to run smoke tests before finalizing implementation changes.",
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-1",
      callerMode: "storage",
      readTokens: 50,
    });

    expect(mocks.resolveDistillationModel).not.toHaveBeenCalledWith("codex");
    expect(mocks.readFileDomain).toHaveBeenCalledWith({
      path: "rules/testing.md",
      fromToken: 0,
      readTokens: 50,
      minify: true,
    });
    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4-mini",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            name: "read_file",
            content: expect.stringContaining("Run smoke tests"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("read_file tool result"),
          }),
        ]),
      }),
      expect.objectContaining({
        providerSetting: "codex",
        requireToolCall: false,
        maxToolRounds: 7,
      }),
    );
    expect(result.candidates).toHaveLength(1);
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

  test("preloads vibe memory with memory_reader before asking the LLM for candidates", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
      sourceUri: "vibe_memory:memory-1",
      metadata: { sessionTitle: "Rust daemon migration workbook" },
    });
    mocks.getVibeMemoryDescriptor.mockResolvedValue({
      id: "memory-1",
      sessionId: "session-1",
      metadata: { title: "Lower priority memory title" },
      subject: "Lower priority subject",
      intent: null,
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
            role: "system",
            content: expect.stringContaining("会話が進捗報告中心でも"),
          }),
          expect.objectContaining({
            role: "tool",
            name: "memory_reader",
            content: expect.stringContaining("launchd"),
          }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("明確な再利用可能 signal がない場合だけ []"),
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
    expect(mocks.getEpisodeCardBySource).not.toHaveBeenCalled();
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not write a vibe memory episode for cli_text unless requested", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readVibeMemoryByTokenWindow.mockResolvedValue({
      content: "ASSISTANT: task completed with no durable candidate.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "cli_text",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not write a vibe memory episode even when requested", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.readVibeMemoryByTokenWindow.mockResolvedValue({
      content: "ASSISTANT: inspect logs and DB before changing queue code.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "cli_text",
      provider: "local-llm",
      writeEpisode: true,
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("uses vibe memory title when no session title is available", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.getVibeMemoryDescriptor.mockResolvedValue({
      id: "memory-1",
      sessionId: "session-1",
      metadata: { title: "Queue recovery investigation" },
      subject: null,
      intent: null,
    });
    mocks.readVibeMemoryByTokenWindow.mockResolvedValue({
      content: "ASSISTANT: inspect logs and DB before changing queue code.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not look up existing vibe memory episodes during findCandidate", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.getEpisodeCardBySource.mockResolvedValue({ id: "episode-existing" });
    mocks.readVibeMemoryByTokenWindow.mockResolvedValue({
      content: "ASSISTANT: existing task episode should be reused.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.getEpisodeCardBySource).not.toHaveBeenCalled();
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
  });

  test("does not create vibe memory episodes from storage mode", async () => {
    mocks.getDistillationTargetStateById.mockResolvedValue({
      id: "target-vibe",
      targetKind: "vibe_memory",
      targetKey: "memory-1",
    });
    mocks.getEpisodeCardBySource
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "episode-concurrent" });
    mocks.createEpisodeCard.mockRejectedValueOnce(new Error("duplicate key value"));
    mocks.readVibeMemoryByTokenWindow.mockResolvedValue({
      content: "ASSISTANT: concurrent task episode should be reused after insert race.",
      totalTokens: 12,
      from: 0,
      toExclusive: 12,
      returnedTokens: 12,
    });
    mocks.runDistillationCompletion.mockResolvedValue({
      content: "[]",
      toolEvents: [],
      messages: [],
    });

    const result = await runFindCandidate({
      targetStateId: "target-vibe",
      callerMode: "storage",
      provider: "local-llm",
    });

    expect(result.candidates).toEqual([]);
    expect(mocks.createEpisodeCard).not.toHaveBeenCalled();
    expect(mocks.getEpisodeCardBySource).not.toHaveBeenCalled();
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
            polarity: "positive",
            title: "Run focused verify before finalizing",
            content: "Run the focused test, inspect the returned evidence, then finalize.",
            sourceSummary:
              "The source describes running a focused test, inspecting evidence, and finalizing.",
          },
        ],
      }),
    );

    expect(candidates).toEqual([
      {
        type: "procedure",
        polarity: "positive",
        title: "Run focused verify before finalizing",
        content: "Run the focused test, inspect the returned evidence, then finalize.",
        sourceSummary:
          "The source describes running a focused test, inspecting evidence, and finalizing.",
      },
    ]);
  });

  test("keeps negative polarity hints when the LLM provides them", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            polarity: "negative",
            title: "Do not trust stale queue status alone",
            content:
              "Queue diagnosis must not treat an old status row as current truth without checking recent events.",
            sourceSummary:
              "The source describes a queue diagnosis mistake caused by relying on stale status.",
          },
        ],
      }),
    );

    expect(candidates).toEqual([
      {
        type: "rule",
        polarity: "negative",
        title: "Do not trust stale queue status alone",
        content:
          "Queue diagnosis must not treat an old status row as current truth without checking recent events.",
        sourceSummary:
          "The source describes a queue diagnosis mistake caused by relying on stale status.",
      },
    ]);
  });

  test("caps candidate sourceSummary from JSON output", () => {
    const candidates = parseStorageCandidatesFromLlmOutput(
      JSON.stringify({
        type: "rule",
        title: "Keep summaries short",
        content: "findCandidate should store concise source summaries.",
        sourceSummary: `start ${"x".repeat(1500)}`,
      }),
    );

    expect(candidates[0]?.sourceSummary).toHaveLength(1000);
    expect(candidates[0]?.sourceSummary?.startsWith("start ")).toBe(true);
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
        "POLARITY: negative",
        "TITLE: Verify pipeline before finalize",
        "CONTENT:",
        "1. Run typecheck.",
        "2. Run focused tests.",
        "3. Confirm evidence payload before finalize.",
        "SOURCE_SUMMARY:",
        "The source describes typecheck, focused tests, and evidence confirmation.",
      ].join("\n"),
    );
    expect(candidates).toEqual([
      {
        type: "procedure",
        polarity: "negative",
        title: "Verify pipeline before finalize",
        content:
          "1. Run typecheck.\n2. Run focused tests.\n3. Confirm evidence payload before finalize.",
        sourceSummary: "The source describes typecheck, focused tests, and evidence confirmation.",
      },
    ]);
  });
});
