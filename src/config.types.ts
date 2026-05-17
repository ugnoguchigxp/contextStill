export type EmbeddingProvider = "auto" | "daemon" | "cli" | "disabled";
export type AgenticCompileProvider = "azure-openai" | "bedrock" | "local-llm" | "auto";
export type DistillationProvider = "local-llm" | "azure-openai" | "bedrock" | "auto";

export type GroupedConfig = {
  database: { url: string };
  embedding: {
    dimension: number;
    provider: EmbeddingProvider;
    daemonUrl: string;
    accessToken: string;
    timeoutMs: number;
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
  codex: { sessionDir: string; archivedSessionDir: string };
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
    timeoutMs: number;
    resultMaxChars: number;
    searchResultCount: number;
    maxCandidates: number;
    failureRetryDelaySeconds: number;
  };
  compile: { defaultTokenBudget: number; enableVectorSearch: boolean };
  azureOpenAi: {
    apiKey: string;
    apiBaseUrl: string;
    apiPath: string;
    apiVersion: string;
    model: string;
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
    timeoutMs: number;
    lockTtlSeconds: number;
    lockFile: string;
  };
  doctor: {
    freshnessThresholdMinutes: number;
    degradedRateThreshold: number;
    knowledgeStaleDecayFactor: number;
    knowledgeZeroUseWarningMinActiveCount: number;
  };
};
