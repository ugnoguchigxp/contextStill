import type {
  ConnectionInput,
  ConnectionRow,
  CredentialUpdate,
  SectionPatch,
} from "./connection-contracts.js";
import {
  azureSecretKey,
  connectionLabels,
  localConnectionModel,
  localSecretKey,
  routeEntries,
} from "./connection-contracts.js";
import { secretStoreClient } from "./secret-store.client.js";
import { normalizeRuntimeSettingsEditable } from "./settings.defaults.js";
import { SETTINGS_SECRET_NAMESPACE, findSettingsRow } from "./settings.repository.js";
import { resolveSecretValue } from "./settings.runtime-cache.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsViewSnapshot,
  reloadRuntimeSettingsCache,
} from "./settings.service.js";
import {
  type RuntimeSecretKey,
  type RuntimeSecretStatus,
  type RuntimeSettingsEditable,
  runtimeSettingsEditableSchema,
} from "./settings.types.js";

import {
  SettingsConflict,
  mutateSettings as commitSettingsMutation,
  currentSettings,
} from "./settings-mutations.service.js";
export {
  SettingsConflict,
  currentSettings,
  fingerprint,
  getSettingsOperation,
} from "./settings-mutations.service.js";
const emptyCredential: RuntimeSecretStatus = {
  configured: false,
  source: "none",
  maskedValue: null,
  updatedAt: null,
};
export function connectionRows(
  settings: RuntimeSettingsEditable,
  credentials: Record<string, RuntimeSecretStatus> = {},
): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  const add = (row: Omit<ConnectionRow, "credential" | "references">) =>
    rows.push({
      ...row,
      credential: row.credentialKey
        ? (credentials[row.credentialKey] ?? emptyCredential)
        : emptyCredential,
      references: [],
    });
  const p = settings.providers;
  for (const kind of ["openai", "bedrock", "codex"] as const) {
    const value = p[kind];
    if (!value.model.trim() || (kind === "openai" && !p.openai.apiBaseUrl.trim())) continue;
    add({
      id: kind,
      kind,
      name: connectionLabels[kind],
      model: value.model,
      endpoint:
        kind === "openai"
          ? p.openai.apiBaseUrl
          : kind === "bedrock"
            ? p.bedrock.region
            : "Codex SDK",
      fields: { ...value },
      enabled: value.enabled,
      credentialKey: kind === "openai" ? "openaiApiKey" : undefined,
    });
  }
  p["azure-openai"].deployments.forEach((d, index) => {
    if (!d.apiBaseUrl.trim() && !d.model.trim()) return;
    add({
      id: d.id ?? `azure-deployment-${index + 1}`,
      kind: "azure-openai",
      name: d.name || `Azure ${index + 1}`,
      model: d.model,
      endpoint: d.apiBaseUrl,
      fields: { ...d, enabled: p["azure-openai"].enabled },
      enabled: p["azure-openai"].enabled,
      credentialKey: d.credentialMode === "shared" ? azureSecretKey(0) : azureSecretKey(index),
    });
  });
  p["local-llm"].models.forEach((d, index) => {
    if (!d.apiBaseUrl.trim() && !d.model.trim()) return;
    add({
      id: d.id ?? `local-model-${index + 1}`,
      kind: "local-llm",
      name: d.name || d.model,
      model: d.model,
      endpoint: d.apiBaseUrl,
      fields: { ...d, enabled: p["local-llm"].enabled },
      enabled: p["local-llm"].enabled,
      credentialKey: localSecretKey(index),
    });
  });
  for (const d of p["larm-agent-connection"].connections)
    add({
      id: d.id,
      kind: "larm-agent-connection",
      name: d.id,
      model: "LARMから取得",
      endpoint: d.controlBaseUrl,
      fields: { ...d, enabled: p["larm-agent-connection"].enabled },
      enabled: p["larm-agent-connection"].enabled,
      credentialKey: "larmApiToken",
    });
  for (const row of rows) {
    const index =
      row.kind === "azure-openai"
        ? p["azure-openai"].deployments.findIndex((d) => d.id === row.id)
        : -1;
    const matches = (
      route: RuntimeSettingsEditable["taskRouting"]["findCandidate"]["source"],
    ): boolean => {
      if (route.kind === "larm-agent-connection")
        return row.kind === "larm-agent-connection" && route.connectionId === row.id;
      if (route.providerPoolId)
        return (
          settings.providerPools
            .find((pool) => pool.id === route.providerPoolId)
            ?.targets.some(
              (t) =>
                t.provider === row.kind &&
                (t.provider === "larm-agent-connection"
                  ? t.connectionId === row.id
                  : t.provider === "local-llm"
                    ? t.localLlmModelId === row.id
                    : t.provider === "azure-openai"
                      ? t.deploymentSlot === index + 1
                      : true),
            ) ?? false
        );
      if (route.fallback.includes(row.kind as never)) return true;
      if (route.provider !== row.kind) return false;
      if (row.kind === "azure-openai")
        return (
          !route.azureDeploymentSlots?.length || route.azureDeploymentSlots.includes(index + 1)
        );
      if (row.kind === "local-llm") {
        const value = route.localLlmModel ?? route.model;
        if (!value) return true;
        try {
          const parsed = JSON.parse(value);
          return (
            parsed.model === row.model &&
            parsed.apiBaseUrl?.replace(/\/+$/, "") === row.endpoint.replace(/\/+$/, "") &&
            (!parsed.apiPath || parsed.apiPath === row.fields.apiPath)
          );
        } catch {
          return [row.id, row.name, row.model].includes(value);
        }
      }
      return true;
    };
    row.references = routeEntries(settings)
      .filter(([, route]) => matches(route))
      .map(([path]) => path);
    for (const pool of settings.providerPools)
      if (
        pool.targets.some(
          (t) =>
            t.provider === row.kind &&
            (t.provider === "larm-agent-connection"
              ? t.connectionId === row.id
              : t.provider === "local-llm"
                ? t.localLlmModelId === row.id
                : t.provider === "azure-openai"
                  ? t.deploymentSlot === index + 1
                  : true),
        )
      )
        row.references.push(`Pool: ${pool.label}`);
  }
  return rows.sort((a, b) => connectionLabels[a.kind].localeCompare(connectionLabels[b.kind]));
}
export async function connectionListing() {
  await reloadRuntimeSettingsCache();
  const { settings, revision } = await currentSettings();
  const statuses: Record<string, RuntimeSecretStatus> = {};
  const view = getRuntimeSettingsViewSnapshot().settings;
  statuses.openaiApiKey = view.providers.openai.apiKeySecret;
  view.providers["azure-openai"].apiKeySecrets.forEach((s, i) => {
    statuses[azureSecretKey(i)] = s;
  });
  view.providers["local-llm"].apiKeySecrets.forEach((s, i) => {
    statuses[localSecretKey(i)] = s;
  });
  const larm = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "larmApiToken");
  statuses.larmApiToken = {
    configured: Boolean(larm?.secretRef || (!larm?.value.disabled && process.env.LARM_API_TOKEN)),
    source: larm?.secretRef
      ? "db"
      : process.env.LARM_API_TOKEN && !larm?.value.disabled
        ? "env"
        : "none",
    maskedValue: null,
    updatedAt: larm?.updatedAt.toISOString() ?? null,
  };
  const rows = connectionRows(settings, statuses);
  for (const row of rows)
    if (row.kind === "bedrock") row.credential = view.providers.bedrock.credentialSecret;
  return { connections: rows, revision };
}
export async function resolveConnectionCredential(row: ConnectionRow): Promise<string> {
  if (!row.credentialKey) return "";
  const stored = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, row.credentialKey);
  if (stored?.value.disabled) return "";
  if (stored?.secretRef) return secretStoreClient.get(row.credentialKey, stored.secretRef);
  if (row.credentialKey === "larmApiToken") return process.env.LARM_API_TOKEN ?? "";
  const entry = resolveSecretValue(row.credentialKey as RuntimeSecretKey, undefined);
  return entry?.value ?? "";
}
function safeMerge(current: unknown, changes: Record<string, unknown>): unknown {
  if (
    changes.kind === "larm-agent-connection" ||
    (typeof changes.provider === "string" && Array.isArray(changes.fallback))
  )
    return structuredClone(changes);
  const result = {
    ...(current && typeof current === "object" && !Array.isArray(current)
      ? (current as object)
      : {}),
  } as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error("invalid_setting_path");
    result[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? safeMerge(result[key], value as Record<string, unknown>)
        : value;
  }
  return result;
}
export async function mutateSettings<T>(...args: Parameters<typeof commitSettingsMutation<T>>) {
  const result = await commitSettingsMutation(...args);
  await reloadRuntimeSettingsCache();
  return result;
}
const connectionFieldKeys: Record<ConnectionRow["kind"], string[]> = {
  openai: ["apiBaseUrl", "model", "enabled"],
  bedrock: ["region", "profile", "model", "enabled"],
  codex: ["model", "enabled"],
  "azure-openai": ["name", "apiBaseUrl", "apiPath", "apiVersion", "model", "enabled"],
  "local-llm": ["name", "apiBaseUrl", "apiPath", "model", "enabled"],
  "larm-agent-connection": [
    "id",
    "controlBaseUrl",
    "audience",
    "availabilityPollMs",
    "availabilityTimeoutMs",
    "controlTimeoutMs",
    "readyTimeoutMs",
    "ttlSeconds",
    "requestTimeoutMs",
    "maxConcurrentRequests",
    "enabled",
  ],
};
export function applyConnectionInput(
  settings: RuntimeSettingsEditable,
  input: ConnectionInput,
  id?: string,
): ConnectionRow {
  const { enabled, ...fields } = input.fields;
  for (const key of Object.keys(fields))
    if (!connectionFieldKeys[input.kind].includes(key))
      throw new Error(`invalid_connection_field:${key}`);
  const kind = input.kind;
  const provider = settings.providers[kind];
  if (
    !id &&
    ["openai", "bedrock", "codex"].includes(kind) &&
    connectionRows(settings).some((r) => r.kind === kind)
  )
    throw new Error("connection_already_registered");
  const priorRow = id ? connectionRows(settings).find((r) => r.id === id) : undefined;
  const mergedFields = { ...priorRow?.fields, ...fields };
  if (kind !== "larm-agent-connection" && !String(mergedFields.model ?? "").trim())
    throw new Error("connection_model_required");
  if (["openai", "azure-openai", "local-llm"].includes(kind)) {
    let url: URL;
    try {
      url = new URL(String(mergedFields.apiBaseUrl ?? ""));
    } catch {
      throw new Error("connection_endpoint_required");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("connection_endpoint_invalid");
  }
  if (id) {
    const row = connectionRows(settings).find((r) => r.id === id);
    if (!row || row.kind !== kind) throw new Error("connection_not_found");
  }
  if (typeof enabled === "boolean") provider.enabled = enabled;
  let connectionId =
    id ??
    (kind === "openai" || kind === "bedrock" || kind === "codex"
      ? kind
      : `${kind}-${input.operationId}`);
  if (kind === "azure-openai" || kind === "local-llm") {
    const list =
      kind === "azure-openai"
        ? settings.providers[kind].deployments
        : settings.providers[kind].models;
    const index = id ? list.findIndex((d) => d.id === id) : -1;
    if (id && index < 0) throw new Error("connection_not_found");
    if (index < 0) list.push({ ...fields, id: connectionId } as never);
    else list[index] = { ...list[index], ...fields, id: connectionId } as never;
    const first = list[0];
    if (first)
      Object.assign(
        settings.providers[kind],
        { apiBaseUrl: first.apiBaseUrl, apiPath: first.apiPath, model: first.model },
        kind === "azure-openai"
          ? { apiVersion: (first as unknown as { apiVersion: string }).apiVersion }
          : {},
      );
    if (kind === "azure-openai") {
      const item = settings.providers[kind].deployments.find((d) => d.id === connectionId);
      if (!item) throw new Error("connection_not_found");
      if (input.credential.action === "inherit") {
        if (settings.providers[kind].deployments[0].id === connectionId)
          throw new Error("primary_key_cannot_inherit");
        item.credentialMode = "shared";
      } else if (input.credential.action !== "keep") item.credentialMode = "dedicated";
    }
  } else if (kind === "larm-agent-connection") {
    const list = settings.providers[kind].connections;
    if (id && fields.id !== undefined && fields.id !== id)
      throw new Error("connection_id_immutable");
    connectionId = id ?? (typeof fields.id === "string" ? fields.id : connectionId);
    const index = list.findIndex((d) => d.id === connectionId);
    if (!id && connectionRows(settings).some((row) => row.id === connectionId))
      throw new Error("connection_already_registered");
    if (index < 0) list.push({ ...fields, id: connectionId } as never);
    else list[index] = { ...list[index], ...fields, id: connectionId };
  } else Object.assign(provider, fields);
  const validated = runtimeSettingsEditableSchema.parse(settings);
  const row = connectionRows(validated).find((r) => r.id === connectionId);
  if (!row) throw new Error("connection_configuration_required");
  if (priorRow) {
    const oldLocal = localConnectionModel(priorRow);
    for (const [, route] of routeEntries(settings)) {
      if (route.kind === "larm-agent-connection") continue;
      if (kind === "local-llm") {
        const matches = (v: string | undefined) =>
          Boolean(v && [oldLocal, priorRow.id, priorRow.name, priorRow.model].includes(v));
        if (matches(route.localLlmModel)) route.localLlmModel = localConnectionModel(row);
        if (route.provider === kind && matches(route.model))
          route.model = localConnectionModel(row);
      } else if (route.provider === kind && route.model === priorRow.model) {
        if (
          kind !== "azure-openai" ||
          (route.azureDeploymentSlots?.length === 1 &&
            settings.providers[kind].deployments[route.azureDeploymentSlots[0] - 1]?.id === row.id)
        )
          route.model = row.model;
      }
    }
  }
  return row;
}
export async function saveConnection(input: ConnectionInput, id?: string) {
  return mutateSettings(
    input.expectedRevision,
    input.operationId,
    { input, id },
    (settings, secrets) => {
      const row = applyConnectionInput(settings, input, id);
      // Resolve the dedicated slot key even when switching to primary inheritance.
      const key =
        row.kind === "azure-openai"
          ? azureSecretKey(
              settings.providers["azure-openai"].deployments.findIndex((d) => d.id === row.id),
            )
          : row.credentialKey;
      if (input.credential.action !== "keep") {
        if (!key) throw new Error("credential_operation_not_supported");
        if (input.credential.action === "inherit" && row.kind !== "azure-openai")
          throw new Error("credential_operation_not_supported");
        secrets.set(key, input.credential);
      }
      return { id: row.id };
    },
  );
}
export async function patchSection(input: SectionPatch) {
  return mutateSettings(input.expectedRevision, input.operationId, input, (settings, secrets) => {
    const raw = settings as unknown as Record<string, unknown>;
    raw[input.section] =
      input.section === "providerPools"
        ? input.changes.value
        : safeMerge(raw[input.section], input.changes);
    const allowed = new Set(
      input.section === "search"
        ? ["braveApiKey", "exaApiKey"]
        : input.section === "advanced"
          ? [
              settings.advanced.agentRuntime?.research?.credentialKey,
              settings.advanced.agentRuntime?.research?.gatewayCredentialKey,
            ]
          : [],
    );
    for (const [key, update] of Object.entries(input.secrets ?? {})) {
      if (!allowed.has(key) || !/^[A-Za-z0-9]+$/.test(key))
        throw new Error("credential_key_not_allowed");
      if (update.action === "inherit") throw new Error("credential_operation_not_supported");
      secrets.set(key, update);
    }
    return { section: input.section };
  });
}
export async function deleteConnection(
  id: string,
  input: { expectedRevision: number; operationId: string },
) {
  return mutateSettings(
    input.expectedRevision,
    input.operationId,
    { id, input },
    async (settings, secrets) => {
      const row = connectionRows(settings).find((r) => r.id === id);
      if (!row) throw new Error("connection_not_found");
      if (row.references.length) throw new SettingsConflict("connection_in_use", row.references);
      if (row.kind === "azure-openai" || row.kind === "local-llm") {
        const kind = row.kind;
        const list =
          kind === "azure-openai"
            ? settings.providers[kind].deployments
            : settings.providers[kind].models;
        const index = list.findIndex((d) => d.id === id);
        const original = connectionRows(settings);
        // Read every source before preparing any replacement key.
        const values = await Promise.all(
          list.slice(index + 1).map((d) =>
            resolveConnectionCredential(
              original.find((r) => r.id === d.id) ??
                (() => {
                  throw new Error("connection_not_found");
                })(),
            ),
          ),
        );
        for (let i = index; i < list.length - 1; i++)
          secrets.set(
            kind === "azure-openai" ? azureSecretKey(i) : localSecretKey(i),
            values[i - index] ? { action: "set", value: values[i - index] } : { action: "clear" },
          );
        secrets.set(
          kind === "azure-openai"
            ? azureSecretKey(list.length - 1)
            : localSecretKey(list.length - 1),
          { action: "clear" },
        );
        list.splice(index, 1);
        if (kind === "azure-openai") {
          for (const [, route] of routeEntries(settings))
            if (route.kind !== "larm-agent-connection" && route.azureDeploymentSlots)
              route.azureDeploymentSlots = route.azureDeploymentSlots.map((s) =>
                s > index + 1 ? s - 1 : s,
              );
          for (const pool of settings.providerPools)
            for (const target of pool.targets)
              if (target.provider === "azure-openai" && target.deploymentSlot > index + 1)
                target.deploymentSlot--;
          if (index === 0)
            for (const d of settings.providers[kind].deployments) d.credentialMode = "dedicated";
        }
        if (list[0])
          Object.assign(
            settings.providers[kind],
            { apiBaseUrl: list[0].apiBaseUrl, apiPath: list[0].apiPath, model: list[0].model },
            kind === "azure-openai"
              ? { apiVersion: (list[0] as unknown as { apiVersion: string }).apiVersion }
              : {},
          );
        else Object.assign(settings.providers[kind], { apiBaseUrl: "", model: "", enabled: false });
      } else if (row.kind === "larm-agent-connection")
        settings.providers[row.kind].connections = settings.providers[row.kind].connections.filter(
          (d) => d.id !== id,
        );
      else {
        settings.providers[row.kind].enabled = false;
        settings.providers[row.kind].model = "";
        if (row.credentialKey) secrets.set(row.credentialKey, { action: "clear" });
      }
      return { id };
    },
  );
}
