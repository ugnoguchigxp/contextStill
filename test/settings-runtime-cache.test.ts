import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { groupedConfig } from "../src/config.js";
import { cloneDefaultSettings } from "../src/modules/settings/settings.defaults.js";
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
      model: "gemma-test",
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
});
