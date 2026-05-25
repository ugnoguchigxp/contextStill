import { APP_CONSTANTS } from "../../constants.js";
import {
  bootstrap,
  cloneDefaultSettings,
  normalizeDistillationTargetPriorityOrder,
  parseDocumentValue,
  secretRowKeys,
} from "./settings.defaults.js";
import {
  SETTINGS_DOCUMENT_KEY,
  SETTINGS_DOCUMENT_NAMESPACE,
  SETTINGS_SECRET_NAMESPACE,
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "./settings.repository.js";
import {
  type RuntimeSettingsCache,
  applyRuntimeSettingsToProcess,
  buildRuntimeSettingsView,
  buildSecretMap,
  buildSourceMap,
  defaultCache,
  maskSecret,
  resolveBedrockCredentialStatus,
  resolveSecretValue,
} from "./settings.runtime-cache.js";
import {
  type DistillationPriorityTargetKind,
  type RuntimeSecretKey,
  type RuntimeSettingsEditable,
  type RuntimeSettingsRoute,
  type RuntimeSettingsUpdateRequest,
  type RuntimeSettingsView,
  runtimeSettingsEditableSchema,
} from "./settings.types.js";

let runtimeSettingsCache: RuntimeSettingsCache = defaultCache();
let loadingPromise: Promise<void> | null = null;

async function loadRuntimeSettingsInternal(): Promise<void> {
  const [documentRow, secretRows] = await Promise.all([
    findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY),
    listSettingsRows(SETTINGS_SECRET_NAMESPACE),
  ]);

  const settings = parseDocumentValue(documentRow);
  const secretRowMap = buildSecretMap(secretRows);
  const resolvedSecrets = {
    openaiApiKey: resolveSecretValue("openaiApiKey", secretRowMap.openaiApiKey),
    azureOpenAiApiKey: resolveSecretValue("azureOpenAiApiKey", secretRowMap.azureOpenAiApiKey),
    azureOpenAiApiKey2: resolveSecretValue("azureOpenAiApiKey2", secretRowMap.azureOpenAiApiKey2),
    azureOpenAiApiKey3: resolveSecretValue("azureOpenAiApiKey3", secretRowMap.azureOpenAiApiKey3),
    localLlmApiKey: resolveSecretValue("localLlmApiKey", secretRowMap.localLlmApiKey),
    braveApiKey: resolveSecretValue("braveApiKey", secretRowMap.braveApiKey),
    exaApiKey: resolveSecretValue("exaApiKey", secretRowMap.exaApiKey),
  };

  const secretStatuses = {
    openaiApiKey: {
      configured: Boolean(resolvedSecrets.openaiApiKey?.value),
      source: resolvedSecrets.openaiApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.openaiApiKey?.value),
      updatedAt: resolvedSecrets.openaiApiKey?.updatedAt ?? null,
    },
    azureOpenAiApiKey: {
      configured: Boolean(resolvedSecrets.azureOpenAiApiKey?.value),
      source: resolvedSecrets.azureOpenAiApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.azureOpenAiApiKey?.value),
      updatedAt: resolvedSecrets.azureOpenAiApiKey?.updatedAt ?? null,
    },
    azureOpenAiApiKey2: {
      configured: Boolean(resolvedSecrets.azureOpenAiApiKey2?.value),
      source: resolvedSecrets.azureOpenAiApiKey2?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.azureOpenAiApiKey2?.value),
      updatedAt: resolvedSecrets.azureOpenAiApiKey2?.updatedAt ?? null,
    },
    azureOpenAiApiKey3: {
      configured: Boolean(resolvedSecrets.azureOpenAiApiKey3?.value),
      source: resolvedSecrets.azureOpenAiApiKey3?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.azureOpenAiApiKey3?.value),
      updatedAt: resolvedSecrets.azureOpenAiApiKey3?.updatedAt ?? null,
    },
    localLlmApiKey: {
      configured: Boolean(resolvedSecrets.localLlmApiKey?.value),
      source: resolvedSecrets.localLlmApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.localLlmApiKey?.value),
      updatedAt: resolvedSecrets.localLlmApiKey?.updatedAt ?? null,
    },
    braveApiKey: {
      configured: Boolean(resolvedSecrets.braveApiKey?.value),
      source: resolvedSecrets.braveApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.braveApiKey?.value),
      updatedAt: resolvedSecrets.braveApiKey?.updatedAt ?? null,
    },
    exaApiKey: {
      configured: Boolean(resolvedSecrets.exaApiKey?.value),
      source: resolvedSecrets.exaApiKey?.source ?? "none",
      maskedValue: maskSecret(resolvedSecrets.exaApiKey?.value),
      updatedAt: resolvedSecrets.exaApiKey?.updatedAt ?? null,
    },
    bedrockCredential: resolveBedrockCredentialStatus(settings),
  };

  applyRuntimeSettingsToProcess(settings, resolvedSecrets);
  const view = buildRuntimeSettingsView(settings, secretStatuses);
  runtimeSettingsCache = {
    loadedAt: new Date(),
    revision: documentRow?.schemaVersion ?? 0,
    settings,
    view,
    sources: buildSourceMap(view),
  };
}

export async function ensureRuntimeSettingsLoaded(): Promise<void> {
  if (runtimeSettingsCache.loadedAt) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }
  loadingPromise = loadRuntimeSettingsInternal()
    .catch(() => {
      const fallback = defaultCache();
      applyRuntimeSettingsToProcess(fallback.settings, {
        openaiApiKey: fallback.view.providers.openai.apiKeySecret.configured
          ? { value: bootstrap.secrets.openaiApiKey ?? "", source: "env", updatedAt: null }
          : null,
        azureOpenAiApiKey: fallback.view.providers["azure-openai"].apiKeySecret.configured
          ? { value: bootstrap.secrets.azureOpenAiApiKey ?? "", source: "env", updatedAt: null }
          : null,
        azureOpenAiApiKey2: fallback.view.providers["azure-openai"].apiKeySecrets[1]?.configured
          ? { value: bootstrap.secrets.azureOpenAiApiKey2 ?? "", source: "env", updatedAt: null }
          : null,
        azureOpenAiApiKey3: fallback.view.providers["azure-openai"].apiKeySecrets[2]?.configured
          ? { value: bootstrap.secrets.azureOpenAiApiKey3 ?? "", source: "env", updatedAt: null }
          : null,
        localLlmApiKey: fallback.view.providers["local-llm"].apiKeySecret.configured
          ? { value: bootstrap.secrets.localLlmApiKey ?? "", source: "env", updatedAt: null }
          : null,
        braveApiKey: fallback.view.search.providers.brave.apiKeySecret.configured
          ? { value: bootstrap.secrets.braveApiKey ?? "", source: "env", updatedAt: null }
          : null,
        exaApiKey: fallback.view.search.providers.exa.apiKeySecret.configured
          ? { value: bootstrap.secrets.exaApiKey ?? "", source: "env", updatedAt: null }
          : null,
      });
      runtimeSettingsCache = { ...fallback, loadedAt: new Date() };
    })
    .finally(() => {
      loadingPromise = null;
    });
  await loadingPromise;
}

export function getRuntimeSettingsSnapshot(): RuntimeSettingsEditable {
  return runtimeSettingsCache.settings;
}

export function getRuntimeSettingsViewSnapshot(): {
  settings: RuntimeSettingsView;
  effective: RuntimeSettingsView;
  sources: Record<string, string>;
  revision: number;
  loadedAt: string | null;
} {
  return {
    settings: runtimeSettingsCache.view,
    effective: runtimeSettingsCache.view,
    sources: runtimeSettingsCache.sources,
    revision: runtimeSettingsCache.revision,
    loadedAt: runtimeSettingsCache.loadedAt?.toISOString() ?? null,
  };
}

export function invalidateRuntimeSettingsCache(): void {
  runtimeSettingsCache = defaultCache();
}

export async function reloadRuntimeSettingsCache(): Promise<void> {
  invalidateRuntimeSettingsCache();
  await ensureRuntimeSettingsLoaded();
}

function normalizeSecretKey(value: string): RuntimeSecretKey | null {
  return secretRowKeys.includes(value as RuntimeSecretKey) ? (value as RuntimeSecretKey) : null;
}

export async function saveRuntimeSettings(
  input: RuntimeSettingsUpdateRequest,
): Promise<{ revision: number; updatedAt: string }> {
  const parsed = runtimeSettingsEditableSchema.parse(input.settings);
  const existing = await findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY);
  const nextRevision = Math.max(1, (existing?.schemaVersion ?? 0) + 1);

  const written = await upsertSettingsRow({
    namespace: SETTINGS_DOCUMENT_NAMESPACE,
    key: SETTINGS_DOCUMENT_KEY,
    value: { settings: parsed },
    schemaVersion: nextRevision,
    updatedBy: input.updatedBy ?? null,
    description: "Runtime settings control-plane document",
    valueKind: "json",
  });

  if (input.secrets) {
    for (const [rawKey, update] of Object.entries(input.secrets)) {
      const key = normalizeSecretKey(rawKey);
      if (!key) continue;
      if (update.clear) {
        await deleteSettingsRow(SETTINGS_SECRET_NAMESPACE, key);
        continue;
      }
      const value = update.value?.trim();
      if (!value) continue;
      await upsertSettingsRow({
        namespace: SETTINGS_SECRET_NAMESPACE,
        key,
        value: { value },
        schemaVersion: nextRevision,
        updatedBy: input.updatedBy ?? null,
        description: `Secret for ${key}`,
        valueKind: "encrypted",
        isSecret: true,
      });
    }
  }

  await reloadRuntimeSettingsCache();
  return {
    revision: written.schemaVersion,
    updatedAt: written.updatedAt.toISOString(),
  };
}

export function resolveFindCandidateRoute(
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest",
): RuntimeSettingsRoute {
  return targetKind === "vibe_memory"
    ? runtimeSettingsCache.settings.taskRouting.findCandidate.vibe
    : runtimeSettingsCache.settings.taskRouting.findCandidate.source;
}

export function resolveFindCandidateThrottlingSettings(): RuntimeSettingsEditable["taskRouting"]["findCandidate"]["throttling"] {
  return runtimeSettingsCache.settings.taskRouting.findCandidate.throttling;
}

export function resolveWebSourceResearchRoute(): RuntimeSettingsRoute {
  return runtimeSettingsCache.settings.taskRouting.webSourceResearch;
}

export function resolveDistillationTargetPriorityOrder(): DistillationPriorityTargetKind[] {
  return [
    ...normalizeDistillationTargetPriorityOrder(
      runtimeSettingsCache.settings.general.distillationPriority.targetPriorityOrder,
    ),
  ];
}

export function resolveCoverEvidenceRoutes(): {
  sourceSupport: RuntimeSettingsRoute;
  externalEvidence: RuntimeSettingsRoute;
  mcpEvidence: RuntimeSettingsRoute;
} {
  return runtimeSettingsCache.settings.taskRouting.coverEvidence;
}

export function resolveAgenticCompileRouting(): RuntimeSettingsEditable["taskRouting"]["agenticCompile"] {
  return runtimeSettingsCache.settings.taskRouting.agenticCompile;
}

export function buildDefaultSettingsForSeed(): RuntimeSettingsEditable {
  const defaults = cloneDefaultSettings();
  defaults.distillationRuntime.toolTimeoutMs = APP_CONSTANTS.distillationToolTimeoutMs;
  defaults.search.timeoutMs = APP_CONSTANTS.distillationToolTimeoutMs;
  return defaults;
}
