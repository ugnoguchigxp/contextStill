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

describe("runCoverEvidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.runDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
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
      }),
      toolEvents: [],
      messages: [],
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
    mocks.runDistillationCompletion
      .mockResolvedValueOnce({
        content: JSON.stringify({
          schemaVersion: 1,
          status: "knowledge_ready",
          stage: "final",
          candidate: {
            type: "procedure",
            title: "Finalize coverEvidence safely",
            body: "Run tests, then inspect references.",
            importance: 88,
            confidence: 86,
          },
          references: [],
          duplicateRefs: [],
          toolEvents: [],
          reason: null,
        }),
        toolEvents: [],
        messages: [],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
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
        toolEvents: [],
        messages: [],
      });

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
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Test behavior, not implementation",
          body: "1. Run the nearest behavior test first.\n2. Then run the related test range.",
          importance: 90,
          confidence: 90,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
      toolEvents: [],
      messages: [],
    });

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
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
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
      }),
      toolEvents: [],
      messages: [],
    });

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
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
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
      toolEvents: [],
      messages: [],
    });

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
    mocks.runDistillationCompletion.mockResolvedValue({
      content: externalOutput,
      toolEvents: [
        {
          callId: "call-1",
          name: "fetch_content",
          ok: true,
          content: "Fetched docs",
          metadata: { url: "https://example.com/docs" },
        },
      ],
      messages: [],
    });

    const result = await runCoverEvidence({
      id: "find-1",
      forceRefreshEvidence: true,
    });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.references.some((ref) => ref.uri === "https://example.com/docs")).toBe(
      true,
    );
    expect(mocks.runDistillationCompletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        auditContext: expect.objectContaining({ forceRefreshEvidence: true }),
        maxToolRounds: expect.any(Number),
        toolNames: ["search_web", "fetch_content"],
        usageSource: "cover-evidence:external-evidence",
      }),
    );
    const options = mocks.runDistillationCompletion.mock.calls[0]?.[1] as {
      maxToolRounds: number;
      timeoutMs: number;
      toolCallLimits: Record<string, number>;
    };
    expect(options.maxToolRounds).toBe(4);
    expect(options.timeoutMs).toBe(600_000);
    expect(options.toolCallLimits).toEqual({ search_web: 1, fetch_content: 3 });
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages[0]?.content).toContain("fetch_content は同じ検証 session で複数回");
    expect(request.messages[0]?.content).toContain("search_web を同義の言い換え query");
    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(1);
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
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: "The fetched documentation looks useful, but I cannot produce JSON.",
      toolEvents: [
        {
          callId: "call-1",
          name: "fetch_content",
          ok: true,
          content: "Fetched docs",
          metadata: { url: "https://example.com/docs" },
        },
      ],
      messages: [],
    });

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
            toolEventCount: 1,
          }),
        }),
      ]),
    );
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
    mocks.runDistillationCompletion.mockRejectedValueOnce(error);

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("provider_failed");
    expect(result.result.reason).toBe("external_provider_timeout");
    expect(result.result.toolEvents).toEqual([
      expect.objectContaining({
        name: "fetch_content",
        ok: true,
      }),
    ]);
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
    mocks.runDistillationCompletion.mockRejectedValueOnce(error);

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("tool_failed");
    expect(result.result.reason).toBe("external_tool_failed");
    expect(result.result.toolEvents).toEqual([
      expect.objectContaining({
        name: "fetch_content",
        ok: false,
      }),
    ]);
  });
});
