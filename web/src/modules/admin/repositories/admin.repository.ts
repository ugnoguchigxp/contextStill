export type KnowledgeType = "rule" | "procedure";

export type KnowledgeItem = {
  id: string;
  type: KnowledgeType | string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sourceRefs?: string[];
  sourceVibeMemoryIds?: string[];
  compileSelectCount: number;
  lastCompiledAt: string | null;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  decayFactor: number;
  lastVerifiedAt: string | null;
  updatedAt: string;
};

export type KnowledgeListResponse = {
  items: KnowledgeItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type KnowledgeListRequest = {
  limit?: number;
  page?: number;
  status?: string;
  query?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

export type KnowledgeFeedback = {
  id: string;
  direction: "up" | "down";
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  lastVerifiedAt: string | null;
};

export type KnowledgeBulkStatusResponse = {
  targetStatus: "active" | "deprecated";
  requestedIds: string[];
  updatedIds: string[];
  unchangedIds: string[];
  notFoundIds: string[];
  invalidTransitionIds: Array<{ id: string; fromStatus: string }>;
  outcome: "ok" | "partial" | "none";
};

export type KnowledgeBulkStatusSelection = {
  status?: string;
  type?: string;
  query?: string;
};

export type KnowledgeBulkStatusRequest =
  | {
      ids: string[];
      status: "active" | "deprecated";
    }
  | {
      selection: KnowledgeBulkStatusSelection;
      status: "active" | "deprecated";
    };

export type VibeMemory = {
  id: string;
  sessionId: string;
  content: string;
  memoryType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type AgentDiffEntry = {
  id: string;
  vibeMemoryId: string;
  filePath: string;
  diffHunk: string;
  changeType: string | null;
  language: string | null;
  symbolName: string | null;
  symbolKind: string | null;
  signature: string | null;
  startLine: number | null;
  endLine: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeWriteInput = {
  type: KnowledgeType;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown> & {
    general?: boolean;
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
    repoPath?: string;
    repoKey?: string;
  };
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  metadata?: Record<string, unknown>;
};

export type KnowledgeUpdateInput = Partial<KnowledgeWriteInput>;

export type KnowledgeTagDefinition = {
  id: string;
  kind: "technology" | "change_type" | "retrieval_mode" | "domain";
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  status: "active" | "draft" | "deprecated";
  sortOrder: number;
};

export type SkippedRunReason = {
  reason: string;
  count: number;
};

export type DoctorReasonSeverity = "critical" | "warning" | "info";
export type DoctorReasonArea = "Knowledge" | "Distillation" | "Sync" | "Runtime" | "MCP" | "Other";
export type DoctorReasonImpactLevel = "blocking" | "degraded" | "maintenance" | "skipped";
export type DoctorReasonEnvironmentScope =
  | "all"
  | "configured_only"
  | "non_empty_db"
  | "strict_only";
export type DoctorReasonDetail = {
  code: string;
  label: string;
  severity: DoctorReasonSeverity;
  area: DoctorReasonArea;
  description: string;
  impact: string;
  action: string;
  impactLevel?: DoctorReasonImpactLevel;
  environmentScope?: DoctorReasonEnvironmentScope;
  commands?: {
    inspect: string | null;
    repairDryRun: string | null;
    repairApply: string | null;
  };
  evidence?: Record<string, unknown> | null;
};

export type DoctorReport = {
  status: "ok" | "degraded" | "failed";
  checkedAt: string;
  summary: {
    blocking: number;
    degraded: number;
    maintenance: number;
    skipped: number;
  };
  reasons: string[];
  reasonDetails?: DoctorReasonDetail[];
  skippedChecks?: DoctorReasonDetail[];
  db: { reachable: boolean; durationMs: number; error?: string };
  vector: { installed: boolean };
  embedding?: {
    configured: boolean;
    provider: string;
    daemon: { url: string; reachable: boolean; error?: string };
    cli: { python: string; root: string; modelDir: string; usable: boolean; error?: string };
  };
  agenticLlm?: {
    providerSetting: string;
    selectedProvider?: string;
    fallbackOrder: string[];
    provider: string;
    configured: boolean;
    reachable: boolean;
    model: string;
    endpoint: string;
    error?: string;
  };
  runs: {
    windowSize?: number;
    totalRuns: number;
    degradedRuns: number;
    degradedRate: number;
    blockingRuns?: number;
    blockingRate?: number;
    usableRuns?: number;
    usableRate?: number;
    warningOnlyRuns?: number;
    warningOnlyRate?: number;
    noContentRuns?: number;
    noContentRate?: number;
    durationMsP50: number | null;
    durationMsP95: number | null;
    durationMsAvg: number | null;
    durationSamples?: Array<{
      runId: string;
      label: string;
      durationMs: number;
      status: "ok" | "degraded" | "failed";
      createdAt: string;
    }>;
    lastRunAt: string | null;
    lastRunAgeMinutes?: number | null;
    freshnessThresholdMinutes?: number;
    degradedRateThreshold?: number;
  };
  tables?: {
    expected: string[];
    existing: string[];
    missing: string[];
  };
  hitl: {
    draftCount: number;
    oldestDraftAt: string | null;
    oldestDraftAgeMinutes: number | null;
    backlogThresholdCount: number;
    backlogThresholdAgeMinutes: number;
  };
  knowledgeLifecycle: {
    activeCount: number;
    zeroUseActiveCount: number;
    staleByDecayCount: number;
    staleProcedureCount: number;
    dynamicScoreAvg: number | null;
    dynamicScoreP95: number | null;
    lastCompiledAt: string | null;
    lastCompiledAgeMinutes: number | null;
    thresholds: {
      staleDecayFactor: number;
      zeroUseWarningMinActiveCount: number;
    };
  };
  mcp: {
    exposedTools: string[];
    requiredPrimaryTools: string[];
    missingPrimaryTools: string[];
    staleKnowledgeCount: number;
    staleSourceCount: number;
    nextActions: string[];
  };
  agentLogSync: {
    codex: {
      sessionDir: string;
      sessionDirExists: boolean;
      archivedSessionDir: string;
      archivedSessionDirExists: boolean;
    };
    antigravity: {
      logDir: string;
      configured: boolean;
      exists: boolean;
    };
    states: Array<{
      id: string;
      lastSyncedAt: string | null;
      lastSyncedAgeMinutes: number | null;
      cursorFiles: number;
      skipped: boolean;
      warnings: string[];
    }>;
    launchAgent: {
      label: string;
      plistPath: string;
      installed: boolean;
      loaded: boolean;
      state: string | null;
    };
    nextActions: string[];
  };
  vibeDistillation: {
    launchAgent: {
      label: string;
      plistPath: string;
      installed: boolean;
      loaded: boolean;
      state: string | null;
    };
    runs: {
      totalRuns: number;
      okRuns: number;
      skippedRuns: number;
      outcomeKindCounts: SkippedRunReason[];
      skippedRunReasons: SkippedRunReason[];
      failedRuns: number;
      lastRunAt: string | null;
      lastRunAgeMinutes: number | null;
      lastOkRunAt?: string | null;
      lastOkRunAgeMinutes?: number | null;
    };
    jobs: {
      queued: number;
      running: number;
      paused: number;
      failed: number;
      lastPausedAt: string | null;
      lastError: string | null;
    };
    queueHealth: {
      queued: number;
      running: number;
      retryablePaused: number;
      staleRunning: number;
      blockedByHigherPriority: boolean;
      blockers?: {
        pendingKnowledgeCandidates: number;
        runningKnowledgeCandidates: number;
        staleRunningKnowledgeCandidates: number;
        retryableKnowledgeCandidates: number;
        manualPausedKnowledgeCandidates: number;
        pendingWiki: number;
        runningWiki: number;
        staleRunningWiki: number;
        retryableWiki: number;
        manualPausedWiki: number;
      };
      oldestQueuedAt: string | null;
      oldestQueuedAgeMinutes: number | null;
      oldestRunningAt: string | null;
      oldestRunningAgeMinutes: number | null;
      lock: {
        path: string;
        exists: boolean;
        pid: number | null;
        createdAt: string | null;
        ageSeconds: number | null;
        staleByCreatedAge: boolean;
      };
    };
    nextActions: string[];
  };
  sourceDistillation: {
    launchAgent: {
      label: string;
      plistPath: string;
      installed: boolean;
      loaded: boolean;
      state: string | null;
    };
    runs: {
      totalRuns: number;
      okRuns: number;
      skippedRuns: number;
      outcomeKindCounts: SkippedRunReason[];
      skippedRunReasons: SkippedRunReason[];
      failedRuns: number;
      lastRunAt: string | null;
      lastRunAgeMinutes: number | null;
      lastOkRunAt?: string | null;
      lastOkRunAgeMinutes?: number | null;
    };
    jobs: {
      queued: number;
      running: number;
      paused: number;
      failed: number;
      lastPausedAt: string | null;
      lastError: string | null;
    };
    queueHealth: {
      queued: number;
      running: number;
      retryablePaused: number;
      staleRunning: number;
      blockedByHigherPriority: boolean;
      blockers?: {
        pendingKnowledgeCandidates: number;
        runningKnowledgeCandidates: number;
        staleRunningKnowledgeCandidates: number;
        retryableKnowledgeCandidates: number;
        manualPausedKnowledgeCandidates: number;
        pendingWiki: number;
        runningWiki: number;
        staleRunningWiki: number;
        retryableWiki: number;
        manualPausedWiki: number;
      };
      oldestQueuedAt: string | null;
      oldestQueuedAgeMinutes: number | null;
      oldestRunningAt: string | null;
      oldestRunningAgeMinutes: number | null;
      lock: {
        path: string;
        exists: boolean;
        pid: number | null;
        createdAt: string | null;
        ageSeconds: number | null;
        staleByCreatedAge: boolean;
      };
    };
    nextActions: string[];
  };
};

export type OverviewDashboard = {
  checkedAt: string;
  kpis: {
    knowledgeTotal: number;
    activeKnowledge: number;
    draftKnowledge: number;
    deprecatedKnowledge: number;
    rules: number;
    procedures: number;
    embeddedKnowledge: number;
    zeroUseActiveKnowledge: number;
    wikiPages: number;
    indexedSources: number;
    sourceFragments: number;
    sourceLinks: number;
    linkedKnowledge: number;
    unlinkedKnowledge: number;
    sourceCommunities: number;
    sourceCoveredCommunities: number;
    sourceThinCommunities: number;
    sourceMissingCommunities: number;
    vibeRecords: number;
    vibeSessions: number;
    vibeRecordsWithDiffs: number;
    agentDiffEntries: number;
    compileRuns: number;
    compileOkRuns: number;
    compileDegradedRuns: number;
    compileFailedRuns: number;
    graphNodes?: number;
    graphEdges?: number;
    graphEmbedded?: number;
    graphSessionEdges?: number;
    graphProjectEdges?: number;
    graphSourceEdges?: number;
  };
  charts: {
    knowledgeByStatusType: Array<{
      status: "active" | "draft" | "deprecated";
      rule: number;
      procedure: number;
    }>;
    dynamicScoreBuckets: Array<{
      bucket:
        | "0"
        | "0-1"
        | "1-5"
        | "5-10"
        | "10-15"
        | "15-20"
        | "20-25"
        | "25-30"
        | "30-35"
        | "35+";
      count: number;
    }>;
    compileRunsByDay: Array<{
      day: string;
      ok: number;
      degraded: number;
      failed: number;
      avgDurationMs: number | null;
    }>;
    vibeRecordsByDay: Array<{
      day: string;
      records: number;
    }>;
    sourceCoverage: Array<{
      label: "linked" | "unlinked";
      count: number;
    }>;
    communitySourceCoverage: Array<{
      label: "covered" | "thin" | "no-source";
      count: number;
    }>;
    distillationQueue: Array<{
      targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate";
      pending: number;
      running: number;
      paused: number;
      completed: number;
      failed: number;
    }>;
  };
  llmUsage: {
    kpis: {
      totalCalls30d: number;
      measuredCalls30d: number;
      estimatedCalls30d: number;
      localTokensTotal30d: number;
      localPromptTokens30d: number;
      localCompletionTokens30d: number;
      cloudTokensTotal30d: number;
      cloudPromptTokens30d: number;
      cloudCompletionTokens30d: number;
      measuredTokensTotal30d: number;
      estimatedTokensTotal30d: number;
      measuredCoveragePercent30d: number;
      reasoningTokensTotal30d: number;
      cloudCostJpyTotal30d: number;
      cloudModel: string;
      cloudInputCostJpyPerMTokens: number;
      cloudOutputCostJpyPerMTokens: number;
    };
    daily: Array<{
      day: string;
      localPromptTokens: number;
      localCompletionTokens: number;
      localReasoningTokens: number;
      cloudPromptTokens: number;
      cloudCompletionTokens: number;
      cloudReasoningTokens: number;
      totalTokens: number;
      measuredTokens: number;
      estimatedTokens: number;
      measuredCalls: number;
      estimatedCalls: number;
      costJpy: number;
    }>;
    bySource: Array<{
      source: string;
      calls: number;
      measuredCalls: number;
      estimatedCalls: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }>;
  };
  searchApiStatus: {
    brave: {
      status: "ok" | "cooldown";
      cooldownUntil: string | null;
      lastError: string | null;
    };
    exa: {
      status: "ok" | "cooldown";
      cooldownUntil: string | null;
      lastError: string | null;
    };
  };
};

export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge" | "source";
  group: string;
  weight: number;
  status: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
  communityKey?: string;
  communityLabel?: string;
  sourceId?: string;
  sourceKind?: string;
  sourceUri?: string;
  sourceTitle?: string | null;
  linkedKnowledgeCount?: number;
};

export type GraphNodeDetail = {
  id: string;
  label: string;
  kind: "knowledge";
  group: string;
  detail: string;
  weight: number;
  status: string;
  confidence: number;
  importance: number;
  bodyPreview: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  edgeKind: "semantic" | "session" | "project" | "source" | "evidence";
  relationAxis: "semantic" | "session" | "project" | "source" | "evidence";
  derived: boolean;
  weight: number;
};

export type GraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

export type GraphViewMode = "relation" | "semantic" | "community" | "evidence";
export type GraphRelationAxis = "session" | "project" | "source";
export type GraphCommunityDisplayMode = "detail" | "supernode";

export type GraphCommunityHealth = {
  dead: boolean;
  stale: boolean;
  thinEvidence: boolean;
};

export type GraphCommunitySummary = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  typeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  embeddedCount: number;
  compileSelectCount: number;
  staleNodeCount: number;
  sourceRefCount: number;
  sourceRefDensity: number;
  health: GraphCommunityHealth;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSupernode = {
  id: string;
  label: string;
  communityKey: string;
  size: number;
  communityRank: number;
  health: GraphCommunityHealth;
};

export type GraphSuperedge = {
  id: string;
  source: string;
  target: string;
  weight: number;
};

export type GraphCommunityLabel = {
  communityKey: string;
  communityId: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunitySummary[];
  supernodes: GraphSupernode[];
  superedges: GraphSuperedge[];
  stats: {
    visibleKnowledgeCount: number;
    totalKnowledgeCount: number;
    embeddedKnowledgeCount: number;
    semanticEdgeCount: number;
    sessionEdgeCount: number;
    projectEdgeCount: number;
    sourceEdgeCount: number;
    sourceNodeCount: number;
    evidenceEdgeCount: number;
    evidenceLinkedKnowledgeCount: number;
    evidenceUnlinkedKnowledgeCount: number;
    truncatedSourceNodeCount: number;
    relationEdgeCount: number;
    sourceRefCount: number;
    communityCount: number;
    largestCommunitySize: number;
    orphanNodeCount: number;
    deadCommunityCount: number;
    staleCommunityCount: number;
    thinEvidenceCommunityCount: number;
  };
};

export type SourceTreeItem = {
  slug: string;
  title: string;
  path: string;
  updatedAt: string;
};

export type SourceFolderItem = {
  path: string;
};

export type SourceTreeResponse = {
  items: SourceTreeItem[];
  folders: SourceFolderItem[];
};

export type SourcePageDocument = {
  slug: string;
  title: string;
  body: string;
  path: string;
  meta: Record<string, unknown>;
};

export type SourceMutationResponse = {
  ok: true;
  slug?: string;
  path?: string;
  from?: string;
  commit: string | null;
  hash?: string;
  movedPages?: Array<{ from: string; to: string }>;
  deletedSlugs?: string[];
};

export type SourceHistoryItem = {
  commit: string;
  author: string;
  date: string;
  message: string;
};

export type SourceHealth = {
  app: string;
  version: string;
  git: {
    branch: string;
    commit: string;
  } | null;
};

export type SourceSearchItem = {
  slug: string;
  excerpt: string;
};

export type AuditLogActor = "agent" | "user" | "system";

export type AuditLogItem = {
  id: string;
  eventType: string;
  actor: AuditLogActor | string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditLogsPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};

export type AuditLogsResponse = {
  items: AuditLogItem[];
  availableEventTypes: string[];
  pagination: AuditLogsPagination;
};

export type SourceReindexResponse = {
  ok: true;
  indexed: number;
  removed: number;
};

export type CandidateOutcome =
  | "stored"
  | "ready_not_finalized"
  | "rejected"
  | "retryable"
  | "candidate_only"
  | "target_pending";

export type CandidateListSortBy =
  | "targetKey"
  | "candidateTitle"
  | "coverageStatus"
  | "knowledgeStatus"
  | "outcome"
  | "qualityScore"
  | "latestUpdatedAt";

export type CandidateListSortDir = "asc" | "desc";

export type CandidateDiffSummary = {
  titleChanged: boolean;
  bodyChanged: boolean;
  typeChanged: boolean;
  importanceDelta: number | null;
  confidenceDelta: number | null;
  bodySimilarity: number;
  summary: string[];
};

export type CandidateListItem = {
  id: string;
  targetStateId: string;
  candidateIndex: number;
  targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate";
  targetKey: string;
  sourceUri: string;
  finalizeSourceUri: string;
  targetStatus: string;
  targetPhase: string;
  targetOutcomeKind: string | null;
  targetLastError: string | null;
  latestUpdatedAt: string;
  original: {
    title: string;
    body: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  cover: null | {
    status: string;
    stage: string;
    type: "rule" | "procedure" | null;
    title: string | null;
    body: string | null;
    importance: number | null;
    confidence: number | null;
    reason: string | null;
    referencesCount: number;
    duplicateRefsCount: number;
    toolEventsCount: number;
    updatedAt: string;
  };
  knowledge: null | {
    id: string;
    type: string;
    status: string;
    scope: string;
    title: string;
    body: string;
    importance: number | null;
    confidence: number | null;
    updatedAt: string;
  };
  outcome: CandidateOutcome;
  diff: {
    originalToCover: CandidateDiffSummary | null;
    coverToKnowledge: CandidateDiffSummary | null;
    originalToKnowledge: CandidateDiffSummary | null;
  };
};

export type CandidateListStats = {
  total: number;
  stored: number;
  readyNotFinalized: number;
  rejected: number;
  retryable: number;
  targetPending: number;
  candidateOnly: number;
};

export type CandidateListResponse = {
  items: CandidateListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  stats: CandidateListStats;
};

export type CandidateListRequest = {
  page?: number;
  limit?: number;
  query?: string;
  targetKind?: "all" | "wiki_file" | "vibe_memory" | "knowledge_candidate";
  outcome?: "all" | CandidateOutcome;
  hasKnowledge?: "all" | "yes" | "no";
  targetStateId?: string;
  sortBy?: CandidateListSortBy;
  sortDir?: CandidateListSortDir;
};

export type RuntimeProviderName = "openai" | "azure-openai" | "bedrock" | "local-llm";
export type RuntimeProviderSetting = RuntimeProviderName | "auto";
export type RuntimeSearchProvider = "brave" | "exa" | "duckduckgo";
export type RuntimeSecretKey =
  | "openaiApiKey"
  | "azureOpenAiApiKey"
  | "localLlmApiKey"
  | "braveApiKey"
  | "exaApiKey";
export type RuntimeSecretSource = "db" | "env" | "none" | "env-or-profile";

export type RuntimeSecretStatus = {
  configured: boolean;
  source: RuntimeSecretSource;
  maskedValue: string | null;
  updatedAt: string | null;
};

export type RuntimeSettingsRoute = {
  provider: RuntimeProviderSetting;
  model?: string;
  fallback: RuntimeProviderName[];
};

export type RuntimeSettingsEditable = {
  providers: {
    openai: {
      enabled: boolean;
      apiBaseUrl: string;
      model: string;
    };
    "azure-openai": {
      enabled: boolean;
      apiBaseUrl: string;
      apiPath: string;
      apiVersion: string;
      model: string;
    };
    bedrock: {
      enabled: boolean;
      region: string;
      profile: string;
      model: string;
    };
    "local-llm": {
      enabled: boolean;
      apiBaseUrl: string;
      model: string;
    };
  };
  taskRouting: {
    findCandidate: {
      source: RuntimeSettingsRoute;
      vibe: RuntimeSettingsRoute;
    };
    coverEvidence: {
      sourceSupport: RuntimeSettingsRoute;
      externalEvidence: RuntimeSettingsRoute;
      mcpEvidence: RuntimeSettingsRoute;
    };
    finalizeDistille: RuntimeSettingsRoute;
    agenticCompile: {
      enabled: boolean;
      provider: RuntimeProviderName;
      model: string;
      fallback: RuntimeProviderName[];
      timeoutMs: number;
      maxTokens: number;
    };
  };
  search: {
    providerOrder: RuntimeSearchProvider[];
    maxProviderAttempts: number;
    resultCount: number;
    timeoutMs: number;
    rateLimitCooldownSeconds: number;
    providers: {
      brave: { enabled: boolean };
      exa: { enabled: boolean };
      duckduckgo: { enabled: boolean };
    };
  };
  embedding: {
    provider: "auto" | "daemon" | "cli" | "openai" | "disabled";
    daemonUrl: string;
    openaiModel: string;
    timeoutMs: number;
  };
  distillationRuntime: {
    timeoutMs: number;
    candidateTimeoutMs: number;
    maxToolRounds: number;
    toolTimeoutMs: number;
    toolResultMaxChars: number;
    failureRetryDelaySeconds: number;
    readerMaxReads: number;
    readerMaxCharsPerRead: number;
    lowImportanceRejectThreshold: number;
  };
  advanced: {
    pipelineLockStaleSeconds: number;
    lockTtlSeconds: number;
    continuousIdleSleepMs: number;
    continuousErrorSleepMs: number;
    inventoryRefreshIntervalMs: number;
    doctorFreshnessThresholdMinutes: number;
    doctorDegradedRateThreshold: number;
    doctorKnowledgeZeroUseWarningMinActiveCount: number;
    codexLogSyncEnabled: boolean;
    antigravityLogSyncEnabled: boolean;
    claudeLogSyncEnabled: boolean;
  };
};

export type RuntimeSettingsView = RuntimeSettingsEditable & {
  providers: RuntimeSettingsEditable["providers"] & {
    openai: RuntimeSettingsEditable["providers"]["openai"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
    "azure-openai": RuntimeSettingsEditable["providers"]["azure-openai"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
    bedrock: RuntimeSettingsEditable["providers"]["bedrock"] & {
      credentialSecret: RuntimeSecretStatus;
    };
    "local-llm": RuntimeSettingsEditable["providers"]["local-llm"] & {
      apiKeySecret: RuntimeSecretStatus;
    };
  };
  search: RuntimeSettingsEditable["search"] & {
    providers: RuntimeSettingsEditable["search"]["providers"] & {
      brave: RuntimeSettingsEditable["search"]["providers"]["brave"] & {
        apiKeySecret: RuntimeSecretStatus;
      };
      exa: RuntimeSettingsEditable["search"]["providers"]["exa"] & {
        apiKeySecret: RuntimeSecretStatus;
      };
    };
  };
};

export type RuntimeSettingsSnapshotResponse = {
  settings: RuntimeSettingsView;
  effective: RuntimeSettingsView;
  sources: Record<string, string>;
  revision: number;
  loadedAt: string | null;
};

export type RuntimeSettingsUpdateRequest = {
  settings: RuntimeSettingsEditable;
  secrets?: Partial<Record<RuntimeSecretKey, { value?: string; clear?: boolean }>>;
  updatedBy?: string;
};

export type RuntimeSettingsUpdateResponse = RuntimeSettingsSnapshotResponse & {
  updatedAt: string;
  cacheInvalidated: boolean;
  reloadRequired: boolean;
};

export type RuntimeProviderHealth = {
  provider: RuntimeProviderName;
  configured: boolean;
  reachable: boolean;
  model: string;
  endpoint: string;
  error?: string;
};

export type RuntimeProviderHealthResponse = {
  provider: RuntimeProviderName;
  health: RuntimeProviderHealth;
};

export type RuntimeSettingsReloadResponse = {
  ok: true;
  reloadedAt: string;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response
      .json()
      .then((payload) =>
        typeof payload === "object" && payload && "outcome" in payload
          ? JSON.stringify(payload)
          : `${method} ${url} failed: ${response.status}`,
      )
      .catch(() => `${method} ${url} failed: ${response.status}`);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

const encodeSlug = (slug: string): string =>
  slug
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export async function fetchKnowledgeItems(
  input: number | KnowledgeListRequest = 80,
): Promise<KnowledgeListResponse> {
  const params = new URLSearchParams();
  if (typeof input === "number") {
    params.set("limit", String(input));
  } else {
    params.set("limit", String(input.limit ?? 80));
    params.set("page", String(input.page ?? 1));
    if (input.status) params.set("status", input.status);
    if (input.query) params.set("query", input.query);
    if (input.sortBy) params.set("sortBy", input.sortBy);
    if (input.sortDir) params.set("sortDir", input.sortDir);
  }
  const json = await getJson<KnowledgeListResponse>(`/api/knowledge?${params.toString()}`);
  return json;
}

export async function createKnowledgeItem(input: KnowledgeWriteInput): Promise<void> {
  await requestJson("/api/knowledge", "POST", input);
}

export async function updateKnowledgeItem(id: string, input: KnowledgeUpdateInput): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "PUT", input);
}

export async function deleteKnowledgeItem(id: string): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "DELETE");
}

export async function bulkUpdateKnowledgeStatus(
  input: KnowledgeBulkStatusRequest,
): Promise<KnowledgeBulkStatusResponse> {
  return requestJson<KnowledgeBulkStatusResponse>("/api/knowledge/bulk-status", "POST", input);
}

export async function sendKnowledgeFeedback(
  id: string,
  input: { direction: "up" | "down"; reason?: string },
): Promise<KnowledgeFeedback> {
  const json = await requestJson<{ feedback: KnowledgeFeedback }>(
    `/api/knowledge/${id}/feedback`,
    "POST",
    input,
  );
  return json.feedback;
}

export async function fetchVibeMemories(limit = 120): Promise<VibeMemory[]> {
  const json = await getJson<{ memories: VibeMemory[] }>(`/api/vibe-memory?limit=${limit}`);
  return json.memories;
}

export async function deleteVibeMemory(id: string): Promise<void> {
  await requestJson(`/api/vibe-memory/${id}`, "DELETE");
}

export async function fetchAgentDiffEntries(
  limit = 120,
  params?: { id?: string; vibeMemoryId?: string; vibeMemoryIds?: string[] },
): Promise<AgentDiffEntry[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (params?.id) query.set("id", params.id);
  if (params?.vibeMemoryId) query.set("vibeMemoryId", params.vibeMemoryId);
  if (params?.vibeMemoryIds?.length) query.set("vibeMemoryIds", params.vibeMemoryIds.join(","));
  const json = await getJson<{ entries: AgentDiffEntry[] }>(`/api/agent-diffs?${query}`);
  return json.entries;
}

export async function fetchDoctorReport(): Promise<DoctorReport> {
  return getJson<DoctorReport>("/api/doctor");
}

export async function fetchOverviewDashboard(): Promise<OverviewDashboard> {
  return getJson<OverviewDashboard>("/api/overview");
}

export async function fetchGraphSnapshot(
  input:
    | number
    | {
        limit?: number;
        status?: GraphStatusFilter;
        view?: GraphViewMode;
        communityDisplay?: GraphCommunityDisplayMode;
        relationAxes?: GraphRelationAxis[];
        minSimilarity?: number;
        semanticTopK?: number;
        maxContextEdgesPerNode?: number;
        sourceNodeLimit?: number;
      } = 1000,
): Promise<GraphSnapshot> {
  const params = new URLSearchParams();
  if (typeof input === "number") {
    params.set("limit", String(input));
  } else {
    params.set("limit", String(input.limit ?? 1000));
    if (input.status) params.set("status", input.status);
    if (input.view) params.set("view", input.view);
    if (input.communityDisplay) params.set("communityDisplay", input.communityDisplay);
    if (input.relationAxes && input.relationAxes.length > 0) {
      params.set("relationAxes", input.relationAxes.join(","));
    }
    if (input.minSimilarity !== undefined) {
      params.set("minSimilarity", String(input.minSimilarity));
    }
    if (input.semanticTopK !== undefined) {
      params.set("semanticTopK", String(input.semanticTopK));
    }
    if (input.maxContextEdgesPerNode !== undefined) {
      params.set("maxContextEdgesPerNode", String(input.maxContextEdgesPerNode));
    }
    if (input.sourceNodeLimit !== undefined) {
      params.set("sourceNodeLimit", String(input.sourceNodeLimit));
    }
  }
  return getJson<GraphSnapshot>(`/api/graph?${params}`);
}

export async function fetchGraphCommunityLabels(input?: {
  limit?: number;
  status?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
}): Promise<GraphCommunityLabel[]> {
  const params = new URLSearchParams();
  if (input?.limit !== undefined) params.set("limit", String(input.limit));
  if (input?.status) params.set("status", input.status);
  if (input?.relationAxes?.length) params.set("relationAxes", input.relationAxes.join(","));
  const query = params.toString();
  const path = query ? `/api/graph/community-labels?${query}` : "/api/graph/community-labels";
  const json = await getJson<{ labels: GraphCommunityLabel[] }>(path);
  return json.labels;
}

export async function updateGraphCommunityLabel(input: {
  communityKey: string;
  label: string;
  note?: string;
}): Promise<{
  communityKey: string;
  label: string;
  note: string | null;
  updatedAt: string;
}> {
  const payload = {
    label: input.label,
    note: input.note ?? "",
  };
  const json = await requestJson<{
    label: {
      communityKey: string;
      label: string;
      note: string | null;
      updatedAt: string;
    };
  }>(`/api/graph/community-labels/${encodeURIComponent(input.communityKey)}`, "PUT", payload);
  return json.label;
}

export async function fetchGraphNodeDetail(rawId: string): Promise<GraphNodeDetail | null> {
  try {
    return await getJson<GraphNodeDetail>(`/api/graph/nodes/${encodeURIComponent(rawId)}`);
  } catch {
    return null;
  }
}

export async function fetchSourceTree(): Promise<SourceTreeResponse> {
  return getJson<SourceTreeResponse>("/api/sources/tree");
}

export async function fetchSourceHealth(): Promise<SourceHealth> {
  return getJson<SourceHealth>("/api/sources/health");
}

export async function fetchSourcePage(slug: string): Promise<SourcePageDocument> {
  return getJson<SourcePageDocument>(`/api/sources/pages/${encodeSlug(slug)}`);
}

export async function createSourcePage(input: {
  slug: string;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/pages", "POST", input);
}

export async function updateSourcePage(
  slug: string,
  input: {
    slug?: string;
    title?: string;
    body: string;
    meta?: Record<string, unknown>;
    commitMessage?: string;
  },
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(
    `/api/sources/pages/${encodeSlug(slug)}`,
    "PUT",
    input,
  );
}

export async function deleteSourcePage(slug: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/pages/${encodeSlug(slug)}`, "DELETE");
}

export async function createSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/folders", "POST", { path });
}

export async function renameSourceFolder(
  path: string,
  nextPath: string,
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "PUT", {
    path: nextPath,
  });
}

export async function deleteSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "DELETE");
}

export async function fetchSourceHistory(slug: string): Promise<SourceHistoryItem[]> {
  const json = await getJson<{ slug: string; items: SourceHistoryItem[] }>(
    `/api/sources/history/${encodeSlug(slug)}`,
  );
  return json.items;
}

export async function fetchSourceDiff(slug: string, from: string, to: string): Promise<string> {
  const json = await getJson<{ diff: string }>(
    `/api/sources/diff/${encodeSlug(slug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return json.diff;
}

export async function searchSourcePages(query: string): Promise<SourceSearchItem[]> {
  const encoded = encodeURIComponent(query.trim());
  const json = await getJson<{ items: SourceSearchItem[] }>(`/api/sources/search?q=${encoded}`);
  return json.items;
}

export async function runSourceReindex(): Promise<SourceReindexResponse> {
  return requestJson<SourceReindexResponse>("/api/sources/reindex", "POST");
}

export async function fetchAuditLogs(input?: {
  page?: number;
  limit?: number;
  eventType?: string;
  actor?: AuditLogActor | "all";
}): Promise<AuditLogsResponse> {
  const query = new URLSearchParams();
  if (input?.page !== undefined) query.set("page", String(input.page));
  if (input?.limit !== undefined) query.set("limit", String(input.limit));
  if (input?.eventType) query.set("eventType", input.eventType);
  if (input?.actor && input.actor !== "all") query.set("actor", input.actor);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return getJson<AuditLogsResponse>(`/api/audit-logs${suffix}`);
}

export async function fetchCandidateItems(
  input: CandidateListRequest = {},
): Promise<CandidateListResponse> {
  const query = new URLSearchParams();
  query.set("page", String(input.page ?? 1));
  query.set("limit", String(input.limit ?? 50));
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.targetKind && input.targetKind !== "all") query.set("targetKind", input.targetKind);
  if (input.outcome && input.outcome !== "all") query.set("outcome", input.outcome);
  if (input.hasKnowledge && input.hasKnowledge !== "all") {
    query.set("hasKnowledge", input.hasKnowledge);
  }
  if (input.targetStateId?.trim()) query.set("targetStateId", input.targetStateId.trim());
  if (input.sortBy) query.set("sortBy", input.sortBy);
  if (input.sortDir) query.set("sortDir", input.sortDir);
  return getJson<CandidateListResponse>(`/api/candidates?${query.toString()}`);
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettingsSnapshotResponse> {
  return getJson<RuntimeSettingsSnapshotResponse>("/api/settings");
}

export async function updateRuntimeSettings(
  input: RuntimeSettingsUpdateRequest,
): Promise<RuntimeSettingsUpdateResponse> {
  return requestJson<RuntimeSettingsUpdateResponse>("/api/settings", "PUT", input);
}

export async function testRuntimeProvider(
  provider: RuntimeProviderName,
): Promise<RuntimeProviderHealthResponse> {
  return requestJson<RuntimeProviderHealthResponse>(
    `/api/settings/providers/${provider}/test`,
    "POST",
  );
}

export async function reloadRuntimeSettingsCache(): Promise<RuntimeSettingsReloadResponse> {
  return requestJson<RuntimeSettingsReloadResponse>("/api/settings/reload-runtime-cache", "POST");
}
