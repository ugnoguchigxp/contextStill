import type { DistillationProviderSetting } from "../distillation/distillation-runtime.service.js";

export const coverEvidenceStatuses = [
  "knowledge_ready",
  "duplicate",
  "near_duplicate",
  "insufficient",
  "parse_failed",
  "tool_failed",
  "provider_failed",
] as const;

export const coverEvidenceStages = [
  "load",
  "source_support",
  "dedupe",
  "evidence_need",
  "web",
  "mcp",
  "final",
] as const;

export type CoverEvidenceStatus = (typeof coverEvidenceStatuses)[number];
export type CoverEvidenceStage = (typeof coverEvidenceStages)[number];

export type CoverEvidenceCandidate = {
  type: "rule" | "procedure";
  title: string;
  body: string;
  importance: number;
  confidence: number;
  applicabilityGeneral?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  repoPath?: string;
  repoKey?: string;
};

export type CoverEvidenceReference = {
  kind: "source" | "web" | "context7" | "deepwiki" | "knowledge";
  uri: string;
  locator?: string;
  title?: string;
  note: string;
  evidenceRole: "supports_candidate" | "dedupe_match" | "external_verification";
};

export type CoverEvidenceDuplicateRef = {
  knowledgeId: string;
  title: string;
  score?: number;
  reason: string;
};

export type CoverEvidenceToolEvent = {
  name: string;
  ok: boolean;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type CoverEvidenceResult = {
  schemaVersion: 1;
  status: CoverEvidenceStatus;
  stage: CoverEvidenceStage;
  candidate: CoverEvidenceCandidate | null;
  references: CoverEvidenceReference[];
  duplicateRefs: CoverEvidenceDuplicateRef[];
  toolEvents: CoverEvidenceToolEvent[];
  reason: string | null;
};

export type CoverEvidenceInput = {
  id: string;
  provider?: DistillationProviderSetting;
  write?: boolean;
  forceRefreshEvidence?: boolean;
  signal?: AbortSignal;
};

export function isCoverEvidenceStatus(value: unknown): value is CoverEvidenceStatus {
  return typeof value === "string" && coverEvidenceStatuses.includes(value as CoverEvidenceStatus);
}

export function isCoverEvidenceStage(value: unknown): value is CoverEvidenceStage {
  return typeof value === "string" && coverEvidenceStages.includes(value as CoverEvidenceStage);
}
