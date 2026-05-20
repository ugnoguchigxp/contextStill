import { beforeEach, describe, expect, test, vi } from "vitest";
import { runFinalizeDistille } from "../src/modules/finalizeDistille/domain.js";

const mocks = vi.hoisted(() => ({
  selectCoverEvidenceResultById: vi.fn(),
  coverEvidenceResultFromRow: vi.fn(),
  getFindCandidateResultById: vi.fn(),
  embedOne: vi.fn(),
  upsertKnowledgeFromSource: vi.fn(),
  linkKnowledgeToSourceFragment: vi.fn(),
  findSourceFragmentByReference: vi.fn(),
  selectKnowledgeByFinalizeSourceUri: vi.fn(),
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
}));

vi.mock("../src/modules/finalizeDistille/repository.js", () => ({
  findSourceFragmentByReference: mocks.findSourceFragmentByReference,
  selectKnowledgeByFinalizeSourceUri: mocks.selectKnowledgeByFinalizeSourceUri,
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    finalizeDistilleStarted: "FINALIZE_DISTILLE_STARTED",
    finalizeDistilleCompleted: "FINALIZE_DISTILLE_COMPLETED",
    finalizeDistilleEmbeddingFailed: "FINALIZE_DISTILLE_EMBEDDING_FAILED",
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
  });

  test("stores draft knowledge with cover evidence metadata", async () => {
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
        metadata: expect.objectContaining({
          coverEvidenceResultId: "find-1",
          findCandidateResultId: "find-1",
          targetStateId: "target-1",
          sourceDocumentUri: "/wiki/pages/finalize.md",
          references: expect.any(Array),
        }),
      }),
    );
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

  test("stores draft when embedding fails", async () => {
    mocks.embedOne.mockRejectedValue(new Error("embedding provider crashed"));

    const result = await runFinalizeDistille({ coverEvidenceResultId: "find-1", write: true });

    expect(result.embeddingStatus).toBe("failed");
    expect(result.knowledgeId).toBe("knowledge-1");
    expect(mocks.upsertKnowledgeFromSource).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: undefined }),
    );
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
