import { beforeEach, describe, expect, test, vi } from "vitest";
import { parseCoverEvidenceResult } from "../src/modules/coverEvidence/parser.js";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";

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

describe("coverEvidence parser", () => {
  test("parses a knowledge-ready result", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Keep evidence",
          body: "coverEvidence must keep source evidence before finalization.",
          importance: 72,
          confidence: 81,
        },
        references: [
          {
            kind: "source",
            uri: "file.md",
            note: "source range",
            evidenceRole: "supports_candidate",
          },
        ],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate?.confidence).toBe(81);
    expect(parsed.references).toHaveLength(1);
  });

  test("rejects non-integer score scales", () => {
    expect(() =>
      parseCoverEvidenceResult(
        JSON.stringify({
          status: "knowledge_ready",
          stage: "final",
          candidate: {
            type: "rule",
            title: "Bad score",
            body: "Score should use integer percent values.",
            importance: 0.8,
            confidence: 80,
          },
          references: [],
          duplicateRefs: [],
          toolEvents: [],
        }),
      ),
    ).toThrow("candidate.importance must be an integer from 0 to 100");
  });
});

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
    process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "";
    process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "";
  });

  test("returns source-backed knowledge_ready without creating a draft", async () => {
    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.references[0]).toMatchObject({
      kind: "source",
      evidenceRole: "supports_candidate",
    });
    expect(mocks.saveCoverEvidenceResult).not.toHaveBeenCalled();
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
        toolNames: ["search_web", "fetch_content"],
      }),
    );
    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(1);
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
    mocks.runDistillationCompletion.mockResolvedValueOnce({
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
      expect.objectContaining({ toolNames: ["search_web", "fetch_content"] }),
    );
    expect(mocks.runDistillationCompletion).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ toolNames: ["context7"] }),
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
