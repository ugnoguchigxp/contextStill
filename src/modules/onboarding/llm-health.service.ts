import { groupedConfig } from "../../config.js";
import { checkAgenticLlmHealth } from "../llm/agentic-llm.service.js";
import type { StartupPlan, LlmHealthResult } from "./onboarding.types.js";

export async function checkPlanLlmHealth(plan: StartupPlan): Promise<LlmHealthResult> {
  const backup = {
    agenticCompileProvider: groupedConfig.agenticCompile.provider,
    openaiKey: groupedConfig.openAi.apiKey,
    openaiBaseUrl: groupedConfig.openAi.apiBaseUrl,
    openaiModel: groupedConfig.openAi.model,
    azureKey: groupedConfig.azureOpenAi.apiKey,
    azureBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
    azureModel: groupedConfig.azureOpenAi.model,
    azureVersion: groupedConfig.azureOpenAi.apiVersion,
    bedrockModel: groupedConfig.bedrock.model,
    bedrockRegion: groupedConfig.bedrock.region,
    bedrockProfile: groupedConfig.bedrock.profile,
    localLlmBaseUrl: groupedConfig.localLlm.apiBaseUrl,
    localLlmKey: groupedConfig.localLlm.apiKey,
    localLlmModel: groupedConfig.localLlm.model,
  };

  try {
    groupedConfig.agenticCompile.provider = plan.compile.provider;
    if (plan.compile.openaiKey !== undefined) groupedConfig.openAi.apiKey = plan.compile.openaiKey;
    if (plan.compile.openaiBaseUrl !== undefined) groupedConfig.openAi.apiBaseUrl = plan.compile.openaiBaseUrl;
    if (plan.compile.openaiModel !== undefined) groupedConfig.openAi.model = plan.compile.openaiModel;

    if (plan.compile.azureKey !== undefined) groupedConfig.azureOpenAi.apiKey = plan.compile.azureKey;
    if (plan.compile.azureBaseUrl !== undefined) groupedConfig.azureOpenAi.apiBaseUrl = plan.compile.azureBaseUrl;
    if (plan.compile.azureModel !== undefined) groupedConfig.azureOpenAi.model = plan.compile.azureModel;
    if (plan.compile.azureVersion !== undefined) groupedConfig.azureOpenAi.apiVersion = plan.compile.azureVersion;

    if (plan.compile.bedrockModel !== undefined) groupedConfig.bedrock.model = plan.compile.bedrockModel;
    if (plan.compile.bedrockRegion !== undefined) groupedConfig.bedrock.region = plan.compile.bedrockRegion;
    if (plan.compile.bedrockProfile !== undefined) groupedConfig.bedrock.profile = plan.compile.bedrockProfile;

    if (plan.compile.localLlmBaseUrl !== undefined) groupedConfig.localLlm.apiBaseUrl = plan.compile.localLlmBaseUrl;
    if (plan.compile.localLlmKey !== undefined) groupedConfig.localLlm.apiKey = plan.compile.localLlmKey;
    if (plan.compile.localLlmModel !== undefined) groupedConfig.localLlm.model = plan.compile.localLlmModel;

    const health = await checkAgenticLlmHealth(plan.compile.provider, 5000);

    return {
      ok: health.reachable,
      provider: plan.compile.provider,
      message: health.reachable ? "LLM connection healthy" : (health.error || "LLM unreachable"),
      error: health.error,
    };
  } catch (err) {
    return {
      ok: false,
      provider: plan.compile.provider,
      message: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? err.stack : undefined,
    };
  } finally {
    groupedConfig.agenticCompile.provider = backup.agenticCompileProvider;
    groupedConfig.openAi.apiKey = backup.openaiKey;
    groupedConfig.openAi.apiBaseUrl = backup.openaiBaseUrl;
    groupedConfig.openAi.model = backup.openaiModel;
    groupedConfig.azureOpenAi.apiKey = backup.azureKey;
    groupedConfig.azureOpenAi.apiBaseUrl = backup.azureBaseUrl;
    groupedConfig.azureOpenAi.model = backup.azureModel;
    groupedConfig.azureOpenAi.apiVersion = backup.azureVersion;
    groupedConfig.bedrock.model = backup.bedrockModel;
    groupedConfig.bedrock.region = backup.bedrockRegion;
    groupedConfig.bedrock.profile = backup.bedrockProfile;
    groupedConfig.localLlm.apiBaseUrl = backup.localLlmBaseUrl;
    groupedConfig.localLlm.apiKey = backup.localLlmKey;
    groupedConfig.localLlm.model = backup.localLlmModel;
  }
}
