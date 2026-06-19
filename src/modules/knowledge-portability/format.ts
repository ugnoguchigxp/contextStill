export const PORTABLE_EXPORT_FORMAT = "context-still-portable-export" as const;
export const PORTABLE_EXPORT_SCHEMA_VERSION = 1;
export const PORTABLE_EXPORT_SUBSET_VERSION = 1;
export const PORTABLE_EXPORT_SECRET_PLACEHOLDER = "[REMOVED SENSITIVE DATA]";

export type PortableExportDialect = "postgres" | "sqlite";

export type PortableExportCounts = {
  knowledgeItems: number;
  knowledgeTagDefinitions: number;
  knowledgeCommunityLabels: number;
  knowledgeQualityAdjustments: number;
  knowledgeOriginLinks: number;
  sources: number;
  sourceFragments: number;
  knowledgeSourceLinks: number;
  historicalWorkflowEvidenceRecords: number;
  contextDecisionEvidence: number;
  contextDecisionCoverageTraces: number;
  contextCompileEvals: number;
  knowledgeUsageEvents: number;
  contextDecisionHumanFeedback: number;
  contextDecisionFeedback: number;
};

export type PortableExportManifest = {
  format: typeof PORTABLE_EXPORT_FORMAT;
  schemaVersion: typeof PORTABLE_EXPORT_SCHEMA_VERSION;
  createdAt: string;
  createdBy: {
    packageName: string;
    packageVersion: string;
  };
  source: {
    databaseProvider: "postgres";
    embeddingDimension: number;
  };
  sql: {
    canonicalDialect: "postgres";
    availableDialects: PortableExportDialect[];
    portableSubsetVersion: typeof PORTABLE_EXPORT_SUBSET_VERSION;
  };
  counts: PortableExportCounts;
  redaction: {
    enabled: true;
    secretPlaceholder: typeof PORTABLE_EXPORT_SECRET_PLACEHOLDER;
    localPathPolicy: "preserve";
  };
};

export type EvidenceIndexEntry = {
  sourceRefs: Array<{
    knowledgeSourceLinkId: string;
    sourceId: string;
    sourceFragmentId: string;
    sourceUri: string;
    locator: string;
    linkType: string;
    confidence: number;
  }>;
  originRefs: Array<{
    originLinkId: string;
    originKind: string;
    originUri: string;
    originKey: string;
    confidence: number;
  }>;
};

export type PortableEvidenceIndex = {
  format: "context-still-portable-evidence-index";
  schemaVersion: 1;
  knowledge: Record<string, EvidenceIndexEntry>;
  skippedEvidence: Array<{
    kind: string;
    reason: string;
    count: number;
  }>;
};

export type PortableExportSummary = {
  outDir: string;
  manifestPath: string;
  sqlPath: string;
  evidenceIndexPath: string;
  checksumsPath: string;
  manifest: PortableExportManifest;
};
