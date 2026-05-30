import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";
import { parseCoverEvidenceResult } from "../src/modules/coverEvidence/parser.js";

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

function completion(content: string, toolEvents: unknown[] = [], messages: unknown[] = []) {
  return { content, toolEvents, messages };
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
          url: "https://example.com/docs",
        },
      };
    });
    process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "";
    process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "";
  });

  test("uses fetched external evidence when repairing procedure bodies", async () => {
    const fetchedProcedureEvidence = [
      "Use this when validating provider API behavior against current docs.",
      "1. Fetch the current API documentation before changing provider behavior.",
      "2. Compare the provider flow with the fetched documentation.",
      "Verification: Confirm the provider behavior matches the fetched docs.",
      "Avoid using stale docs or snippets without fetching the page.",
    ].join("\n");
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Use current API docs from https://example.com/docs",
        content:
          "1. Fetch current API docs from https://example.com/docs.\n2. Verify provider behavior against the fetched docs.",
        origin: {
          candidateType: "procedure",
          readRanges: [{ from: 0, toExclusive: 140 }],
        },
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "1. Fetch current API docs from https://example.com/docs.\n2. Verify provider behavior against the fetched docs.",
      totalTokens: 140,
      from: 0,
      toExclusive: 140,
      returnedTokens: 140,
    });
    mocks.executeDistillationToolCall.mockImplementation(async (toolCall) => {
      if (toolCall.function.name === "search_web") {
        return {
          callId: toolCall.id,
          name: "search_web",
          ok: true,
          content: JSON.stringify({
            query: "example docs",
            results: [
              {
                title: "Example docs",
                url: "https://example.com/docs",
                snippet: "Current API docs for example provider.",
              },
            ],
          }),
          metadata: { query: "example docs", resultCount: 1, provider: "test" },
        };
      }
      return {
        callId: toolCall.id,
        name: "fetch_content",
        ok: true,
        content: fetchedProcedureEvidence,
        metadata: {
          url: "https://example.com/docs",
          selectedUrls: ["https://example.com/docs"],
          selectedCount: 1,
        },
      };
    });
    mockExternalEvidenceRounds(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "web",
        candidate: {
          type: "procedure",
          title: "Use current API docs from example docs",
          body: "Fetch the docs, then verify provider behavior.",
          importance: 86,
          confidence: 84,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
      [
        JSON.stringify({
          title: "Use current API docs from example docs",
          body: [
            "Use when: Use this when validating provider API behavior against current docs.",
            "",
            "Workflow:",
            "1. Fetch the current API documentation before changing provider behavior.",
            "2. Compare the provider flow with the fetched documentation.",
            "",
            "Verification: Confirm the provider behavior matches the fetched docs.",
            "",
            "Avoid: Do not use stale docs or snippets without fetching the page.",
          ].join("\n"),
        }),
      ],
    );

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.candidate?.body).toContain("Use when:");
    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(4);
    const repairRequest = mocks.runDistillationCompletion.mock.calls[3]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(repairRequest.messages[1]?.content).toContain(
      "Tool evidence (fetch_content https://example.com/docs)",
    );
    expect(repairRequest.messages[1]?.content).toContain(
      "Fetch the current API documentation before changing provider behavior.",
    );
  });

  test("preserves MCP evidence references when available", async () => {
    const externalOutput = JSON.stringify({
      schemaVersion: 1,
      status: "knowledge_ready",
      stage: "web",
      candidate: {
        type: "rule",
        title: "Use Context7 docs for API behavior",
        body: "Use fetched and MCP-backed API documentation before preserving provider behavior claims.",
        importance: 80,
        confidence: 84,
      },
      references: [],
      duplicateRefs: [],
      toolEvents: [],
      reason: null,
    });
    const mcpOutput = JSON.stringify({ status: "checked" });
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
    process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "stub";
    mockExternalEvidenceRounds(externalOutput);
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: mcpOutput,
      toolEvents: [
        {
          callId: "call-2",
          name: "context7",
          ok: true,
          content: "Context7 docs",
          metadata: {
            uri: "context7://example/api",
            title: "Example API",
            locator: "api-reference",
          },
        },
      ],
      messages: [],
    });

    const result = await runCoverEvidence({ id: "find-1" });

    expect(mocks.runDistillationCompletion).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        enableTools: false,
        usageSource: "cover-evidence:external-search-query",
      }),
    );
    expect(mocks.runDistillationCompletion).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({
        toolNames: ["context7"],
        usageSource: "cover-evidence:mcp-evidence",
      }),
    );
    expect(result.result.references).toContainEqual(
      expect.objectContaining({
        kind: "context7",
        uri: "context7://example/api",
        locator: "api-reference",
        evidenceRole: "external_verification",
      }),
    );
  });
});
