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
          technologies: "typescript, vitest",
          changeTypes: "test",
          domains: "distillation, context-compiler",
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
    expect(parsed.candidate).toMatchObject({
      technologies: ["typescript", "vitest"],
      changeTypes: ["test"],
      domains: ["distillation", "context-compiler"],
    });
    expect(parsed.references).toHaveLength(1);
  });

  test("does not require applicability fields", () => {
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
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
    );

    expect(parsed.candidate).not.toHaveProperty("technologies");
    expect(parsed.candidate).not.toHaveProperty("changeTypes");
  });

  test("fills omitted candidate fields from caller defaults", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          title: "Preserve registration hints",
          body: "Registration hints should survive when the assessor only rewrites title and body.",
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
      {
        candidateDefaults: {
          type: "procedure",
          importance: 91,
          confidence: 77,
          technologies: ["typescript"],
          changeTypes: ["bugfix"],
          domains: ["candidate-registration"],
          repoPath: "/Users/y.noguchi/Code/memoryRouter",
          repoKey: "memoryRouter",
        },
      },
    );

    expect(parsed.candidate).toMatchObject({
      type: "procedure",
      importance: 91,
      confidence: 77,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["candidate-registration"],
      repoPath: "/Users/y.noguchi/Code/memoryRouter",
      repoKey: "memoryRouter",
    });
  });

  test("accepts flat output and normalizes non-integer score scales", () => {
    const parsed = parseCoverEvidenceResult(
      JSON.stringify({
        status: "knowledge_ready",
        stage: "final",
        type: "rule",
        title: "Bad score",
        body: "Score should use integer percent values.",
        importance: 0.8,
        confidence: "79.6",
        references: [],
        duplicateRefs: [],
        toolEvents: [],
      }),
    );
    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate?.importance).toBe(80);
    expect(parsed.candidate?.confidence).toBe(80);
  });

  test("parses labeled plain-text fallback output", () => {
    const parsed = parseCoverEvidenceResult(
      [
        "STATUS: knowledge_ready",
        "STAGE: final",
        "TYPE: procedure",
        "TITLE: Verify before finalize",
        "BODY: 1. Run typecheck.",
        "2. Run focused tests.",
        "3. Confirm evidence payload.",
        "CONFIDENCE: 82.4",
        "IMPORTANCE: 0.79",
        "TECHNOLOGIES: typescript, vitest",
        "CHANGE_TYPES: test",
        "DOMAINS: distillation, context-compiler",
      ].join("\n"),
    );
    expect(parsed.status).toBe("knowledge_ready");
    expect(parsed.candidate).toMatchObject({
      type: "procedure",
      title: "Verify before finalize",
      confidence: 82,
      importance: 79,
      technologies: ["typescript", "vitest"],
      changeTypes: ["test"],
      domains: ["distillation", "context-compiler"],
    });
    expect(parsed.candidate?.body).toContain("Run focused tests.");
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

  test("returns source-backed knowledge_ready without creating a draft", async () => {
    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.candidate).toMatchObject({
      technologies: ["typescript", "vitest"],
      changeTypes: ["test"],
      domains: ["distillation", "testing"],
    });
    expect(result.result.references[0]).toMatchObject({
      kind: "source",
      evidenceRole: "supports_candidate",
    });
    expect(mocks.saveCoverEvidenceResult).not.toHaveBeenCalled();
  });

  test("uses LLM verification instead of terminal source_support failure when source content is available", async () => {
    mocks.readFileDomain.mockResolvedValue({
      content:
        "This unrelated paragraph describes release notes and dashboard copy but still gives the assessor source text to verify against.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });

    const result = await runCoverEvidence({ id: "find-1" });

    expect(mocks.runDistillationCompletion).toHaveBeenCalledTimes(1);
    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "source_support",
          ok: false,
          metadata: expect.objectContaining({
            reason: "unsupported_by_source",
            mode: "llm_verification",
          }),
        }),
      ]),
    );
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages[0]?.content).toContain("source excerpt で支えられるか");
  });

  test("keeps empty source reads as terminal source_support failures", async () => {
    mocks.readFileDomain.mockResolvedValue({
      content: "",
      totalTokens: 0,
      from: 0,
      toExclusive: 0,
      returnedTokens: 0,
    });

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.stage).toBe("source_support");
    expect(result.result.reason).toBe("unsupported_by_source");
    expect(mocks.runDistillationCompletion).not.toHaveBeenCalled();
  });

  test("preserves register_candidate origin hints through value assessment", async () => {
    const body = skillLikeProcedureBody();
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        targetKind: "knowledge_candidate",
        targetKey: "candidate-1",
        sourceUri: "agent://candidate/candidate-1",
        title: "Preserve register_candidate metadata",
        content: body,
        origin: {
          candidateType: "procedure",
          importance: 91,
          confidence: 77,
          technologies: ["typescript"],
          changeTypes: ["bugfix"],
          domains: ["candidate-registration"],
          repoPath: "/Users/y.noguchi/Code/memoryRouter",
          repoKey: "memoryRouter",
        },
      }),
    );
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          title: "Preserve register_candidate metadata",
          body,
        },
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: null,
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await runCoverEvidence({ id: "find-1" });

    expect(result.result.candidate).toMatchObject({
      type: "procedure",
      importance: 91,
      confidence: 77,
      technologies: ["typescript"],
      changeTypes: ["bugfix"],
      domains: ["candidate-registration"],
      repoPath: "/Users/y.noguchi/Code/memoryRouter",
      repoKey: "memoryRouter",
    });
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(mocks.runDistillationCompletion.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        usageSource: "cover-evidence:value-assessment",
      }),
    );
    expect(request.messages[1]?.content).toContain('"technologies": [');
    expect(request.messages[1]?.content).toContain('"candidate-registration"');
    expect(request.messages[1]?.content).toContain('"/Users/y.noguchi/Code/memoryRouter"');
  });

  test("reclassifies command workflows as procedures when assessment returns rule", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue(
      candidateRow({
        title: "Run focused verify before finalizing",
        content:
          "Run `bun run typecheck`, then run `bun run test:unit`, and verify the returned evidence before finalizing.",
        origin: {
          readRanges: [{ from: 0, toExclusive: 120 }],
          candidateType: "procedure",
        },
      }),
    );
    mocks.readFileDomain.mockResolvedValue({
      content:
        "Run `bun run typecheck`, then run `bun run test:unit`, and verify the returned evidence before finalizing.",
      totalTokens: 120,
      from: 0,
      toExclusive: 120,
      returnedTokens: 120,
    });
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Run focused verify before finalizing",
          body: [
            "Use when: Use this when a code change is ready for final verification.",
            "",
            "Workflow:",
            "1. Run `bun run typecheck`.",
            "2. Run `bun run test:unit`.",
            "3. Inspect the returned evidence before finalizing.",
            "",
            "Verification: Confirm both commands pass and the output no longer contains the original failure.",
            "",
            "Avoid: Do not finalize from memory or from a stale terminal output.",
          ].join("\n"),
          importance: 82,
          confidence: 86,
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
    expect(result.result.candidate?.type).toBe("procedure");
    expect(result.result.candidate?.body).toContain("Workflow:");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          candidate: expect.objectContaining({ type: "procedure" }),
        }),
      }),
    );
    const request = mocks.runDistillationCompletion.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.messages[0]?.content).toContain("SKILL.md");
    expect(request.messages[0]?.content).toContain("System Context");
    expect(request.messages[0]?.content).toContain("description に相当する使用条件");
    expect(request.messages[0]?.content).toContain("YAML frontmatter");
    expect(request.messages[0]?.content).toContain("Use when:");
    expect(request.messages[0]?.content).toContain("Workflow:");
    expect(request.messages[0]?.content).toContain("カンマ区切り文字列");
    expect(request.messages[0]?.content).toContain("domains");
    expect(request.messages[0]?.content).not.toContain('"appliesTo":');
  });

  test("rejects procedure candidates that are not written as reusable steps", async () => {
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Run smoke tests before finalizing coverEvidence",
          body: "Run smoke tests, then inspect the returned source references before finalizing coverEvidence.",
          importance: 80,
          confidence: 85,
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
    expect(result.result.reason).toBe("procedure_repair_failed");
    expect(mocks.saveCoverEvidenceResult).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "find-1",
        result: expect.objectContaining({
          status: "insufficient",
          reason: "procedure_repair_failed",
          candidate: null,
        }),
      }),
    );
  });

  test("demotes repair-failed procedures when the original body is a valid rule", async () => {
    mocks.runDistillationCompletion.mockResolvedValueOnce({
      content: JSON.stringify({
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "procedure",
          title: "Preserve source references during finalization",
          body: "First, coverEvidence must preserve source references, then verify the saved result before finalization.",
          importance: 86,
          confidence: 84,
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
          name: "procedure_repair",
          ok: false,
        }),
        expect.objectContaining({
          name: "procedure_demoted_to_rule",
          ok: true,
        }),
      ]),
    );
  });

});
