import { groupedConfig } from "../../../config.js";

export type AzureOpenAiRuntimeDeployment = {
  apiKey: string;
  apiBaseUrl: string;
  apiPath: string;
  apiVersion: string;
  model: string;
};

export type AzureOpenAiRuntimeDeploymentSlot = {
  index: number;
  configured: boolean;
  apiBaseUrl: string;
  apiPath: string;
  apiVersion: string;
  model: string;
};

export type AzureOpenAiDeploymentAuditLabel = {
  label: string;
  host: string;
  model: string;
};

const azureOpenAiDeploymentCooldowns = new Map<string, number>();
let azureOpenAiNextDeploymentIndex = 0;
const AZURE_OPENAI_SLOT_COUNT = 3;

function normalizeDeployment(
  deployment: Partial<AzureOpenAiRuntimeDeployment>,
): AzureOpenAiRuntimeDeployment | null {
  const apiKey = deployment.apiKey?.trim() ?? "";
  const apiBaseUrl = deployment.apiBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  const apiPath = deployment.apiPath?.trim() || "/openai/deployments";
  const apiVersion = deployment.apiVersion?.trim() || groupedConfig.azureOpenAi.apiVersion;
  const model = deployment.model?.trim() ?? "";
  if (!apiKey || !apiBaseUrl || !model) return null;
  return { apiKey, apiBaseUrl, apiPath, apiVersion, model };
}

function slotCandidate(index: number): Partial<AzureOpenAiRuntimeDeployment> | null {
  if (!Number.isInteger(index) || index < 0 || index >= AZURE_OPENAI_SLOT_COUNT) return null;
  const deployment = groupedConfig.azureOpenAi.deployments?.[index];
  if (deployment) return deployment;
  if (index === 0) {
    return {
      apiKey: groupedConfig.azureOpenAi.apiKey,
      apiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
      apiPath: groupedConfig.azureOpenAi.apiPath,
      apiVersion: groupedConfig.azureOpenAi.apiVersion,
      model: groupedConfig.azureOpenAi.model,
    };
  }
  return {
    apiKey: "",
    apiBaseUrl: "",
    apiPath: groupedConfig.azureOpenAi.apiPath,
    apiVersion: groupedConfig.azureOpenAi.apiVersion,
    model: "",
  };
}

export function azureOpenAiDeploymentKey(deployment: AzureOpenAiRuntimeDeployment): string {
  return [
    deployment.apiBaseUrl,
    deployment.apiPath,
    deployment.apiVersion,
    deployment.model,
    deployment.apiKey,
  ].join("\n");
}

function configuredRateLimitCooldownSeconds(): number {
  const configured = groupedConfig.distillation.findCandidateRateLimitCooldownSeconds;
  return Number.isFinite(configured) && configured > 0 ? configured : 600;
}

function retryAfterSecondsFromError(error: unknown): number | null {
  const retryAfter = (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
  return typeof retryAfter === "number" && Number.isFinite(retryAfter)
    ? Math.max(0, retryAfter)
    : null;
}

function isDeploymentCoolingDown(deployment: AzureOpenAiRuntimeDeployment): boolean {
  const until = azureOpenAiDeploymentCooldowns.get(azureOpenAiDeploymentKey(deployment));
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  azureOpenAiDeploymentCooldowns.delete(azureOpenAiDeploymentKey(deployment));
  return false;
}

function rotateDeployments(
  deployments: AzureOpenAiRuntimeDeployment[],
): AzureOpenAiRuntimeDeployment[] {
  if (deployments.length <= 1) return deployments;
  const start = azureOpenAiNextDeploymentIndex % deployments.length;
  azureOpenAiNextDeploymentIndex = (start + 1) % deployments.length;
  return [...deployments.slice(start), ...deployments.slice(0, start)];
}

function deploymentsAfterPinned(
  deployments: AzureOpenAiRuntimeDeployment[],
  pinnedDeployment: AzureOpenAiRuntimeDeployment,
): AzureOpenAiRuntimeDeployment[] {
  const pinnedKey = azureOpenAiDeploymentKey(pinnedDeployment);
  const pinnedIndex = deployments.findIndex(
    (deployment) => azureOpenAiDeploymentKey(deployment) === pinnedKey,
  );
  if (pinnedIndex < 0) return rotateDeployments(deployments);
  return [
    deployments[pinnedIndex],
    ...deployments.slice(pinnedIndex + 1),
    ...deployments.slice(0, pinnedIndex),
  ];
}

export function configuredAzureOpenAiDeployments(): AzureOpenAiRuntimeDeployment[] {
  const deployments: AzureOpenAiRuntimeDeployment[] = [];
  const seen = new Set<string>();
  const candidates = [
    {
      apiKey: groupedConfig.azureOpenAi.apiKey,
      apiBaseUrl: groupedConfig.azureOpenAi.apiBaseUrl,
      apiPath: groupedConfig.azureOpenAi.apiPath,
      apiVersion: groupedConfig.azureOpenAi.apiVersion,
      model: groupedConfig.azureOpenAi.model,
    },
    ...(groupedConfig.azureOpenAi.deployments ?? []),
  ];

  for (const candidate of candidates) {
    const deployment = normalizeDeployment(candidate);
    if (!deployment) continue;
    const key = azureOpenAiDeploymentKey(deployment);
    if (seen.has(key)) continue;
    seen.add(key);
    deployments.push(deployment);
    if (deployments.length >= 3) break;
  }
  return deployments;
}

function normalizeRequestedSlotIndexes(selectedSlots: number[] | undefined): number[] {
  if (!Array.isArray(selectedSlots) || selectedSlots.length === 0) return [];
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const raw of selectedSlots) {
    if (!Number.isInteger(raw)) continue;
    const slot = raw;
    if (slot < 1 || slot > AZURE_OPENAI_SLOT_COUNT) continue;
    const index = slot - 1;
    if (seen.has(index)) continue;
    seen.add(index);
    normalized.push(index);
  }
  return normalized;
}

export function configuredAzureOpenAiDeploymentsForSlots(
  selectedSlots?: number[],
): AzureOpenAiRuntimeDeployment[] {
  if (!Array.isArray(selectedSlots) || selectedSlots.length === 0) {
    return configuredAzureOpenAiDeployments();
  }
  const slotIndexes = normalizeRequestedSlotIndexes(selectedSlots);
  if (slotIndexes.length === 0) return [];
  const deployments: AzureOpenAiRuntimeDeployment[] = [];
  const seen = new Set<string>();
  for (const index of slotIndexes) {
    const deployment = azureOpenAiDeploymentAt(index);
    if (!deployment) continue;
    const key = azureOpenAiDeploymentKey(deployment);
    if (seen.has(key)) continue;
    seen.add(key);
    deployments.push(deployment);
  }
  return deployments;
}

export function primaryAzureOpenAiDeployment(): AzureOpenAiRuntimeDeployment | null {
  return configuredAzureOpenAiDeployments()[0] ?? null;
}

export function azureOpenAiDeploymentAt(index: number): AzureOpenAiRuntimeDeployment | null {
  const candidate = slotCandidate(index);
  return candidate ? normalizeDeployment(candidate) : null;
}

export function azureOpenAiDeploymentSlot(index: number): AzureOpenAiRuntimeDeploymentSlot | null {
  const candidate = slotCandidate(index);
  if (!candidate) return null;
  const apiBaseUrl = candidate.apiBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  const apiPath = candidate.apiPath?.trim() || "/openai/deployments";
  const apiVersion = candidate.apiVersion?.trim() || groupedConfig.azureOpenAi.apiVersion;
  const model = candidate.model?.trim() ?? "";
  return {
    index,
    configured: Boolean(normalizeDeployment(candidate)),
    apiBaseUrl,
    apiPath,
    apiVersion,
    model,
  };
}

export function configuredAzureOpenAiDeploymentSlots(): AzureOpenAiRuntimeDeploymentSlot[] {
  return [0, 1, 2]
    .map((index) => azureOpenAiDeploymentSlot(index))
    .filter((slot): slot is AzureOpenAiRuntimeDeploymentSlot => Boolean(slot?.configured));
}

export function isAzureOpenAiConfigured(): boolean {
  return configuredAzureOpenAiDeployments().length > 0;
}

export function azureOpenAiDeploymentsForTask(
  pinnedDeployment: AzureOpenAiRuntimeDeployment | null = null,
  selectedSlots?: number[],
): AzureOpenAiRuntimeDeployment[] {
  const deployments = configuredAzureOpenAiDeploymentsForSlots(selectedSlots);
  if (deployments.length === 0) return [];

  const ordered = pinnedDeployment
    ? deploymentsAfterPinned(deployments, pinnedDeployment)
    : rotateDeployments(deployments);
  return ordered.filter((deployment) => !isDeploymentCoolingDown(deployment));
}

export function markAzureOpenAiDeploymentRateLimited(
  deployment: AzureOpenAiRuntimeDeployment,
  error: unknown,
): void {
  const retryAfterSeconds =
    retryAfterSecondsFromError(error) ?? configuredRateLimitCooldownSeconds();
  azureOpenAiDeploymentCooldowns.set(
    azureOpenAiDeploymentKey(deployment),
    Date.now() + retryAfterSeconds * 1000,
  );
}

export function markAzureOpenAiDeploymentSucceeded(deployment: AzureOpenAiRuntimeDeployment): void {
  const deployments = configuredAzureOpenAiDeployments();
  if (deployments.length <= 1) return;
  const succeededKey = azureOpenAiDeploymentKey(deployment);
  const succeededIndex = deployments.findIndex(
    (candidate) => azureOpenAiDeploymentKey(candidate) === succeededKey,
  );
  if (succeededIndex < 0) return;
  azureOpenAiNextDeploymentIndex = (succeededIndex + 1) % deployments.length;
}

export function azureOpenAiCooldownError(): Error {
  const activeUntil = [...azureOpenAiDeploymentCooldowns.values()].filter(
    (until) => until > Date.now(),
  );
  const earliest = activeUntil.length ? Math.min(...activeUntil) : null;
  const suffix = earliest ? ` until ${new Date(earliest).toISOString()}` : "";
  return new Error(`Azure OpenAI deployments are cooling down${suffix}`);
}

export function resetAzureOpenAiDeploymentPoolForTests(): void {
  azureOpenAiDeploymentCooldowns.clear();
  azureOpenAiNextDeploymentIndex = 0;
}

export function buildAzureOpenAiChatUrl(deployment: AzureOpenAiRuntimeDeployment): string {
  const path = `${deployment.apiPath.replace(/\/+$/, "")}/${encodeURIComponent(
    deployment.model,
  )}/chat/completions?api-version=${encodeURIComponent(deployment.apiVersion)}`;
  return new URL(path, deployment.apiBaseUrl).toString();
}

export function azureOpenAiHeaders(deployment: AzureOpenAiRuntimeDeployment): HeadersInit {
  return {
    "api-key": deployment.apiKey,
    "content-type": "application/json",
  };
}

function deploymentHost(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).host;
  } catch {
    return apiBaseUrl;
  }
}

export function azureOpenAiDeploymentAuditLabel(
  deployment: AzureOpenAiRuntimeDeployment,
): AzureOpenAiDeploymentAuditLabel {
  const configured = configuredAzureOpenAiDeployments();
  const key = azureOpenAiDeploymentKey(deployment);
  const index = configured.findIndex((candidate) => azureOpenAiDeploymentKey(candidate) === key);
  const label = index >= 0 ? `deployment${index + 1}` : "deployment";
  return {
    label,
    host: deploymentHost(deployment.apiBaseUrl),
    model: deployment.model,
  };
}
