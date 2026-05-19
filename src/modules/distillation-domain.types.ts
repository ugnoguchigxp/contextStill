export type DistillationDomainName = "findCandidate" | "coverEvidence" | "finalizeDistille";

export type DistillationDomainSmokeResult = {
  domain: DistillationDomainName;
  implemented: false;
  status: "prepared";
  checkedAt: string;
  message: string;
  receivedInput: Record<string, unknown>;
  nextContracts: string[];
};
