export type DistillationDomainName = "findCandidate" | "coverEvidence" | "finalizeDistille";

export type DistillationDomainSmokeResult = {
  domain: DistillationDomainName;
  implemented: boolean;
  status: "prepared" | "ok" | "failed";
  checkedAt: string;
  message: string;
  receivedInput: Record<string, unknown>;
  nextContracts: string[];
};
