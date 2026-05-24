import { describe, expect, it, vi } from "vitest";
import {
  defaultModelForProvider,
  isProviderConfigured,
  resolveDistillationModel,
  resolveDistillationProviderOrder,
  resolveProviderForDistillation,
} from "../src/modules/distillation/llm-resolver.js";
import { groupedConfig } from "../src/config.js";

describe("distillation llm-resolver", () => {
  describe("resolveDistillationProviderOrder", () => {
    it("returns all providers when setting is 'auto'", () => {
      const order = resolveDistillationProviderOrder("auto");
      expect(order).toEqual(["local-llm", "openai", "azure-openai", "bedrock"]);
    });

    it("returns single provider array when setting is specific provider", () => {
      expect(resolveDistillationProviderOrder("local-llm")).toEqual(["local-llm"]);
      expect(resolveDistillationProviderOrder("openai")).toEqual(["openai"]);
      expect(resolveDistillationProviderOrder("azure-openai")).toEqual(["azure-openai"]);
      expect(resolveDistillationProviderOrder("bedrock")).toEqual(["bedrock"]);
    });
  });

  describe("defaultModelForProvider", () => {
    it("returns correct configured model name for each provider", () => {
      // Backup original config values
      const originalOpenAiModel = groupedConfig.openAi.model;
      const originalAzureModel = groupedConfig.azureOpenAi.model;
      const originalBedrockModel = groupedConfig.bedrock.model;
      const originalLocalModel = groupedConfig.localLlm.model;

      try {
        groupedConfig.openAi.model = "test-openai-model";
        groupedConfig.azureOpenAi.model = "test-azure-model";
        groupedConfig.bedrock.model = "test-bedrock-model";
        groupedConfig.localLlm.model = "test-local-model";

        expect(defaultModelForProvider("openai")).toBe("test-openai-model");
        expect(defaultModelForProvider("azure-openai")).toBe("test-azure-model");
        expect(defaultModelForProvider("bedrock")).toBe("test-bedrock-model");
        expect(defaultModelForProvider("local-llm")).toBe("test-local-model");
      } finally {
        // Restore configs
        groupedConfig.openAi.model = originalOpenAiModel;
        groupedConfig.azureOpenAi.model = originalAzureModel;
        groupedConfig.bedrock.model = originalBedrockModel;
        groupedConfig.localLlm.model = originalLocalModel;
      }
    });
  });

  describe("isProviderConfigured", () => {
    it("correctly identifies configuration status", () => {
      const originalOpenAi = { ...groupedConfig.openAi };
      const originalAzure = { ...groupedConfig.azureOpenAi };
      const originalBedrock = { ...groupedConfig.bedrock };
      const originalLocal = { ...groupedConfig.localLlm };

      try {
        // Case: Fully configured
        groupedConfig.openAi.apiKey = "key";
        groupedConfig.openAi.apiBaseUrl = "http://base";
        groupedConfig.openAi.model = "model";

        groupedConfig.azureOpenAi.apiKey = "key";
        groupedConfig.azureOpenAi.apiBaseUrl = "http://base";
        groupedConfig.azureOpenAi.model = "model";

        groupedConfig.bedrock.region = "region";
        groupedConfig.bedrock.model = "model";

        groupedConfig.localLlm.apiBaseUrl = "http://base";
        groupedConfig.localLlm.model = "model";

        expect(isProviderConfigured("openai")).toBe(true);
        expect(isProviderConfigured("azure-openai")).toBe(true);
        expect(isProviderConfigured("bedrock")).toBe(true);
        expect(isProviderConfigured("local-llm")).toBe(true);

        // Case: Unconfigured
        groupedConfig.openAi.apiKey = "";
        expect(isProviderConfigured("openai")).toBe(false);

        groupedConfig.azureOpenAi.apiKey = "";
        expect(isProviderConfigured("azure-openai")).toBe(false);

        groupedConfig.bedrock.region = "";
        expect(isProviderConfigured("bedrock")).toBe(false);

        groupedConfig.localLlm.apiBaseUrl = "";
        expect(isProviderConfigured("local-llm")).toBe(false);
      } finally {
        groupedConfig.openAi = originalOpenAi;
        groupedConfig.azureOpenAi = originalAzure;
        groupedConfig.bedrock = originalBedrock;
        groupedConfig.localLlm = originalLocal;
      }
    });
  });

  describe("resolveProviderForDistillation", () => {
    it("prefers first configured provider in order", () => {
      const originalOpenAi = { ...groupedConfig.openAi };
      const originalAzure = { ...groupedConfig.azureOpenAi };
      const originalBedrock = { ...groupedConfig.bedrock };
      const originalLocal = { ...groupedConfig.localLlm };

      try {
        // Force local-llm and OpenAI unconfigured, Azure configured.
        groupedConfig.localLlm.apiBaseUrl = "";
        groupedConfig.openAi.apiKey = "";
        groupedConfig.azureOpenAi.apiKey = "key";
        groupedConfig.azureOpenAi.apiBaseUrl = "url";
        groupedConfig.azureOpenAi.model = "model";

        // Under 'auto', it should skip unconfigured local-llm/openai and resolve to azure-openai.
        const resolved = resolveProviderForDistillation("auto");
        expect(resolved).toBe("azure-openai");
      } finally {
        groupedConfig.openAi = originalOpenAi;
        groupedConfig.azureOpenAi = originalAzure;
        groupedConfig.bedrock = originalBedrock;
        groupedConfig.localLlm = originalLocal;
      }
    });
  });

  describe("resolveDistillationModel", () => {
    it("resolves model for the chosen provider", () => {
      const originalOpenAi = { ...groupedConfig.openAi };
      const originalAzure = { ...groupedConfig.azureOpenAi };
      const originalBedrock = { ...groupedConfig.bedrock };
      const originalLocal = { ...groupedConfig.localLlm };

      try {
        groupedConfig.openAi.apiKey = "";
        groupedConfig.azureOpenAi.apiKey = "key";
        groupedConfig.azureOpenAi.apiBaseUrl = "url";
        groupedConfig.azureOpenAi.model = "azure-model-test";

        groupedConfig.localLlm.apiBaseUrl = ""; // Force disable local-llm

        const model = resolveDistillationModel("auto");
        expect(model).toBe("azure-model-test");
      } finally {
        groupedConfig.openAi = originalOpenAi;
        groupedConfig.azureOpenAi = originalAzure;
        groupedConfig.bedrock = originalBedrock;
        groupedConfig.localLlm = originalLocal;
      }
    });
  });
});
