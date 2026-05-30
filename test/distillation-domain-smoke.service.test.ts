import { describe, expect, test, vi } from "vitest";
import { runDistillationDomainSmoke } from "../src/modules/distillation-domain-smoke.service.js";
import { runFindCandidateSmoke } from "../src/modules/findCandidate/domain.js";
import { runCoverEvidenceSmoke } from "../src/modules/coverEvidence/domain.js";
import { runFinalizeDistilleSmoke } from "../src/modules/finalizeDistille/domain.js";

vi.mock("../src/modules/findCandidate/domain.js", () => ({
  runFindCandidateSmoke: vi.fn(() => ({ status: "ok" })),
}));

vi.mock("../src/modules/coverEvidence/domain.js", () => ({
  runCoverEvidenceSmoke: vi.fn(() => ({ status: "ok" })),
}));

vi.mock("../src/modules/finalizeDistille/domain.js", () => ({
  runFinalizeDistilleSmoke: vi.fn(() => ({ status: "ok" })),
}));

describe("runDistillationDomainSmoke", () => {
  test("calls runFindCandidateSmoke when domain is findCandidate", async () => {
    const res = await runDistillationDomainSmoke({ domain: "findCandidate", input: { key: "val" } });
    expect(res).toEqual({ status: "ok" });
    expect(runFindCandidateSmoke).toHaveBeenCalledWith({ key: "val" });
  });

  test("calls runCoverEvidenceSmoke when domain is coverEvidence", async () => {
    const res = await runDistillationDomainSmoke({ domain: "coverEvidence", input: { key: "val" } });
    expect(res).toEqual({ status: "ok" });
    expect(runCoverEvidenceSmoke).toHaveBeenCalledWith({ key: "val" });
  });

  test("calls runFinalizeDistilleSmoke when domain is anything else", async () => {
    const res = await runDistillationDomainSmoke({ domain: "finalizeDistille" as any, input: null });
    expect(res).toEqual({ status: "ok" });
    expect(runFinalizeDistilleSmoke).toHaveBeenCalledWith({});
  });
});
