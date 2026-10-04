import type {
  RuntimeSettingsSnapshotResponse,
  RuntimeSettingsView,
} from "../../../web/src/modules/admin/repositories/admin/settings-contracts";
function secretStatus(configured: boolean) {
  return {
    configured,
    source: configured ? ("env" as const) : ("none" as const),
    maskedValue: configured ? "sk****ey" : null,
    updatedAt: configured ? "2026-05-23T12:00:00.000Z" : null,
  };
}

export function buildSettingsView(): RuntimeSettingsView {
  const openAiTarget = {
    source: "route" as const,
    targets: [
      {
        provider: "openai" as const,
        id: "route:openai:gpt-5-4-mini",
        label: "gpt-5-4-mini",
        source: "route" as const,
        model: "gpt-5-4-mini",
        endpoint: "https://api.openai.com/v1",
      },
    ],
  };
  const localPoolTarget = {
    source: "provider_pool" as const,
    providerPoolId: "local-llm-default",
    targets: [
      {
        provider: "local-llm" as const,
        id: "provider-pool:local-llm-default:local-llm:local-primary",
        label: "Primary",
        source: "provider_pool" as const,
        model: "gemma-4-e4b-it",
        endpoint: "http://127.0.0.1:44448",
        providerPoolId: "local-llm-default",
        localLlmModelId: "local-primary",
      },
    ],
  };

  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: ["knowledge_candidate", "web_ingest", "wiki_file", "vibe_memory"],
      },
    },
    providerPools: [
      {
        id: "local-llm-default",
        label: "Local LLM pool",
        targets: [{ provider: "local-llm", localLlmModelId: "local-primary" }],
        maxConcurrent: 1,
        staleLeaseSeconds: 600,
        enabled: true,
        lowPriorityAgingSeconds: 1800,
      },
    ],
    effectiveTargets: {
      providerPools: {
        "local-llm-default": localPoolTarget.targets,
      },
      taskRouting: {
        findCandidate: {
          source: openAiTarget,
          vibe: openAiTarget,
        },
        webSourceResearch: localPoolTarget,
        deepStillManual: localPoolTarget,
        episodeDistiller: localPoolTarget,
        coverEvidence: {
          sourceSupport: localPoolTarget,
          externalEvidence: localPoolTarget,
          mcpEvidence: localPoolTarget,
        },
        finalizeDistille: localPoolTarget,
        mergeActivationFinalize: localPoolTarget,
        deadZoneMergeReview: localPoolTarget,
        landscapeCuration: localPoolTarget,
        agenticCompile: openAiTarget,
      },
    },
    diagnostics: {
      providerPools: [],
    },
    providers: {
      openai: {
        enabled: true,
        apiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5-4-mini",
        apiKeySecret: secretStatus(true),
      },
      "azure-openai": {
        enabled: true,
        apiBaseUrl: "https://example.openai.azure.com",
        apiPath: "/openai/deployments",
        apiVersion: "2025-04-01-preview",
        model: "gpt-5-4-mini",
        apiKeySecret: secretStatus(true),
        apiKeySecrets: [secretStatus(true), secretStatus(false), secretStatus(false)],
        deployments: [
          {
            name: "Primary",
            apiBaseUrl: "https://example.openai.azure.com",
            apiPath: "/openai/deployments",
            apiVersion: "2025-04-01-preview",
            model: "gpt-5-4-mini",
          },
        ],
      },
      bedrock: {
        enabled: false,
        region: "us-east-1",
        profile: "",
        model: "anthropic.claude-3-5-haiku-20241022-v1:0",
        credentialSecret: {
          configured: false,
          source: "none",
          maskedValue: null,
          updatedAt: null,
        },
      },
      "local-llm": {
        enabled: true,
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
        models: [
          {
            id: "local-primary",
            name: "Primary",
            apiBaseUrl: "http://127.0.0.1:44448",
            apiPath: "/v1/chat/completions",
            model: "gemma-4-e4b-it",
          },
          {
            id: "local-qwen",
            name: "Qwen",
            apiBaseUrl: "http://127.0.0.1:44449",
            apiPath: "/v1/chat/completions",
            model: "qwen-3.6-14b-it",
          },
        ],
        apiKeySecret: secretStatus(false),
        apiKeySecrets: [secretStatus(false), secretStatus(true)],
      },
      "larm-agent-connection": {
        enabled: false,
        connections: [],
      },
      codex: {
        enabled: false,
        model: "codex-sdk-agent",
      },
    },
    taskRouting: {
      findCandidate: {
        source: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        vibe: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        throttling: {
          backgroundEnabled: true,
          interactiveWindowSeconds: 180,
          recentBlockSeconds: 30,
          minIntervalSeconds: 30,
          mediumIntervalSeconds: 90,
          busyIntervalSeconds: 180,
          maxIntervalSeconds: 300,
          rateLimitCooldownSeconds: 600,
          jitterSeconds: 10,
        },
      },
      webSourceResearch: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      deepStillManual: {
        provider: "local-llm",
        model: "qwen-3.6-14b-it",
        fallback: [],
      },
      episodeDistiller: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      coverEvidence: {
        sourceSupport: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          providerPoolId: "local-llm-default",
          fallback: ["azure-openai"],
        },
        externalEvidence: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          providerPoolId: "local-llm-default",
          fallback: ["azure-openai"],
        },
        mcpEvidence: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          providerPoolId: "local-llm-default",
          fallback: ["azure-openai"],
        },
      },
      finalizeDistille: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      mergeActivationFinalize: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: ["azure-openai"],
      },
      deadZoneMergeReview: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
      landscapeCuration: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
      agenticCompile: {
        enabled: true,
        provider: "openai",
        model: "gpt-5-4-mini",
        fallback: ["local-llm"],
        timeoutMs: 15000,
        maxTokens: 4000,
      },
    },
    search: {
      providerOrder: ["brave", "exa", "duckduckgo"],
      maxProviderAttempts: 2,
      resultCount: 8,
      timeoutMs: 10000,
      rateLimitCooldownSeconds: 3600,
      providers: {
        brave: { enabled: true, apiKeySecret: secretStatus(true) },
        exa: { enabled: true, apiKeySecret: secretStatus(false) },
        duckduckgo: { enabled: true },
      },
    },
    embedding: {
      provider: "daemon",
      daemonUrl: "http://127.0.0.1:44512",
      openaiModel: "text-embedding-3-small",
      timeoutMs: 30000,
    },
    distillationRuntime: {
      timeoutMs: 30000,
      candidateTimeoutMs: 15000,
      maxToolRounds: 4,
      findCandidateTimeoutMs: 600000,
      findCandidateMaxToolCalls: 8,
      coverEvidenceTimeoutMs: 600000,
      coverEvidenceSearchMaxCalls: 3,
      coverEvidenceFetchMaxCalls: 5,
      coverEvidenceFetchMaxTokensPerSite: 3000,
      toolTimeoutMs: 10000,
      toolResultMaxChars: 12000,
      failureRetryDelaySeconds: 90,
      readerMaxReads: 12,
      readerMaxCharsPerRead: 12000,
      llmContextWindowTokens: 128000,
      llmMaxInputTokens: 80000,
      llmInputSafetyMarginTokens: 4096,
      lowImportanceRejectThreshold: 40,
    },
    advanced: {
      pipelineLockStaleSeconds: 1200,
      lockTtlSeconds: 1800,
      pipelineClaimLimit: 1,
      findingQueueTaskIntervalSeconds: 30,
      coveringQueueTaskIntervalSeconds: 10,
      continuousIdleSleepMs: 5000,
      continuousErrorSleepMs: 12000,
      inventoryRefreshIntervalMs: 30000,
      doctorFreshnessThresholdMinutes: 720,
      doctorDegradedRateThreshold: 0.5,
      doctorKnowledgeZeroUseWarningMinActiveCount: 10,
      codexLogSyncEnabled: true,
      antigravityLogSyncEnabled: true,
      claudeLogSyncEnabled: true,
    },
  };
}

export function buildSnapshot(revision = 1): RuntimeSettingsSnapshotResponse {
  const settings = buildSettingsView();
  return {
    settings,
    effective: settings,
    sources: {},
    revision,
    loadedAt: "2026-05-23T12:00:00.000Z",
  };
}
