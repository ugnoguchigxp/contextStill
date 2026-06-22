import { beforeEach, describe, expect, test, vi } from "vitest";
import { runFinalizeDistille } from "../src/modules/finalizeDistille/domain.js";

const mocks = vi.hoisted(() => ({
  selectCoverEvidenceResultById: vi.fn(),
  coverEvidenceResultFromRow: vi.fn(),
  getFindCandidateResultById: vi.fn(),
  embedOne: vi.fn(),
  upsertKnowledgeFromSource: vi.fn(),
  linkKnowledgeToSourceFragment: vi.fn(),
  linkKnowledgeToOrigin: vi.fn(),
  findSourceFragmentByReference: vi.fn(),
  selectKnowledgeByFinalizeSourceUri: vi.fn(),
  getLandscapeReviewLinkForFinalize: vi.fn(),
  getLandscapeReviewLinkForFinalizeByFoundCandidate: vi.fn(),
  markLandscapeReviewLinkFinalizedForCandidate: vi.fn(),
  markLandscapeReviewLinkFinalizedForFoundCandidate: vi.fn(),
  markLandscapeReviewLinkReviewRequiredForCandidate: vi.fn(),
  markLandscapeReviewLinkReviewRequiredForFoundCandidate: vi.fn(),
  recordAuditLogSafe: vi.fn(),
}));

vi.mock("../src/modules/coverEvidence/repository.js", () => ({
  selectCoverEvidenceResultById: mocks.selectCoverEvidenceResultById,
  coverEvidenceResultFromRow: mocks.coverEvidenceResultFromRow,
}));

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  getFindCandidateResultById: mocks.getFindCandidateResultById,
}));

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: mocks.embedOne,
}));

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  upsertKnowledgeFromSource: mocks.upsertKnowledgeFromSource,
}));

vi.mock("../src/modules/finalizeDistille/source-link.repository.js", () => ({
  linkKnowledgeToSourceFragment: mocks.linkKnowledgeToSourceFragment,
  linkKnowledgeToOrigin: mocks.linkKnowledgeToOrigin,
}));

vi.mock("../src/modules/finalizeDistille/repository.js", () => ({
  findSourceFragmentByReference: mocks.findSourceFragmentByReference,
  selectKnowledgeByFinalizeSourceUri: mocks.selectKnowledgeByFinalizeSourceUri,
}));

vi.mock("../src/modules/landscape/landscape-review-candidate.service.js", () => ({
  getLandscapeReviewLinkForFinalize: mocks.getLandscapeReviewLinkForFinalize,
  getLandscapeReviewLinkForFinalizeByFoundCandidate:
    mocks.getLandscapeReviewLinkForFinalizeByFoundCandidate,
  markLandscapeReviewLinkFinalizedForCandidate: mocks.markLandscapeReviewLinkFinalizedForCandidate,
  markLandscapeReviewLinkFinalizedForFoundCandidate:
    mocks.markLandscapeReviewLinkFinalizedForFoundCandidate,
  markLandscapeReviewLinkReviewRequiredForCandidate:
    mocks.markLandscapeReviewLinkReviewRequiredForCandidate,
  markLandscapeReviewLinkReviewRequiredForFoundCandidate:
    mocks.markLandscapeReviewLinkReviewRequiredForFoundCandidate,
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    finalizeDistilleStarted: "FINALIZE_DISTILLE_STARTED",
    finalizeDistilleCompleted: "FINALIZE_DISTILLE_COMPLETED",
    finalizeDistilleEmbeddingFailed: "FINALIZE_DISTILLE_EMBEDDING_FAILED",
    coverEvidenceProcedureDemotedToRule: "COVER_EVIDENCE_PROCEDURE_DEMOTED_TO_RULE",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

function readyResult() {
  return {
    schemaVersion: 1,
    status: "knowledge_ready",
    stage: "final",
    candidate: {
      type: "rule",
      title: "Keep finalize evidence",
      body: "finalizeDistille must preserve cover evidence references on draft knowledge.",
      importance: 82,
      confidence: 84,
      technologies: ["typescript"],
      changeTypes: ["implementation"],
      domains: ["distillation"],
    },
    references: [
      {
        kind: "source",
        uri: "/wiki/pages/finalize.md",
        locator: "tokens:0-120",
        note: "candidate origin",
        evidenceRole: "supports_candidate",
      },
      {
        kind: "web",
        uri: "https://example.com/docs",
        note: "external docs",
        evidenceRole: "external_verification",
      },
    ],
    duplicateRefs: [],
    toolEvents: [],
    reason: null,
  };
}

describe("runFinalizeDistille", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectCoverEvidenceResultById.mockResolvedValue({ id: "find-1" });
    mocks.coverEvidenceResultFromRow.mockReturnValue(readyResult());
    mocks.getFindCandidateResultById.mockResolvedValue({
      id: "find-1",
      targetStateId: "target-1",
      candidateIndex: 0,
      title: "Keep finalize evidence",
      content: "finalizeDistille must preserve cover evidence references on draft knowledge.",
      origin: { readRanges: [{ from: 0, toExclusive: 120 }] },
      status: "selected",
      createdAt: new Date(),
      updatedAt: new Date(),
      targetKind: "wiki_file",
      targetKey: "finalize.md",
      sourceUri: "/wiki/pages/finalize.md",
    });
    mocks.embedOne.mockResolvedValue([0.1, 0.2, 0.3]);
    mocks.upsertKnowledgeFromSource.mockResolvedValue("knowledge-1");
    mocks.findSourceFragmentByReference.mockResolvedValue(null);
    mocks.selectKnowledgeByFinalizeSourceUri.mockResolvedValue(null);
    mocks.getLandscapeReviewLinkForFinalize.mockResolvedValue(null);
    mocks.getLandscapeReviewLinkForFinalizeByFoundCandidate.mockResolvedValue(null);
    mocks.markLandscapeReviewLinkFinalizedForCandidate.mockResolvedValue(null);
    mocks.markLandscapeReviewLinkFinalizedForFoundCandidate.mockResolvedValue(null);
    mocks.markLandscapeReviewLinkReviewRequiredForCandidate.mockResolvedValue(null);
    mocks.markLandscapeReviewLinkReviewRequiredForFoundCandidate.mockResolvedValue(null);
  });

  test("stores draft knowledge with cover evidence metadata", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        ...readyResult().candidate,
        technologies: ["typescript", "vitest"],
        changeTypes: ["test"],
        domains: ["distillation", "context-compiler"],
      },
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result).toMatchObject({
      knowledgeId: "knowledge-1",
      status: "stored",
      embeddingStatus: "stored",
      sourceReferenceCount: 2,
    });
    expect(mocks.upsertKnowledgeFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUri: "cover-evidence-result://find-1",
        status: "draft",
        title: "Keep finalize evidence",
        appliesTo: {
          technologies: ["typescript", "vitest"],
          changeTypes: ["test"],
          domains: ["distillation", "context-compiler"],
        },
        metadata: expect.objectContaining({
          coverEvidenceResultId: "find-1",
          findCandidateResultId: "find-1",
          targetStateId: "target-1",
          sourceDocumentUri: "the source document",
          references: expect.any(Array),
          finalizeSummary: expect.objectContaining({
            decision: "stored",
          }),
          origin: expect.objectContaining({
            rawOriginStored: false,
            targetKind: "wiki_file",
          }),
        }),
      }),
    );
  });

  test("embeds the finalized Japanese knowledge text", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        ...readyResult().candidate,
        title: "coverEvidence の保存前に根拠を確認する",
        body: "coverEvidence の結果を保存する前に、source reference と evidence status が再利用可能な根拠として残っていることを確認する。",
        technologies: ["typescript"],
        changeTypes: ["verification"],
        domains: ["distillation"],
      },
    });

    await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(mocks.embedOne).toHaveBeenCalledWith(
      [
        "coverEvidence の保存前に根拠を確認する",
        "coverEvidence の結果を保存する前に、source reference と evidence status が再利用可能な根拠として残っていることを確認する。",
      ].join("\n"),
      "passage",
    );
  });

  test("anonymizes project-local identifiers before storing draft knowledge", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        ...readyResult().candidate,
        title: "Keep AcmePayments details private",
        body: "AcmePayments must not store /Users/dev/Code/AcmePayments/src/billing.ts or http://localhost:3000/admin in reusable knowledge.",
        repoPath: "/Users/dev/Code/AcmePayments",
        repoKey: "AcmePayments",
      },
      references: [
        {
          kind: "source",
          uri: "/Users/dev/Code/AcmePayments/docs/finalize.md",
          locator: "AcmePayments:10-20",
          note: "AcmePayments source",
          evidenceRole: "supports_candidate",
        },
      ],
    });
    mocks.getFindCandidateResultById.mockResolvedValue({
      id: "find-1",
      targetStateId: "target-1",
      candidateIndex: 0,
      title: "Keep AcmePayments details private",
      content:
        "AcmePayments must not store /Users/dev/Code/AcmePayments/src/billing.ts or http://localhost:3000/admin in reusable knowledge.",
      origin: { readRanges: [{ from: 0, toExclusive: 120 }] },
      status: "selected",
      createdAt: new Date(),
      updatedAt: new Date(),
      targetKind: "wiki_file",
      targetKey: "/Users/dev/Code/AcmePayments/docs/finalize.md",
      sourceUri: "/Users/dev/Code/AcmePayments/docs/finalize.md",
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("stored");
    expect(mocks.embedOne).toHaveBeenCalledWith(
      expect.not.stringContaining("AcmePayments"),
      "passage",
    );
    expect(mocks.upsertKnowledgeFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Keep the project details private",
        body: expect.stringContaining("the workspace path"),
        appliesTo: {
          technologies: ["typescript"],
          changeTypes: ["implementation"],
          domains: ["distillation"],
        },
        metadata: expect.objectContaining({
          sourceDocumentUri: "the source document",
          references: [
            expect.objectContaining({
              uri: "the source document",
              locator: "the source locator",
              note: "the project source",
            }),
          ],
          anonymization: expect.objectContaining({
            applied: true,
            replacementKinds: expect.arrayContaining([
              "absolute_path",
              "project_identifier",
              "internal_url",
              "repo_scope",
            ]),
          }),
          origin: expect.objectContaining({
            rawOriginStored: false,
            targetKind: "wiki_file",
          }),
        }),
      }),
    );
    expect(JSON.stringify(mocks.recordAuditLogSafe.mock.calls)).not.toContain("AcmePayments");
    expect(JSON.stringify(mocks.recordAuditLogSafe.mock.calls)).not.toContain(
      "/Users/dev/Code/AcmePayments",
    );
  });

  test("stores negative knowledge polarity and intent tags from negative coverage", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        ...readyResult().candidate,
        type: "rule",
        title: "Do not trust stale queue status alone",
        body: "Failure: Stale queue status was treated as current truth.\nVerification: Check recent queue events.",
        technologies: ["typescript"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      },
      toolEvents: [
        {
          name: "negative_coverage",
          ok: true,
          metadata: {
            polarity: "negative",
            intentTags: ["failure_pattern", "guardrail"],
            appliesTo: {
              technologies: ["typescript"],
              changeTypes: ["diagnosis"],
              domains: ["queue"],
            },
          },
        },
      ],
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("stored");
    expect(mocks.upsertKnowledgeFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rule",
        polarity: "negative",
        intentTags: ["failure_pattern", "guardrail"],
        title: "Do not trust stale queue status alone",
        appliesTo: {
          technologies: ["typescript"],
          changeTypes: ["diagnosis"],
          domains: ["queue"],
        },
      }),
    );
    expect(mocks.linkKnowledgeToOrigin).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeId: "knowledge-1",
        originKind: "agent_candidate",
        originUri: "/wiki/pages/finalize.md",
        originKey: "finalize.md",
        confidence: expect.any(Number),
        metadata: expect.objectContaining({
          source: "finalizeDistille",
          coverEvidenceResultId: "find-1",
          targetKind: "wiki_file",
        }),
      }),
    );
  });

  test("backfills negative origin link when finalize reuses existing knowledge", async () => {
    mocks.selectKnowledgeByFinalizeSourceUri.mockResolvedValue({ id: "knowledge-existing" });
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      toolEvents: [
        {
          name: "negative_coverage",
          ok: true,
          metadata: {
            polarity: "negative",
            intentTags: ["failure_pattern"],
          },
        },
      ],
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.knowledgeId).toBe("knowledge-existing");
    expect(mocks.linkKnowledgeToOrigin).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeId: "knowledge-existing",
        originUri: "/wiki/pages/finalize.md",
      }),
    );
    expect(mocks.embedOne).not.toHaveBeenCalled();
  });

  test("rejects non-ready cover evidence without creating knowledge", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      status: "insufficient",
      candidate: null,
      reason: "unsupported_by_source",
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("unsupported_by_source");
    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("rejects low-importance ready cover evidence without creating knowledge", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        ...readyResult().candidate,
        importance: 50,
      },
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("low_importance");
    expect(mocks.getFindCandidateResultById).not.toHaveBeenCalled();
    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("rejects ready cover evidence when applicability facets are missing", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        ...readyResult().candidate,
        technologies: undefined,
        changeTypes: [],
        domains: undefined,
      },
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("applies_to_categories_required");
    expect(mocks.getFindCandidateResultById).not.toHaveBeenCalled();
    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("demotes one-line procedure misclassifications before storing", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        type: "procedure",
        title: "頻出クエリは Prepared Statement を使う",
        body: "繰り返し実行するクエリは `prepare()` で Prepared Statement 化して高速化する。",
        importance: 90,
        confidence: 95,
        technologies: ["postgresql"],
        changeTypes: ["performance"],
        domains: ["database"],
      },
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("stored");
    expect(mocks.upsertKnowledgeFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rule",
        title: "頻出クエリは Prepared Statement を使う",
        metadata: expect.objectContaining({
          toolEvents: expect.arrayContaining([
            expect.objectContaining({
              name: "procedure_demoted_to_rule",
              ok: true,
            }),
          ]),
        }),
      }),
    );
    expect(mocks.recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "COVER_EVIDENCE_PROCEDURE_DEMOTED_TO_RULE",
        payload: expect.objectContaining({
          coverEvidenceResultId: "find-1",
          reason: "rule_like_non_procedure",
        }),
      }),
    );
  });

  test("rejects procedure-like bodies that are not actionable steps", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        type: "procedure",
        title: "Run smoke tests before finalizing coverEvidence",
        body: "Run smoke tests, then inspect the returned source references before finalizing coverEvidence.",
        importance: 82,
        confidence: 84,
        technologies: ["vitest"],
        changeTypes: ["testing"],
        domains: ["distillation"],
      },
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("procedure_body_not_actionable");
    expect(mocks.getFindCandidateResultById).not.toHaveBeenCalled();
    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("restructures supported procedure bodies before storing", async () => {
    mocks.coverEvidenceResultFromRow.mockReturnValue({
      ...readyResult(),
      candidate: {
        type: "procedure",
        title: "Finalize draft knowledge safely",
        body: [
          "- Read the candidate summary.",
          "- Store the draft after source links are checked.",
          "Verification: Check that the stored draft has source links.",
          "Avoid storing raw project paths.",
        ].join("\n"),
        importance: 90,
        confidence: 88,
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["distillation"],
      },
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("stored");
    expect(mocks.upsertKnowledgeFromSource).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "procedure",
        body: expect.stringContaining("Use when:"),
        metadata: expect.objectContaining({
          toolEvents: expect.arrayContaining([
            expect.objectContaining({
              name: "procedure_restructured_for_finalize",
              ok: true,
            }),
          ]),
        }),
      }),
    );
  });

  test("does not store draft when embedding fails", async () => {
    mocks.embedOne.mockRejectedValue(new Error("embedding provider crashed"));

    await expect(
      runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true }),
    ).rejects.toThrow("finalizeDistille requires knowledge embedding before storage");

    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("rejects landscape candidate until manual approval is granted", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue({
      id: "find-1",
      targetStateId: "target-landscape-1",
      candidateIndex: 0,
      title: "Landscape candidate",
      content: "candidate body",
      origin: { source: "landscape_review_item", reviewItemId: "review-item-1" },
      status: "selected",
      createdAt: new Date(),
      updatedAt: new Date(),
      targetKind: "knowledge_candidate",
      targetKey: "landscape-review-item:review-item-1:baseline_wrong:hash",
      sourceUri: "landscape://review-item/review-item-1/candidate/hash",
    });
    mocks.getLandscapeReviewLinkForFinalize.mockResolvedValue({
      status: "draft_created",
      linkId: "link-1",
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("landscape_manual_approval_required");
    expect(mocks.markLandscapeReviewLinkReviewRequiredForCandidate).toHaveBeenCalledWith("find-1");
    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
  });

  test("finalizes landscape candidate after approval", async () => {
    mocks.getFindCandidateResultById.mockResolvedValue({
      id: "find-1",
      targetStateId: "target-landscape-1",
      candidateIndex: 0,
      title: "Landscape candidate",
      content: "candidate body",
      origin: { source: "landscape_review_item", reviewItemId: "review-item-1" },
      status: "selected",
      createdAt: new Date(),
      updatedAt: new Date(),
      targetKind: "knowledge_candidate",
      targetKey: "landscape-review-item:review-item-1:baseline_wrong:hash",
      sourceUri: "landscape://review-item/review-item-1/candidate/hash",
    });
    mocks.getLandscapeReviewLinkForFinalize.mockResolvedValue({
      status: "approved",
      linkId: "link-1",
    });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.status).toBe("stored");
    expect(result.knowledgeId).toBe("knowledge-1");
    expect(mocks.markLandscapeReviewLinkFinalizedForCandidate).toHaveBeenCalledWith("find-1");
  });

  test("links only resolvable source fragments", async () => {
    mocks.findSourceFragmentByReference.mockResolvedValue({ sourceFragmentId: "fragment-1" });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.sourceLinkCount).toBe(1);
    expect(mocks.linkKnowledgeToSourceFragment).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeId: "knowledge-1",
        sourceFragmentId: "fragment-1",
        confidence: 0.84,
        metadata: expect.objectContaining({
          reference: expect.objectContaining({
            uri: "the source document",
            locator: "the source locator",
          }),
        }),
      }),
    );
  });

  test("returns existing knowledge without re-embedding or upserting", async () => {
    mocks.selectKnowledgeByFinalizeSourceUri.mockResolvedValue({ id: "knowledge-existing" });
    mocks.findSourceFragmentByReference.mockResolvedValue({ sourceFragmentId: "fragment-1" });

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result).toMatchObject({
      knowledgeId: "knowledge-existing",
      status: "stored",
      embeddingStatus: "stored",
      sourceLinkCount: 1,
    });
    expect(mocks.embedOne).not.toHaveBeenCalled();
    expect(mocks.upsertKnowledgeFromSource).not.toHaveBeenCalled();
    expect(mocks.linkKnowledgeToSourceFragment).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeId: "knowledge-existing",
        sourceFragmentId: "fragment-1",
      }),
    );
  });
});
