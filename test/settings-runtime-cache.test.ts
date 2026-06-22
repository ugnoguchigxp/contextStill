import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  cloneDefaultSettings,
  parseDocumentValue,
} from "../src/modules/settings/settings.defaults.js";
import {
  type SecretValueEntry,
  applyRuntimeSettingsToProcess,
} from "../src/modules/settings/settings.runtime-cache.js";
import type {
  RuntimeSecretKey,
  RuntimeSettingsEditable,
} from "../src/modules/settings/settings.types.js";

type ProviderConfigSnapshot = {
  openAi: typeof groupedConfig.openAi;
  azureOpenAi: typeof groupedConfig.azureOpenAi;
  bedrock: typeof groupedConfig.bedrock;
  localLlm: typeof groupedConfig.localLlm;
};

function cloneProviderConfig(): ProviderConfigSnapshot {
  return JSON.parse(
    JSON.stringify({
      openAi: groupedConfig.openAi,
      azureOpenAi: groupedConfig.azureOpenAi,
      bedrock: groupedConfig.bedrock,
      localLlm: groupedConfig.localLlm,
    }),
  ) as ProviderConfigSnapshot;
}

function restoreProviderConfig(snapshot: ProviderConfigSnapshot): void {
  groupedConfig.openAi = snapshot.openAi;
  groupedConfig.azureOpenAi = snapshot.azureOpenAi;
  groupedConfig.bedrock = snapshot.bedrock;
  groupedConfig.localLlm = snapshot.localLlm;
}

function secret(value: string): SecretValueEntry {
  return { value, source: "db", updatedAt: null };
}

function emptySecrets(): Record<RuntimeSecretKey, SecretValueEntry | null> {
  return {
    openaiApiKey: null,
    azureOpenAiApiKey: null,
    azureOpenAiApiKey2: null,
    azureOpenAiApiKey3: null,
    localLlmApiKey: null,
    braveApiKey: null,
    exaApiKey: null,
  };
}

describe("settings runtime cache", () => {
  let originalConfig: ProviderConfigSnapshot;
  let settings: RuntimeSettingsEditable;

  beforeEach(() => {
    originalConfig = cloneProviderConfig();
    settings = cloneDefaultSettings();
  });

  afterEach(() => {
    restoreProviderConfig(originalConfig);
  });

  test("does not configure disabled LLM providers even when settings and secrets are present", () => {
    settings.providers.openai = {
      enabled: false,
      apiBaseUrl: "https://api.openai.example/v1",
      model: "gpt-test",
    };
    settings.providers["azure-openai"] = {
      enabled: false,
      apiBaseUrl: "https://primary.openai.azure.com",
      apiPath: "/openai/deployments",
      apiVersion: "2025-04-01-preview",
      model: "gpt-primary",
      deployments: [
        {
          name: "Primary",
          apiBaseUrl: "https://primary.openai.azure.com",
          apiPath: "/openai/deployments",
          apiVersion: "2025-04-01-preview",
          model: "gpt-primary",
        },
        {
          name: "Secondary",
          apiBaseUrl: "https://secondary.openai.azure.com",
          apiPath: "/openai/deployments",
          apiVersion: "2025-04-01-preview",
          model: "gpt-secondary",
        },
      ],
    };
    settings.providers.bedrock = {
      enabled: false,
      region: "us-east-1",
      profile: "dev",
      model: "amazon.nova-pro-v1:0",
    };
    settings.providers["local-llm"] = {
      enabled: false,
      apiBaseUrl: "http://127.0.0.1:44448",
      apiPath: "/v1/chat/completions",
      model: "gemma-test",
      models: [
        {
          id: "primary",
          name: "Primary",
          apiBaseUrl: "http://127.0.0.1:44448",
          apiPath: "/v1/chat/completions",
          model: "gemma-test",
        },
      ],
    };

    applyRuntimeSettingsToProcess(settings, {
      ...emptySecrets(),
      openaiApiKey: secret("openai-key"),
      azureOpenAiApiKey: secret("azure-key-1"),
      azureOpenAiApiKey2: secret("azure-key-2"),
      localLlmApiKey: secret("local-key"),
    });

    expect(groupedConfig.openAi.apiKey).toBe("");
    expect(groupedConfig.azureOpenAi.apiKey).toBe("");
    expect(groupedConfig.azureOpenAi.deployments).toEqual([]);
    expect(groupedConfig.bedrock.model).toBe("");
    expect(groupedConfig.localLlm.model).toBe("");
    expect(groupedConfig.localLlm.models).toEqual([]);
    expect(groupedConfig.localLlm.apiKey).toBe("");
  });

  test("keeps multiple Azure OpenAI deployments active when the provider is enabled", () => {
    settings.providers["azure-openai"] = {
      enabled: true,
      apiBaseUrl: "https://primary.openai.azure.com",
      apiPath: "/openai/deployments",
      apiVersion: "2025-04-01-preview",
      model: "gpt-primary",
      deployments: [
        {
          name: "Primary",
          apiBaseUrl: "https://primary.openai.azure.com",
          apiPath: "/openai/deployments",
          apiVersion: "2025-04-01-preview",
          model: "gpt-primary",
        },
        {
          name: "Secondary",
          apiBaseUrl: "https://secondary.openai.azure.com",
          apiPath: "/openai/deployments",
          apiVersion: "2025-04-01-preview",
          model: "gpt-secondary",
        },
      ],
    };

    applyRuntimeSettingsToProcess(settings, {
      ...emptySecrets(),
      azureOpenAiApiKey: secret("azure-key-1"),
      azureOpenAiApiKey2: secret("azure-key-2"),
    });

    expect(groupedConfig.azureOpenAi.apiKey).toBe("azure-key-1");
    expect(groupedConfig.azureOpenAi.apiBaseUrl).toBe("https://primary.openai.azure.com");
    expect(groupedConfig.azureOpenAi.model).toBe("gpt-primary");
    expect(groupedConfig.azureOpenAi.deployments).toMatchObject([
      {
        apiKey: "azure-key-1",
        apiBaseUrl: "https://primary.openai.azure.com",
        model: "gpt-primary",
      },
      {
        apiKey: "azure-key-2",
        apiBaseUrl: "https://secondary.openai.azure.com",
        model: "gpt-secondary",
      },
    ]);
  });

  test("keeps multiple Local LLM model endpoints active when the provider is enabled", () => {
    settings.providers["local-llm"] = {
      enabled: true,
      apiBaseUrl: "http://127.0.0.1:44448",
      apiPath: "/v1/chat/completions",
      model: "local-primary",
      models: [
        {
          id: "primary",
          name: "Primary",
          apiBaseUrl: "http://127.0.0.1:44448",
          apiPath: "/v1/chat/completions",
          model: "local-primary",
        },
        {
          id: "coder",
          name: "Coder",
          apiBaseUrl: "http://127.0.0.1:44449",
          apiPath: "/v1/chat/completions",
          model: "local-coder",
        },
        {
          id: "reasoner",
          name: "Reasoner",
          apiBaseUrl: "http://127.0.0.1:44450",
          apiPath: "/v1/chat/completions",
          model: "local-reasoner",
        },
      ],
    };

    applyRuntimeSettingsToProcess(settings, {
      ...emptySecrets(),
      localLlmApiKey: secret("local-key"),
    });

    expect(groupedConfig.localLlm.apiBaseUrl).toBe("http://127.0.0.1:44448");
    expect(groupedConfig.localLlm.model).toBe("local-primary");
    expect(groupedConfig.localLlm.models).toEqual([
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "local-primary",
      },
      {
        name: "Coder",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "local-coder",
      },
      {
        name: "Reasoner",
        apiBaseUrl: "http://127.0.0.1:44450",
        apiPath: "/v1/chat/completions",
        model: "local-reasoner",
      },
    ]);
  });

  test("applies queue task intervals from runtime settings", () => {
    const originalFindingInterval = groupedConfig.distillation.findingQueueTaskIntervalSeconds;
    const originalCoveringInterval = groupedConfig.distillation.coveringQueueTaskIntervalSeconds;
    try {
      settings.advanced.findingQueueTaskIntervalSeconds = 17;
      settings.advanced.coveringQueueTaskIntervalSeconds = 3;

      applyRuntimeSettingsToProcess(settings, emptySecrets());

      expect(groupedConfig.distillation.findingQueueTaskIntervalSeconds).toBe(17);
      expect(groupedConfig.distillation.coveringQueueTaskIntervalSeconds).toBe(3);
    } finally {
      groupedConfig.distillation.findingQueueTaskIntervalSeconds = originalFindingInterval;
      groupedConfig.distillation.coveringQueueTaskIntervalSeconds = originalCoveringInterval;
    }
  });

  test("normalizes Cover Evidence routing to one queue processing route", () => {
    const row = {
      id: "settings-row-1",
      namespace: "runtime",
      key: "runtime_settings",
      value: {
        ...settings,
        taskRouting: {
          ...settings.taskRouting,
          coverEvidence: {
            sourceSupport: { provider: "openai", model: "gpt-source", fallback: [] },
            externalEvidence: {
              provider: "local-llm",
              model: "gemma-test",
              fallback: ["azure-openai"],
            },
            mcpEvidence: { provider: "bedrock", model: "bedrock-mcp", fallback: [] },
          },
        },
      },
      valueKind: "json",
      secretRef: null,
      isSecret: false,
      description: null,
      schemaVersion: 1,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const parsed = parseDocumentValue(row);

    expect(parsed.taskRouting.coverEvidence.sourceSupport).toEqual(
      parsed.taskRouting.coverEvidence.externalEvidence,
    );
    expect(parsed.taskRouting.coverEvidence.mcpEvidence).toEqual(
      parsed.taskRouting.coverEvidence.externalEvidence,
    );
    expect(parsed.taskRouting.coverEvidence.externalEvidence).toMatchObject({
      provider: "local-llm",
      model: "gemma-4-e4b-it",
      fallback: ["azure-openai"],
    });
  });

  test("preserves separate Find Candidate source and vibe processing routes", () => {
    const row = {
      id: "settings-row-2",
      namespace: "runtime",
      key: "runtime_settings",
      value: {
        ...settings,
        taskRouting: {
          ...settings.taskRouting,
          findCandidate: {
            ...settings.taskRouting.findCandidate,
            source: { provider: "azure-openai", model: "gpt-source", fallback: ["local-llm"] },
            vibe: { provider: "bedrock", model: "bedrock-vibe", fallback: [] },
          },
        },
      },
      valueKind: "json",
      secretRef: null,
      isSecret: false,
      description: null,
      schemaVersion: 1,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const parsed = parseDocumentValue(row);

    expect(parsed.taskRouting.findCandidate.source).toMatchObject({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      fallback: ["local-llm"],
    });
    expect(parsed.taskRouting.findCandidate.vibe).toMatchObject({
      provider: "bedrock",
      model: undefined,
      fallback: [],
    });
  });

  test("backfills Local LLM model ids and default provider pool", () => {
    const row = {
      id: "settings-row-provider-pool",
      namespace: "runtime",
      key: "runtime_settings",
      value: {
        ...settings,
        providers: {
          ...settings.providers,
          "local-llm": {
            enabled: true,
            apiBaseUrl: "http://127.0.0.1:44448",
            apiPath: "/v1/chat/completions",
            model: "qwen-primary",
            models: [
              {
                name: "Qwen A",
                apiBaseUrl: "http://127.0.0.1:44448",
                apiPath: "/v1/chat/completions",
                model: "qwen-primary",
              },
              {
                name: "Qwen B",
                apiBaseUrl: "http://127.0.0.1:44449",
                apiPath: "/v1/chat/completions",
                model: "qwen-primary",
              },
            ],
          },
        },
        taskRouting: {
          webSourceResearch: {
            provider: "local-llm",
            model: JSON.stringify({
              apiBaseUrl: "http://127.0.0.1:44449",
              apiPath: "/v1/chat/completions",
              model: "qwen-primary",
            }),
            localLlmModel: JSON.stringify({
              apiBaseUrl: "http://127.0.0.1:44449",
              apiPath: "/v1/chat/completions",
              model: "qwen-primary",
            }),
            fallback: [],
          },
          coverEvidence: {
            sourceSupport: { provider: "local-llm", fallback: [] },
            externalEvidence: { provider: "local-llm", fallback: [] },
            mcpEvidence: { provider: "local-llm", fallback: [] },
          },
          finalizeDistille: { provider: "local-llm", fallback: [] },
        },
      },
      valueKind: "json",
      secretRef: null,
      isSecret: false,
      description: null,
      schemaVersion: 1,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const parsed = parseDocumentValue(row);

    expect(parsed.providers["local-llm"].models.map((model) => model.id)).toEqual([
      expect.stringMatching(/^local-llm-[a-f0-9]{12}$/),
      expect.stringMatching(/^local-llm-[a-f0-9]{12}$/),
    ]);
    expect(new Set(parsed.providers["local-llm"].models.map((model) => model.id)).size).toBe(2);
    expect(parsed.providerPools).toHaveLength(1);
    expect(parsed.providerPools[0]).toMatchObject({
      id: "local-llm-default",
      maxConcurrent: 2,
      enabled: true,
      targets: [
        { provider: "local-llm", localLlmModelId: parsed.providers["local-llm"].models[0].id },
        { provider: "local-llm", localLlmModelId: parsed.providers["local-llm"].models[1].id },
      ],
    });
    expect(parsed.taskRouting.coverEvidence.externalEvidence.providerPoolId).toBe(
      "local-llm-default",
    );
    expect(parsed.taskRouting.episodeDistiller.model).toBe(
      parsed.taskRouting.webSourceResearch.model,
    );
    expect(parsed.taskRouting.episodeDistiller.localLlmModel).toBe(
      parsed.taskRouting.webSourceResearch.localLlmModel,
    );
    expect(parsed.taskRouting.episodeDistiller.providerPoolId).toBe("local-llm-default");
    expect(parsed.taskRouting.finalizeDistille.providerPoolId).toBe("local-llm-default");
  });
});
