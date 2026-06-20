import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";
import { parseCoverEvidenceResult } from "../src/modules/coverEvidence/parser.js";
import { estimateTextTokens } from "../src/modules/llm/token-estimator.js";

const mocks = vi.hoisted(() => ({
  getFindCandidateResultById: vi.fn(),
  readFileDomain: vi.fn(),
  readVibeMemoryByTokenWindow: vi.fn(),
  searchKnowledge: vi.fn(),
  findSimilarKnowledge: vi.fn(),
  recordAuditLogSafe: vi.fn(),
  selectCoverEvidenceResultById: vi.fn(),
  saveCoverEvidenceResult: vi.fn(),
  coverEvidenceResultFromRow: vi.fn(),
  resolveDistillationModel: vi.fn(() => "test-model"),
  resolveRouteModelForProvider: vi.fn(
    (params: { routeModel?: string; localLlmModel?: string }) =>
      params.localLlmModel ?? params.routeModel ?? "test-model",
  ),
  runDistillationCompletion: vi.fn(),
  executeDistillationToolCall: vi.fn(),
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  getFindCandidateResultById: mocks.getFindCandidateResultById,
}));

vi.mock("../src/modules/readFile/domain.js", () => ({
  readFileDomain: mocks.readFileDomain,
}));

vi.mock("../src/modules/memoryReader/reader.service.js", () => ({
  readVibeMemoryByTokenWindow: mocks.readVibeMemoryByTokenWindow,
}));

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  searchKnowledge: mocks.searchKnowledge,
}));

vi.mock("../src/lib/knowledge-dedup.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/knowledge-dedup.js")>(
    "../src/lib/knowledge-dedup.js",
  );
  return {
    ...actual,
    findSimilarKnowledge: mocks.findSimilarKnowledge,
  };
});

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    coverEvidenceStarted: "COVER_EVIDENCE_STARTED",
    coverEvidenceCompleted: "COVER_EVIDENCE_COMPLETED",
    coverEvidenceFailed: "COVER_EVIDENCE_FAILED",
    coverEvidenceProcedureRepairStarted: "COVER_EVIDENCE_PROCEDURE_REPAIR_STARTED",
    coverEvidenceProcedureRepairCompleted: "COVER_EVIDENCE_PROCEDURE_REPAIR_COMPLETED",
    coverEvidenceProcedureDemotedToRule: "COVER_EVIDENCE_PROCEDURE_DEMOTED_TO_RULE",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

vi.mock("../src/modules/coverEvidence/repository.js", () => ({
  selectCoverEvidenceResultById: mocks.selectCoverEvidenceResultById,
  saveCoverEvidenceResult: mocks.saveCoverEvidenceResult,
  coverEvidenceResultFromRow: mocks.coverEvidenceResultFromRow,
}));

vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  resolveDistillationModel: mocks.resolveDistillationModel,
  resolveRouteModelForProvider: mocks.resolveRouteModelForProvider,
  runDistillationCompletion: mocks.runDistillationCompletion,
  distillationToolEventsFromError: (error: unknown) =>
    error && typeof error === "object" && "distillationToolEvents" in error
      ? (error as { distillationToolEvents: unknown[] }).distillationToolEvents
      : [],
}));

vi.mock("../src/modules/distillation/distillation-tools.service.js", () => ({
  executeDistillationToolCall: mocks.executeDistillationToolCall,
}));

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "find-1",
    targetStateId: "target-1",
    targetKind: "wiki_file",
    targetKey: "rules/testing.md",
    sourceUri: "/wiki/pages/rules/testing.md",
    provider: "local-llm",
    model: "gemma",
    candidateIndex: 0,
    title: "Run smoke tests before finalizing coverEvidence",
    content:
      "Run smoke tests before finalizing coverEvidence so source references and evidence status stay verifiable.",
    origin: { readRanges: [{ from: 0, toExclusive: 120 }] },
    status: "selected",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function skillLikeProcedureBody(): string {
  return [
    "Use when: Use this when coverEvidence changes are ready to finalize and the result must remain traceable to source evidence.",
    "",
    "Workflow:",
    "1. Run the focused smoke or unit test for the changed coverEvidence path.",
    "2. Inspect the returned output and confirm source references are present.",
    "3. Finalize only after the evidence status is knowledge_ready.",
    "",
    "Verification: Confirm the command output shows the focused test passed and the saved result keeps source references.",
    "",
    "Avoid: Do not finalize when the source reference is missing or the test output was not inspected.",
  ].join("\n");
}

function completion(content: string, toolEvents: unknown[] = []) {
  return { content, toolEvents, messages: [] };
}

function defaultExternalFinalOutput() {
  return JSON.stringify({
    schemaVersion: 1,
    status: "knowledge_ready",
    stage: "source",
    candidate: {
      type: "procedure",
      title: "Run smoke tests before finalizing coverEvidence",
      body: skillLikeProcedureBody(),
      importance: 80,
      confidence: 85,
      technologies: "typescript, vitest",
      changeTypes: "test",
      domains: "distillation, testing",
    },
    references: [],
    duplicateRefs: [],
    toolEvents: [],
    reason: null,
  });
}

function mockExternalEvidenceRounds(finalOutput: string, extraOutputs: string[] = []) {
  mocks.runDistillationCompletion.mockReset();
  mocks.runDistillationCompletion
    .mockResolvedValueOnce(completion("| coverEvidence | testing |"))
    .mockResolvedValueOnce(completion("1"))
    .mockResolvedValueOnce(completion(finalOutput));
  for (const output of extraOutputs) {
    mocks.runDistillationCompletion.mockResolvedValueOnce(completion(output));
  }
}

describe("runCoverEvidence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getFindCandidateResultById.mockResolvedValue(candidateRow());
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Run smoke tests before finalizing coverEvidence so source references and evidence status stay verifiable.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mocks.searchKnowledge.mockResolvedValue([]);
    mocks.findSimilarKnowledge.mockResolvedValue([]);
    mocks.selectCoverEvidenceResultById.mockResolvedValue(null);
    mocks.saveCoverEvidenceResult.mockImplementation(async ({ result }) => ({
      id: "cover-1",
      ...result,
    }));
    mockExternalEvidenceRounds(defaultExternalFinalOutput());
    mocks.executeDistillationToolCall.mockImplementation(async (toolCall) => {
      if (toolCall.function.name === "search_web") {
        return {
          callId: toolCall.id,
          name: "search_web",
          ok: true,
          content: JSON.stringify({
            query: "coverEvidence testing",
            results: [
              {
                title: "Example docs",
                url: "https://example.com/docs",
                snippet: "Fetched docs for coverEvidence testing.",
              },
            ],
          }),
          metadata: { query: "coverEvidence testing", resultCount: 1, provider: "test" },
        };
      }
      return {
        callId: toolCall.id,
        name: "fetch_content",
        ok: true,
        content: JSON.stringify({
          selected: [
            {
              index: 1,
              url: "https://example.com/docs",
              ok: true,
              content: "Fetched docs",
            },
          ],
        }),
        metadata: {
          selection: "1",
          selectedUrls: ["https://example.com/docs"],
          selectedCount: 1,
        },
      };
    });
    process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "";
    process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "";
  });

  test("repairs procedure candidates when source evidence supports the required sections", async () => {
    mocks.readFileDomain.mockResolvedValue({
      content: [
        "Use this when finalizing coverEvidence changes.",
        "1. Run bunx vitest run test/cover-evidence.test.ts.",
        "2. Inspect the saved cover evidence references.",
        "Verification: confirm the test passes and references are preserved.",
        "Avoid skipping source reference inspection.",
      ].join("\n"),
      totalTokens: 180,
      from: 0,
      toExclusive: 180,
      returnedTokens: 180,
    });
    mockExternalEvidenceRounds(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Finalize coverEvidence safely",
          body: "Run tests, then inspect references.",
          importance: 88,
          confidence: 86,
          technologies: "typescript, vitest",
          changeTypes: "testing",
          domains: "distillation",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
      [
        JSON.stringify({
          title: "Finalize coverEvidence safely",
          body: [
            "Use when: Use this when finalizing coverEvidence changes.",
            "",
            "Workflow:",
            "1. Run bunx vitest run test/cover-evidence.test.ts.",
            "2. Inspect the saved cover evidence references.",
            "",
            "Verification: Confirm the test passes and references are preserved.",
            "",
            "Avoid: Do not skip source reference inspection.",
          ].join("\n"),
        }),
      ],
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.candidate?.body).toContain("Use when:");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "procedure_repair",
          ok: true,
        }),
      ]),
    );
  });

  test("keeps explicit rule candidates when value assessment misclassifies them as procedures", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        targetKind: "knowledge_candidate",
        targetKey: "candidate-rule-1",
        sourceUri: "agent://candidate/candidate-rule-1",
        title: "Test behavior, not implementation",
        content:
          "1. Run the nearest behavior test first.\n2. Then run the related test range.\nAvoid private method tests.",
        origin: {
          candidateType: "rule",
          readRanges: [{ from: 0, toExclusive: 120 }],
        },
      }),
    );
    mockExternalEvidenceRounds(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Test behavior, not implementation",
          body: "1. Run the nearest behavior test first.\n2. Then run the related test range.",
          importance: 90,
          confidence: 90,
          technologies: "vitest",
          changeTypes: "testing",
          domains: "test-strategy",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("rule");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "procedure_demoted_to_rule",
          ok: true,
        }),
      ]),
    );
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          status: "knowledge_ready",
          candidate: expect.objectContaining({ type: "rule" }),
        }),
      }),
    );
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_PROCEDURE_DEMOTED_TO_RULE",
        payload: expect.objectContaining({ id: "find-1", saved: true }),
      }),
    );
  });

  test("demotes one-line procedure misclassifications to rules", async () => {
    mockExternalEvidenceRounds(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "頻出クエリは Prepared Statement を使う",
          body: "繰り返し実行するクエリは `prepare()` で Prepared Statement 化して高速化する。",
          importance: 90,
          confidence: 95,
          technologies: "postgresql",
          changeTypes: "performance",
          domains: "database",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("rule");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          status: "knowledge_ready",
          candidate: expect.objectContaining({ type: "rule" }),
        }),
      }),
    );
  });

  test("normalizes invalid procedure rows when reusing cached cover evidence", async () => {
    mocks.selectCoverEvidenceResultById.mockResolvedValue({
      id: "find-1",
      status: "knowledge_ready",
      stage: "final",
      type: "procedure",
      title: "頻出クエリは Prepared Statement を使う",
      body: "繰り返し実行するクエリは `prepare()` で Prepared Statement 化して高速化する。",
      importance: 90,
      confidence: 95,
    });
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      schemaVersion: 1,
      status: "knowledge_ready",
      stage: "final",
      candidate: {
        type: "procedure",
        title: "頻出クエリは Prepared Statement を使う",
        body: "繰り返し実行するクエリは `prepare()` で Prepared Statement 化して高速化する。",
        importance: 90,
        confidence: 95,
      },
      references: [],
      duplicateRefs: [],
      toolEvents: [],
      reason: null,
    });

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.candidate?.type).toBe("rule");
    expect(mocks.runDistillationCompletion).not.toHaveBeenCalled();
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          candidate: expect.objectContaining({ type: "rule" }),
        }),
      }),
    );
  });

  test("persists cover_evidence_results when write is enabled", async () => {
    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.id).toBe("find-1");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({ status: "knowledge_ready" }),
      }),
    );
  });

  test("reruns retryable existing cover evidence instead of returning the checkpoint", async () => {
    mocks.selectCoverEvidenceResultById.mockResolvedValue({
      id: "find-1",
      status: "provider_failed",
      stage: "final",
      reason: "value_provider_failed",
    });
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      schemaVersion: 1,
      status: "provider_failed",
      stage: "final",
      candidate: null,
      references: [],
      duplicateRefs: [],
      toolEvents: [],
      reason: "value_provider_failed",
    });

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(mocks.getFindCandidateResultById).toHaveBeenCalledWith("find-1");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({ status: "knowledge_ready" }),
      }),
    );
  });

  test("rejects source-backed candidates with low value assessment importance", async () => {
    mockExternalEvidenceRounds(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "source",
        candidate: {
          type: "procedure",
          title: "Low value reminder",
          body: "Low value operational reminders should not become durable knowledge.",
          importance: 50,
          confidence: 80,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    const result = await runCoverEvidence({ id: "find-1", write: true });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("low_importance");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          status: "insufficient",
          reason: "low_importance",
          candidate: null,
        }),
      }),
    );
  });

  test("uses fetch evidence before accepting external claims", async () => {
    const externalOutput = JSON.stringify({
      schemaVersion: 1,
      status: "knowledge_ready",
      stage: "web",
      candidate: {
        type: "rule",
        title: "Use current API docs from example docs",
        body: "Use fetched API documentation before preserving provider behavior claims.",
        importance: 80,
        confidence: 84,
        technologies: "api, docs",
        changeTypes: "verification",
        domains: "provider-behavior",
      },
      references: [],
      duplicateRefs: [],
      toolEvents: [],
      reason: null,
    });
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Use current API docs from https://example.com/docs",
        content:
          "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mockExternalEvidenceRounds(externalOutput);

    const result = await runCoverEvidence({
      id: "find-1",
      forceRefreshEvidence: true,
    });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.references.some((ref) => ref.uri === "https://example.com/docs")).toBe(
      true,
    );
    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(3);
    expect(mocks.runDistillationCompletion).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        auditContext: expect.objectContaining({
          assessment: "external-search-query",
          forceRefreshEvidence: true,
        }),
        enableTools: false,
        usageSource: "cover-evidence:external-search-query",
      }),
    );
    expect(mocks.runDistillationCompletion).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        auditContext: expect.objectContaining({ assessment: "external-fetch-selection" }),
        enableTools: false,
        usageSource: "cover-evidence:external-fetch-selection",
      }),
    );
    expect(mocks.runDistillationCompletion).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({
        auditContext: expect.objectContaining({ assessment: "external-final" }),
        enableTools: false,
        usageSource: "cover-evidence:external-final",
      }),
    );
    expect(mocks.executeDistillationToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        function: expect.objectContaining({ name: "search_web" }),
      }),
      expect.objectContaining({ id: "find-1" }),
    );
    expect(mocks.executeDistillationToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        function: expect.objectContaining({
          name: "fetch_content",
          arguments: JSON.stringify({ url: "https://example.com/docs" }),
        }),
      }),
      expect.objectContaining({ id: "find-1" }),
    );
    const searchRequest = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(searchRequest.messages[0]?.content).toContain("検索語だけ");
    expect(searchRequest.messages[0]?.content).toContain("3個以下");
    expect(searchRequest.messages[1]?.content).toContain("検索語ヒント");
    const selectionRequest = mocks.runDistillationCompletion.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(selectionRequest.messages[0]?.content).toContain("候補番号だけ");
    const finalRequest = mocks.runDistillationCompletion.mock.calls[2]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(finalRequest.messages[0]?.content).toContain(
      "source evidence と fetch_content evidence",
    );
    expect(finalRequest.messages[0]?.content).toContain("汎用的に使える知識として体裁");
  });

  test("fetches multiple web sources and passes roughly 15k tokens of web evidence", async () => {
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| coverEvidence | testing |"))
      .mockResolvedValueOnce(completion("1,2,3,4,5,6,7,8"))
      .mockResolvedValueOnce(completion(defaultExternalFinalOutput()));
    mocks.executeDistillationToolCall.mockImplementation(async (toolCall) => {
      const args = JSON.parse(toolCall.function.arguments) as { query?: string; url?: string };
      if (toolCall.function.name === "search_web") {
        return {
          callId: toolCall.id,
          name: "search_web",
          ok: true,
          content: JSON.stringify({
            query: args.query,
            results: Array.from({ length: 8 }, (_, index) => ({
              title: `Example docs ${index + 1}`,
              url: `https://example.com/docs/${index + 1}`,
              snippet: `Fetched docs for coverEvidence testing ${index + 1}.`,
            })),
          }),
          metadata: { query: args.query, resultCount: 8, provider: "test" },
        };
      }
      const url = args.url ?? "https://example.com/docs/unknown";
      return {
        callId: toolCall.id,
        name: "fetch_content",
        ok: true,
        content: JSON.stringify({
          url,
          text: `Primary source ${url}. ${"Detailed external evidence. ".repeat(900)}`,
        }),
        metadata: { url, finalUrl: url },
      };
    });

    const result = await runCoverEvidence({ id: "find-1", forceRefreshEvidence: true });

    expect(result.result.status).toBe("knowledge_ready");
    const fetchCalls = mocks.executeDistillationToolCall.mock.calls.filter(
      (call) => call[0]?.function?.name === "fetch_content",
    );
    expect(fetchCalls).toHaveLength(8);
    expect(fetchCalls.map((call) => JSON.parse(call[0].function.arguments).url)).toContain(
      "https://example.com/docs/8",
    );
    const finalRequest = mocks.runDistillationCompletion.mock.calls[2]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const webEvidence =
      finalRequest.messages[1]?.content.split("fetch_content evidence:\n")[1] ?? "";
    expect(webEvidence.length).toBeGreaterThan(12_000);
    expect(estimateTextTokens(webEvidence)).toBeLessThanOrEqual(15_000);
    expect(finalRequest.messages[0]?.content).toContain("最大約 15000 token");
  });

  test("expands sparse fetch selection with top search results", async () => {
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| coverEvidence | testing |"))
      .mockResolvedValueOnce(completion("1"))
      .mockResolvedValueOnce(completion(defaultExternalFinalOutput()));
    mocks.executeDistillationToolCall.mockImplementation(async (toolCall) => {
      const args = JSON.parse(toolCall.function.arguments) as { query?: string; url?: string };
      if (toolCall.function.name === "search_web") {
        return {
          callId: toolCall.id,
          name: "search_web",
          ok: true,
          content: JSON.stringify({
            query: args.query,
            results: Array.from({ length: 4 }, (_, index) => ({
              title: `Example docs ${index + 1}`,
              url: `https://example.com/expand/${index + 1}`,
              snippet: `Fetched docs for expansion ${index + 1}.`,
            })),
          }),
          metadata: { query: args.query, resultCount: 4, provider: "test" },
        };
      }
      const url = args.url ?? "https://example.com/expand/unknown";
      return {
        callId: toolCall.id,
        name: "fetch_content",
        ok: true,
        content: JSON.stringify({ url, text: `Primary source ${url}.` }),
        metadata: { url, finalUrl: url },
      };
    });

    const result = await runCoverEvidence({ id: "find-1", forceRefreshEvidence: true });

    expect(result.result.status).toBe("knowledge_ready");
    const fetchUrls = mocks.executeDistillationToolCall.mock.calls
      .filter((call) => call[0]?.function?.name === "fetch_content")
      .map((call) => JSON.parse(call[0].function.arguments).url);
    expect(fetchUrls).toEqual([
      "https://example.com/expand/1",
      "https://example.com/expand/2",
      "https://example.com/expand/3",
      "https://example.com/expand/4",
    ]);
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "fetch_selection",
          metadata: expect.objectContaining({ expandedSelection: "1,2,3,4" }),
        }),
      ]),
    );
  });

  test("refines missing applicability facets before accepting external evidence", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Use Number.isNaN for CLI numeric validation",
        content: "CLI numeric validation should use Number.isNaN after parsing input.",
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content: "CLI numeric validation should use Number.isNaN after parsing input.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| Number.isNaN | CLI |"))
      .mockResolvedValueOnce(completion("1"))
      .mockResolvedValueOnce(
        completion(
          [
            "STATUS: knowledge_ready",
            "STAGE: web",
            "TYPE: rule",
            "TITLE: Use Number.isNaN for CLI numeric validation",
            "BODY: CLI numeric validation should use Number.isNaN after parsing input.",
            "IMPORTANCE: 80",
            "CONFIDENCE: 90",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(
        completion(
          [
            "STATUS: knowledge_ready",
            "STAGE: final",
            "TYPE: rule",
            "TITLE: Use Number.isNaN for CLI numeric validation",
            "BODY: CLI numeric validation should use Number.isNaN after parsing input.",
            "TECHNOLOGIES: JavaScript, CLI",
            "CHANGE_TYPES: validation",
            "DOMAINS: command-line-tools",
          ].join("\n"),
        ),
      );

    const result = await runCoverEvidence({ id: "find-1", forceRefreshEvidence: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate).toMatchObject({
      technologies: ["JavaScript", "CLI"],
      changeTypes: ["validation"],
      domains: ["command-line-tools"],
    });
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "applicability_refinement",
          ok: true,
          metadata: expect.objectContaining({ missingAfter: [] }),
        }),
      ]),
    );
    expect(mocks.runDistillationCompletion.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        usageSource: "cover-evidence:applicability-refinement",
      }),
    );
  });

  test("falls back to the source-supported candidate when final no-tools round emits a tool call", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Run focused tests before the full suite",
        content: "Rule: Run focused tests for the changed area before running the full test suite.",
        origin: {
          candidateType: "rule",
          technologies: ["general"],
          changeTypes: ["testing"],
          domains: ["engineering-process"],
        },
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content: "Rule: Run focused tests for the changed area before running the full test suite.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| focused tests |"))
      .mockResolvedValueOnce(completion("1"))
      .mockRejectedValueOnce(new Error("distillation tool loop exceeded max rounds (0)"));

    const result = await runCoverEvidence({ id: "find-1", forceRefreshEvidence: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate).toMatchObject({
      type: "rule",
      title: "Run focused tests before the full suite",
    });
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "external_final_candidate_fallback",
          ok: true,
        }),
      ]),
    );
  });

  test("falls back to the source-supported candidate when final output is only a label stub", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Pin related files before implementation",
        content:
          "Rule: Keep related files and established implementation patterns fixed before changing code.",
        origin: {
          candidateType: "rule",
          technologies: ["llm-workflow"],
          changeTypes: ["implementation-guidance"],
          domains: ["codebase-navigation"],
        },
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Rule: Keep related files and established implementation patterns fixed before changing code.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| llm-workflow |"))
      .mockResolvedValueOnce(completion("1"))
      .mockResolvedValueOnce(completion("STATUS"));

    const result = await runCoverEvidence({ id: "find-1", forceRefreshEvidence: true });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.title).toBe("Pin related files before implementation");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "external_final_candidate_fallback",
          ok: true,
          metadata: expect.objectContaining({ reason: "label_stub_in_no_tools_final" }),
        }),
      ]),
    );
  });

  test("records parser diagnostics when external evidence output cannot be parsed", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Use current API docs from https://example.com/docs",
        content:
          "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mockExternalEvidenceRounds(
      "The fetched documentation looks useful, but I cannot produce JSON.",
    );

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("parse_failed");
    expect(result.result.reason).toBe("external_parse_failed");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "parse_cover_evidence_result",
          ok: false,
          error: "coverEvidence output must be a JSON object",
          metadata: expect.objectContaining({
            reason: "external_parse_failed",
            contentPreview: expect.stringContaining("cannot produce JSON"),
            toolEventCount: expect.any(Number),
          }),
        }),
      ]),
    );
    const parseFailure = result.result.toolEvents.find(
      (event) => event.name === "parse_cover_evidence_result",
    );
    expect(Number(parseFailure?.metadata?.toolEventCount ?? 0)).toBeGreaterThanOrEqual(4);
  });

  test("classifies LLM timeout with prior tool events as provider failure", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Use current API docs from https://example.com/docs",
        content:
          "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    const error = Object.assign(new Error("local-llm: distillation request timed out"), {
      distillationToolEvents: [
        {
          callId: "call-1",
          name: "fetch_content",
          ok: true,
          content: "Fetched docs",
          metadata: { url: "https://example.com/docs" },
        },
      ],
    });
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| API | docs |"))
      .mockResolvedValueOnce(completion("1"))
      .mockRejectedValueOnce(error);

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("provider_failed");
    expect(result.result.reason).toBe("external_provider_timeout");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "search_web",
          ok: true,
        }),
        expect.objectContaining({
          name: "fetch_content",
          ok: true,
        }),
      ]),
    );
  });

  test("keeps failed tool events classified as tool failure even when the LLM also times out", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Use current API docs from https://example.com/docs",
        content:
          "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Use current API docs from https://example.com/docs before preserving provider behavior claims.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    const error = Object.assign(new Error("local-llm: distillation request timed out"), {
      distillationToolEvents: [
        {
          callId: "call-1",
          name: "fetch_content",
          ok: false,
          content: JSON.stringify({ error: "request timed out after 30000ms" }),
          error: "request timed out after 30000ms",
          metadata: { url: "https://example.com/docs" },
        },
      ],
    });
    mocks.runDistillationCompletion.mockReset();
    mocks.runDistillationCompletion
      .mockResolvedValueOnce(completion("| API | docs |"))
      .mockResolvedValueOnce(completion("1"))
      .mockRejectedValueOnce(error);

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("tool_failed");
    expect(result.result.reason).toBe("external_tool_failed");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "search_web",
          ok: true,
        }),
        expect.objectContaining({
          name: "fetch_content",
          ok: false,
        }),
      ]),
    );
  });
});
