import { describe, expect, test } from "vitest";
import {
  prepareFinalizeCandidate,
  restructureProcedureCandidate,
} from "../src/modules/finalizeDistille/anonymization.service.js";
import type { CoverEvidenceCandidate } from "../src/modules/coverEvidence/types.js";

function baseCandidate(overrides: Partial<CoverEvidenceCandidate> = {}): CoverEvidenceCandidate {
  return {
    type: "rule",
    title: "Keep AcmePayments paths private",
    body: "AcmePayments should not store /Users/dev/Code/AcmePayments/src/billing.ts or https://api.internal.example.local/debug in reusable knowledge.",
    importance: 90,
    confidence: 90,
    technologies: ["typescript"],
    changeTypes: ["security"],
    domains: ["knowledge-distillation"],
    repoPath: "/Users/dev/Code/AcmePayments",
    repoKey: "AcmePayments",
    ...overrides,
  };
}

describe("finalize anonymization", () => {
  test("redacts secrets and anonymizes project-local identifiers before storage", () => {
    const prepared = prepareFinalizeCandidate({
      candidate: baseCandidate({
        body: "Use AcmePayments without storing /Users/dev/Code/AcmePayments/.env or api_key=sk-123456789012345678901234.",
      }),
      context: {
        foundCandidateId: "",
        targetKind: "wiki_file",
        targetKey: "/Users/dev/Code/AcmePayments/docs/finalize.md",
        sourceUri: "https://api.internal.example.local/wiki/finalize",
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
      duplicateRefs: [
        {
          knowledgeId: "knowledge-1",
          title: "AcmePayments duplicate",
          reason: "Similar AcmePayments guidance",
        },
      ],
      toolEvents: [],
    });

    expect(prepared.candidate.title).toBe("Keep the project paths private");
    expect(prepared.candidate.body).toContain("the workspace path");
    expect(prepared.candidate.body).toContain("[REMOVED SENSITIVE DATA]");
    expect(prepared.candidate.body).not.toContain("AcmePayments");
    expect(prepared.candidate).not.toHaveProperty("repoPath");
    expect(prepared.candidate).not.toHaveProperty("repoKey");
    expect(prepared.references[0]?.uri).toBe("the source document");
    expect(prepared.references[0]?.locator).toBe("the source locator");
    expect(prepared.references[0]?.note).toBe("the project source");
    expect(prepared.duplicateRefs[0]?.title).toBe("the project duplicate");
    expect(prepared.anonymization.applied).toBe(true);
    expect(prepared.anonymization.replacementKinds).toEqual(
      expect.arrayContaining(["secret", "absolute_path", "project_identifier", "repo_scope"]),
    );
    expect(prepared.anonymization.removedApplicabilityScopes).toEqual(["repoPath", "repoKey"]);
  });

  test("keeps public technical terms while replacing internal endpoints", () => {
    const prepared = prepareFinalizeCandidate({
      candidate: baseCandidate({
        title: "Use PostgreSQL migrations",
        body: "Run Vitest after changing PostgreSQL migrations. Check http://localhost:3000/admin only as a private endpoint.",
        repoPath: undefined,
        repoKey: undefined,
      }),
      context: {
        foundCandidateId: "",
        targetKind: "wiki_file",
        targetKey: "docs/migrations.md",
        sourceUri: "docs/migrations.md",
      },
      references: [],
      duplicateRefs: [],
      toolEvents: [],
    });

    expect(prepared.candidate.body).toContain("Vitest");
    expect(prepared.candidate.body).toContain("PostgreSQL");
    expect(prepared.candidate.body).toContain("the private endpoint");
    expect(prepared.candidate.body).not.toContain("localhost");
  });

  test("restructures only procedure bodies with supported workflow, verification, and avoid text", () => {
    const result = restructureProcedureCandidate(
      baseCandidate({
        type: "procedure",
        title: "Finalize draft knowledge safely",
        body: [
          "- Read the candidate summary.",
          "- Store the draft after source links are checked.",
          "Verification: Check that the stored draft has source links.",
          "Avoid storing raw project paths.",
        ].join("\n"),
      }),
    );

    expect(result?.candidate.body).toContain("Use when:");
    expect(result?.candidate.body).toContain("Workflow:");
    expect(result?.candidate.body).toContain("Verification:");
    expect(result?.candidate.body).toContain("Avoid:");
    expect(result?.event.name).toBe("procedure_restructured_for_finalize");
  });

  test("does not invent missing procedure sections", () => {
    const result = restructureProcedureCandidate(
      baseCandidate({
        type: "procedure",
        title: "Run smoke tests",
        body: "Run smoke tests, then inspect the returned source references.",
      }),
    );

    expect(result).toBeNull();
  });
});
