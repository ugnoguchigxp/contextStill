import { APP_CONSTANTS } from "../../constants.js";
import { applyProviderLeaseRouteContext } from "./provider-lease-route-context.js";
import { SecretStoreError, resolveSecretRows } from "./secret-store.client.js";
import { saveSecretUpdate } from "./settings-secret.service.js";
import {
  bootstrap,
  cloneDefaultSettings,
  normalizeDistillationTargetPriorityOrder,
  normalizeRuntimeSettingsEditable,
  parseDocumentValue,
  secretRowKeys,
} from "./settings.defaults.js";
import {
  SETTINGS_DOCUMENT_KEY,
  SETTINGS_DOCUMENT_NAMESPACE,
  SETTINGS_SECRET_NAMESPACE,
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
  type RuntimeProviderPool,
  type RuntimeSecretKey,
  type RuntimeSecretStatus,
  type RuntimeSettingsEditable,
  type RuntimeSettingsUpdateRequest,
  type RuntimeSettingsView,
  type StaticRuntimeSettingsRoute,
  requireStaticRuntimeSettingsRoute,
  runtimeSettingsEditableSchema,
} from "./settings.types.js";

let runtimeSettingsCache: RuntimeSettingsCache = defaultCache();
let loadingPromise: Promise<void> | null = null;

function localLlmSecretKey(index: number): RuntimeSecretKey {
  if (index === 0) return "localLlmApiKey";
  return `localLlmApiKey${index + 1}`;
}

async function loadRuntimeSettingsInternal(): Promise<void> {
  const [documentRow, secretRows] = await Promise.all([
    findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY),
    listSettingsRows(SETTINGS_SECRET_NAMESPACE),
  ]);

  const settings = parseDocumentValue(documentRow);
  const secretRowMap = buildSecretMap(
    await resolveSecretRows(secretRows, undefined, { isolateFailures: true }),
  );
  const resolvedSecrets: Partial<Record<RuntimeSecretKey, ReturnType<typeof resolveSecretValue>>> =
    {
      openaiApiKey: resolveSecretValue("openaiApiKey", secretRowMap.openaiApiKey),
      azureOpenAiApiKey: resolveSecretValue("azureOpenAiApiKey", secretRowMap.azureOpenAiApiKey),
      azureOpenAiApiKey2: resolveSecretValue("azureOpenAiApiKey2", secretRowMap.azureOpenAiApiKey2),
      azureOpenAiApiKey3: resolveSecretValue("azureOpenAiApiKey3", secretRowMap.azureOpenAiApiKey3),
      localLlmApiKey: resolveSecretValue("localLlmApiKey", secretRowMap.localLlmApiKey),
      braveApiKey: resolveSecretValue("braveApiKey", secretRowMap.braveApiKey),
      exaApiKey: resolveSecretValue("exaApiKey", secretRowMap.exaApiKey),
    };
  for (const [index] of settings.providers["azure-openai"].deployments.entries()) {
    const key =
      index === 0 ? "azureOpenAiApiKey" : (`azureOpenAiApiKey${index + 1}` as RuntimeSecretKey);
    resolvedSecrets[key] = resolveSecretValue(key, secretRowMap[key]);
  }
  for (const [index] of settings.providers["local-llm"].models.entries()) {
    const key = localLlmSecretKey(index);
    resolvedSecrets[key] = resolveSecretValue(key, secretRowMap[key]);
  }

  const secretStatus = (key: RuntimeSecretKey): RuntimeSecretStatus => {
    const secret = resolvedSecrets[key];
    return {
      configured: Boolean(secret?.value),
      source: secret?.source ?? "none",
      maskedValue: maskSecret(secret?.value),
      updatedAt: secret?.updatedAt ?? null,
      ...(secret?.error ? { error: secret.error } : {}),
    };
  };
  const secretStatuses = {
    openaiApiKey: secretStatus("openaiApiKey"),
    azureOpenAiApiKey: secretStatus("azureOpenAiApiKey"),
    azureOpenAiApiKeys: settings.providers["azure-openai"].deployments.map((_deployment, index) =>
      secretStatus(index === 0 ? "azureOpenAiApiKey" : `azureOpenAiApiKey${index + 1}`),
    ),
    localLlmApiKey: secretStatus("localLlmApiKey"),
    localLlmApiKeys: settings.providers["local-llm"].models.map((_model, index) =>
      secretStatus(localLlmSecretKey(index)),
    ),
    braveApiKey: secretStatus("braveApiKey"),
    exaApiKey: secretStatus("exaApiKey"),
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
    .catch((error) => {
      if (error instanceof SecretStoreError) {
        applyRuntimeSettingsToProcess(runtimeSettingsCache.settings, {});
        throw error;
      }
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
  if (secretRowKeys.includes(value as RuntimeSecretKey)) return value as RuntimeSecretKey;
  if (/^azureOpenAiApiKey[1-9]\d*$/.test(value)) return value as RuntimeSecretKey;
  if (/^localLlmApiKey[1-9]\d*$/.test(value)) return value as RuntimeSecretKey;
  return null;
}

export async function saveRuntimeSettings(
  input: RuntimeSettingsUpdateRequest,
): Promise<{ revision: number; updatedAt: string }> {
  const parsed = runtimeSettingsEditableSchema.parse(input.settings);
  const normalized = normalizeRuntimeSettingsEditable(parsed);
  const existing = await findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY);
  const nextRevision = Math.max(1, (existing?.schemaVersion ?? 0) + 1);

  if (input.secrets) {
    for (const [rawKey, update] of Object.entries(input.secrets)) {
      const key = normalizeSecretKey(rawKey);
      if (!key) continue;
      try {
        await saveSecretUpdate(key, update, input.updatedBy ?? null);
      } finally {
        // Invalidate even after a partially completed update or failed cleanup.
        invalidateRuntimeSettingsCache();
        applyRuntimeSettingsToProcess(normalized, {});
      }
    }
  }

  const written = await upsertSettingsRow({
    namespace: SETTINGS_DOCUMENT_NAMESPACE,
    key: SETTINGS_DOCUMENT_KEY,
    value: { settings: normalized },
    schemaVersion: nextRevision,
    updatedBy: input.updatedBy ?? null,
    description: "Runtime settings control-plane document",
    valueKind: "json",
  });

  await reloadRuntimeSettingsCache();
  return {
    revision: written.schemaVersion,
    updatedAt: written.updatedAt.toISOString(),
  };
}

export function resolveFindCandidateRoute(
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest",
): StaticRuntimeSettingsRoute {
  const route =
    targetKind === "vibe_memory"
      ? runtimeSettingsCache.settings.taskRouting.findCandidate.vibe
      : runtimeSettingsCache.settings.taskRouting.findCandidate.source;
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(runtimeSettingsCache.settings, route),
  );
}

export function resolveFindCandidateThrottlingSettings(): RuntimeSettingsEditable["taskRouting"]["findCandidate"]["throttling"] {
  return runtimeSettingsCache.settings.taskRouting.findCandidate.throttling;
}

export function resolveWebSourceResearchRoute(): StaticRuntimeSettingsRoute {
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(
      runtimeSettingsCache.settings,
      runtimeSettingsCache.settings.taskRouting.webSourceResearch,
    ),
  );
}

export function resolveEpisodeDistillerRoute(): StaticRuntimeSettingsRoute {
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(
      runtimeSettingsCache.settings,
      runtimeSettingsCache.settings.taskRouting.episodeDistiller,
    ),
  );
}

export function resolveDistillationTargetPriorityOrder(): DistillationPriorityTargetKind[] {
  return [
    ...normalizeDistillationTargetPriorityOrder(
      runtimeSettingsCache.settings.general.distillationPriority.targetPriorityOrder,
    ),
  ];
}

export function resolveCoverEvidenceRoutes(): {
  sourceSupport: StaticRuntimeSettingsRoute;
  externalEvidence: StaticRuntimeSettingsRoute;
  mcpEvidence: StaticRuntimeSettingsRoute;
} {
  const routes = runtimeSettingsCache.settings.taskRouting.coverEvidence;
  return {
    sourceSupport: requireStaticRuntimeSettingsRoute(
      applyProviderLeaseRouteContext(runtimeSettingsCache.settings, routes.sourceSupport),
    ),
    externalEvidence: requireStaticRuntimeSettingsRoute(
      applyProviderLeaseRouteContext(runtimeSettingsCache.settings, routes.externalEvidence),
    ),
    mcpEvidence: requireStaticRuntimeSettingsRoute(
      applyProviderLeaseRouteContext(runtimeSettingsCache.settings, routes.mcpEvidence),
    ),
  };
}

export function resolveDeadZoneMergeReviewRoute(): StaticRuntimeSettingsRoute {
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(
      runtimeSettingsCache.settings,
      runtimeSettingsCache.settings.taskRouting.deadZoneMergeReview,
    ),
  );
}

export function resolveLandscapeCurationRoute(): StaticRuntimeSettingsRoute {
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(
      runtimeSettingsCache.settings,
      runtimeSettingsCache.settings.taskRouting.landscapeCuration,
    ),
  );
}

export function resolveFinalizeDistilleRoute(): StaticRuntimeSettingsRoute {
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(
      runtimeSettingsCache.settings,
      runtimeSettingsCache.settings.taskRouting.finalizeDistille,
    ),
  );
}

export function resolveMergeActivationFinalizeRoute(): StaticRuntimeSettingsRoute {
  return requireStaticRuntimeSettingsRoute(
    applyProviderLeaseRouteContext(
      runtimeSettingsCache.settings,
      runtimeSettingsCache.settings.taskRouting.mergeActivationFinalize,
    ),
  );
}

export function resolveProviderPools(): RuntimeProviderPool[] {
  return runtimeSettingsCache.settings.providerPools.map((pool) => ({
    ...pool,
    targets: pool.targets.map((target) => ({ ...target })),
    maxConcurrent: Math.max(1, Math.min(pool.maxConcurrent, pool.targets.length)),
  }));
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
