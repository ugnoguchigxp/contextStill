export type EmbeddingProvider = "auto" | "daemon" | "cli" | "openai" | "disabled";
export type AgenticCompileProvider = "openai" | "azure-openai" | "bedrock" | "local-llm" | "codex" | "auto";
export type DistillationProvider = "openai" | "local-llm" | "azure-openai" | "bedrock" | "codex" | "auto";
export type DistillationSearchProvider = "brave" | "exa" | "duckduckgo";

export type GroupedConfig = {
  database: { url: string };
  embedding: {
    dimension: number;
    provider: EmbeddingProvider;
    daemonUrl: string;
    accessToken: string;
    timeoutMs: number;
    openaiModel: string;
  };
  localLlm: {
    embeddingRoot: string;
    embeddingPython: string;
    embeddingModelDir: string;
    apiBaseUrl: string;
    apiKey: string;
    model: string;
  };
  sourceContent: { root: string };
  readFile: {
    root: string;
    defaultTokens: number;
    maxTokens: number;
  };
  codex: {
    sessionDir: string;
    archivedSessionDir: string;
    accessToken: string;
  };
  antigravity: { logDir: string; initialLookbackHours: number };
  agentLogSync: {
    intervalSeconds: number;
    initialLookbackHours: number;
    maxMessagesPerChunk: number;
    maxCharsPerChunk: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  vibeDistillation: {
    promptVersion: string;
    batchSize: number;
    maxInputChars: number;
    maxOutputTokens: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  sourceDistillation: {
    promptVersion: string;
    batchSize: number;
    maxInputChars: number;
    maxOutputTokens: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  distillationTools: {
    maxRounds: number;
    findCandidateMaxToolCalls: number;
    coverEvidenceSearchMaxCalls: number;
    coverEvidenceFetchMaxCalls: number;
    timeoutMs: number;
    resultMaxChars: number;
    searchResultCount: number;
    searchProviders: DistillationSearchProvider[];
    searchMaxProviderAttempts: number;
    searchRateLimitCooldownSeconds: number;
    failureRetryDelaySeconds: number;
    evidenceCacheTtlSeconds: number;
    readerMaxReads: number;
    readerMaxCharsPerRead: number;
  };
  compile: {
    defaultTokenBudget: number;
    candidateTraceLimit: number;
    candidateTraceLimitMax: number;
    enableVectorSearch: boolean;
  };
  openAi: {
    apiKey: string;
    apiBaseUrl: string;
    model: string;
  };
  azureOpenAi: {
    apiKey: string;
    apiBaseUrl: string;
    apiPath: string;
    apiVersion: string;
    model: string;
    deployments: Array<{
      apiKey: string;
      apiBaseUrl: string;
      apiPath: string;
      apiVersion: string;
      model: string;
    }>;
  };
  bedrock: {
    model: string;
    region: string;
    profile: string;
  };
  agenticCompile: {
    provider: AgenticCompileProvider;
    enabled: boolean;
    timeoutMs: number;
    maxTokens: number;
  };
  distillation: {
    provider: DistillationProvider;
    findCandidateProvider: DistillationProvider;
    timeoutMs: number;
    findCandidateTimeoutMs: number;
    coverEvidenceTimeoutMs: number;
    coverEvidenceConcurrency: number;
    lockTtlSeconds: number;
    lockFile: string;
    pipelineLockFile: string;
    candidateTimeoutMs: number;
    pipelineLockStaleSeconds: number;
    pipelineClaimLimit: number;
    continuousIdleSleepMs: number;
    continuousErrorSleepMs: number;
    inventoryRefreshIntervalMs: number;
    findCandidateBackgroundEnabled: boolean;
    findCandidateNoWait: boolean;
    findCandidateInteractiveWindowSeconds: number;
    findCandidateRecentBlockSeconds: number;
    findCandidateMinIntervalSeconds: number;
    findCandidateMediumIntervalSeconds: number;
    findCandidateBusyIntervalSeconds: number;
    findCandidateMaxIntervalSeconds: number;
    findCandidateRateLimitCooldownSeconds: number;
    findCandidateJitterSeconds: number;
    findingQueueTaskIntervalSeconds: number;
    promotionBacklogThresholdCount: number;
    lowImportanceRejectThreshold: number;
    circuitBreakerEnabled: boolean;
    circuitBreakerHealthTimeoutMs: number;
    circuitBreakerPauseSeconds: number;
    backpressurePauseSeconds: number;
    sourceAgenticReaderManualEnabled: boolean;
    sourceAgenticReaderAutoEnabled: boolean;
    vibeAgenticReaderManualEnabled: boolean;
  };
  admin: {
    apiKey: string;
    allowedOrigins: string[];
  };
  doctor: {
    freshnessThresholdMinutes: number;
    degradedRateThreshold: number;
    knowledgeStaleDecayFactor: number;
    knowledgeZeroUseWarningMinActiveCount: number;
  };
};
