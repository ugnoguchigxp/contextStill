import { randomUUID } from "node:crypto";
import { resolveWriterEndpoint } from "../../db/sqlite/writer-client.js";
import { checkCodexAuthStatus } from "../codex/codex-auth.service.js";
import { createAzureOpenAiProvider } from "../llm/providers/azure-openai.provider.js";
import { createBedrockProvider } from "../llm/providers/bedrock.provider.js";
import { createLocalLlmProvider } from "../llm/providers/local-llm.provider.js";
import { createOpenAiProvider } from "../llm/providers/openai.provider.js";
import type {
  ConnectionInput,
  ConnectionRow,
  ProviderRuntime,
  ProviderTestResult,
} from "./connection-contracts.js";
import {
  SettingsConflict,
  applyConnectionInput,
  connectionRows,
  currentSettings,
  fingerprint,
  resolveConnectionCredential,
} from "./provider-connections.service.js";
import {
  SETTINGS_SECRET_NAMESPACE,
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "./settings.repository.js";

const TEST_NAMESPACE = "runtime.provider-test";
export async function nativeSettingsRequest<T>(body: unknown): Promise<T> {
  const endpoint = resolveWriterEndpoint();
  const url = new URL(endpoint.url);
  url.pathname = "/internal/settings-provider";
  url.search = "";
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(typeof payload.error === "string" ? payload.error : "resident_unavailable");
  return payload;
}
async function versionFingerprint(row: ConnectionRow) {
  const secret = row.credentialKey
    ? await findSettingsRow(SETTINGS_SECRET_NAMESPACE, row.credentialKey)
    : null;
  return fingerprint({
    kind: row.kind,
    fields: row.fields,
    secretVersion: secret?.schemaVersion ?? 0,
    secretRef: secret?.secretRef ?? null,
  });
}
function publicError(error: unknown): string {
  const e = error as {
    status?: number;
    $metadata?: { httpStatusCode?: number };
    name?: string;
    message?: string;
  };
  const status = e?.status ?? e?.$metadata?.httpStatusCode;
  if (status) return `HTTP ${status}`;
  if (e?.message === "provider_slot_busy")
    return "実行枠が使用中です。空き枠ができてから確認してください。";
  if (e?.name === "AbortError" || e?.name === "TimeoutError")
    return "接続確認がタイムアウトしました";
  if (e?.message && /^(provider_[a-z_]+|resident_unavailable|secret_[a-z_]+)$/.test(e.message))
    return e.message;
  return "接続を確認できませんでした。Endpoint・モデル・認証を確認してください。";
}
async function persistTest(result: ProviderTestResult) {
  await upsertSettingsRow({
    namespace: TEST_NAMESPACE,
    key: result.id,
    value: { result, digest: (await findSettingsRow(TEST_NAMESPACE, result.id))?.value.digest },
    valueKind: "json",
    schemaVersion: 1,
  });
}
export async function providerRuntime(id: string): Promise<ProviderRuntime> {
  const { settings } = await currentSettings();
  const row = connectionRows(settings).find((r) => r.id === id);
  if (!row) throw new Error("connection_not_found");
  const observedAt = new Date().toISOString();
  if (row.kind !== "larm-agent-connection")
    return { observedAt, status: "configured", model: row.model, endpoint: row.endpoint };
  try {
    return {
      ...(await nativeSettingsRequest<Omit<ProviderRuntime, "observedAt">>({
        operation: "runtime",
        id,
      })),
      observedAt,
    };
  } catch {
    return { observedAt, status: "unavailable", reason: "residentの状態を取得できません" };
  }
}
export async function getProviderTest(id: string): Promise<ProviderTestResult | null> {
  const stored = await findSettingsRow(TEST_NAMESPACE, id);
  if (!stored) return null;
  const result = stored.value.result as ProviderTestResult;
  if (result.scope === "saved") {
    const { settings } = await currentSettings();
    const row = connectionRows(settings).find((r) => r.id === result.connectionId);
    if (!row || (await versionFingerprint(row)) !== result.requestFingerprint)
      return { ...result, status: "stale" };
  }
  if (
    (result.status === "running" || result.status === "queued") &&
    Date.now() - Date.parse(result.startedAt) > 180_000
  )
    return {
      ...result,
      status: "failed",
      error: "確認結果を取得できませんでした。再実行前に状態を確認してください。",
    };
  return result;
}
export async function latestProviderTests(): Promise<Record<string, ProviderTestResult>> {
  const rows = await listSettingsRows(TEST_NAMESPACE);
  const latest: Record<string, ProviderTestResult> = {};
  for (const r of rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const test = r.value.result as ProviderTestResult;
    if (test.scope !== "saved" || !test.connectionId || latest[test.connectionId]) continue;
    const current = await getProviderTest(test.id);
    if (current) latest[test.connectionId] = current;
  }
  return latest;
}
export async function cancelProviderTest(id: string) {
  const test = await getProviderTest(id);
  if (!test) return null;
  // Resident permits are released by completion/timeout, never by browser cancellation.
  if (test.status === "running" || test.status === "queued") {
    test.status = "cancelled";
    test.error = "表示を取り消しました。実行枠は確認処理の終了時に戻ります。";
    await persistTest(test);
  }
  return test;
}
export async function startProviderTest(input: {
  operationId?: string;
  id?: string;
  draft?: ConnectionInput;
}) {
  const id = input.operationId ?? randomUUID();
  const digest = fingerprint(input);
  const existing = await findSettingsRow(TEST_NAMESPACE, id);
  if (existing) {
    if (existing.value.digest !== digest) throw new SettingsConflict("operation_id_conflict");
    return getProviderTest(id);
  }
  const { settings, revision } = await currentSettings();
  const savedRow = input.id ? connectionRows(settings).find((r) => r.id === input.id) : undefined;
  if (input.id && !savedRow) throw new Error("connection_not_found");
  if (input.draft && input.draft.expectedRevision !== revision)
    throw new SettingsConflict("settings_revision_conflict", { revision });
  const row = input.draft
    ? applyConnectionInput(structuredClone(settings), input.draft, input.id)
    : savedRow;
  if (!row) throw new Error("connection_required");
  const action = input.draft?.credential.action ?? "keep";
  let credential =
    action === "set"
      ? (input.draft?.credential.value ?? "")
      : action === "clear"
        ? ""
        : action === "inherit"
          ? await resolveConnectionCredential({ ...row, credentialKey: "azureOpenAiApiKey" })
          : action === "keep" && savedRow
            ? await resolveConnectionCredential(savedRow)
            : await resolveConnectionCredential(row);
  if (action === "environment")
    credential = await resolveConnectionCredential({
      ...row,
      id: "draft-environment",
      credentialKey: undefined,
    });
  // Environment reset is a save operation; draft must use the actual environment.
  if (action === "environment") {
    if (row.kind === "larm-agent-connection") credential = process.env.LARM_API_TOKEN ?? "";
    else {
      const { resolveSecretValue } = await import("./settings.runtime-cache.js");
      credential = resolveSecretValue(row.credentialKey as never, undefined)?.value ?? "";
    }
  }
  const test: ProviderTestResult = {
    id,
    connectionId: input.id,
    revision,
    scope: input.draft ? "draft" : "saved",
    status: "running",
    startedAt: new Date().toISOString(),
    method: row.kind === "codex" ? "SDK認証確認" : "対象モデルへの推論",
    model: row.kind === "larm-agent-connection" ? undefined : row.model,
    endpoint: row.endpoint,
    requestFingerprint: await versionFingerprint(row),
  };
  // A CAS reservation prevents duplicate submission of the same test request.
  try {
    await upsertSettingsRow({
      namespace: TEST_NAMESPACE,
      key: id,
      value: { result: test, digest },
      expectedVersion: 0,
      schemaVersion: 1,
    });
  } catch {
    const priorRow = await findSettingsRow(TEST_NAMESPACE, id);
    if (priorRow && priorRow.value.digest !== digest)
      throw new SettingsConflict("operation_id_conflict");
    const prior = await getProviderTest(id);
    if (prior) return prior;
    throw new Error("provider_test_start_failed");
  }
  void (async () => {
    try {
      const fields = row.fields;
      if (row.kind === "larm-agent-connection") {
        const { enabled: _enabled, ...config } = fields;
        const runtime = await nativeSettingsRequest<{ model: string; endpoint: string }>({
          operation: "test",
          config,
          credential,
          saved: !input.draft && row.enabled,
          revision,
        });
        test.model = runtime.model;
        test.endpoint = runtime.endpoint;
      } else if (row.kind === "codex") {
        const auth = await checkCodexAuthStatus();
        if (auth.recommendedAction !== "ready") throw new Error("provider_auth_unavailable");
      } else {
        const timeoutMs = 15_000;
        const provider =
          row.kind === "openai"
            ? createOpenAiProvider({
                timeoutMs,
                probe: true,
                modelConfig: {
                  apiBaseUrl: String(fields.apiBaseUrl),
                  model: row.model,
                  apiKey: credential,
                },
              })
            : row.kind === "azure-openai"
              ? createAzureOpenAiProvider({
                  timeoutMs,
                  probe: true,
                  deploymentConfig: {
                    apiBaseUrl: String(fields.apiBaseUrl),
                    apiPath: String(fields.apiPath),
                    apiVersion: String(fields.apiVersion),
                    model: row.model,
                    apiKey: credential,
                  },
                })
              : row.kind === "bedrock"
                ? createBedrockProvider({
                    timeoutMs,
                    probe: true,
                    modelConfig: {
                      region: String(fields.region),
                      profile: String(fields.profile),
                      model: row.model,
                    },
                  })
                : createLocalLlmProvider({
                    timeoutMs,
                    probe: true,
                    modelConfig: {
                      apiBaseUrl: String(fields.apiBaseUrl),
                      apiPath: String(fields.apiPath),
                      model: row.model,
                      apiKey: credential,
                    },
                  });
        await provider.chat({
          messages: [{ role: "user", content: "Reply OK." }],
          maxTokens: 64,
          temperature: 0,
        });
      }
      test.status = "success";
    } catch (error) {
      test.status = "failed";
      test.error = publicError(error);
    } finally {
      credential = "";
      test.finishedAt = new Date().toISOString();
      const current = await findSettingsRow(TEST_NAMESPACE, id);
      if ((current?.value.result as ProviderTestResult)?.status !== "cancelled")
        await persistTest(test);
      const rows = await listSettingsRows(TEST_NAMESPACE);
      for (const old of rows
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(256))
        await deleteSettingsRow(TEST_NAMESPACE, old.key);
    }
  })().catch(() => {
    /* An interrupted task remains an unconfirmed receipt; it is never retried automatically. */
  });
  return test;
}
