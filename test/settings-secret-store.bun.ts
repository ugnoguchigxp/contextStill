import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettingsForApi } from "../api/modules/settings/settings.service.js";
import { groupedConfig } from "../src/config.js";
import {
  getRuntimeSqliteCoreDatabase,
  resetRuntimeSqliteCoreDatabaseForTests,
} from "../src/db/sqlite/runtime.js";
import {
  type SecretStoreClient,
  SecretStoreError,
  resolveSecretRows,
} from "../src/modules/settings/secret-store.client.js";
import { secretStoreClient } from "../src/modules/settings/secret-store.client.js";
import {
  migrateLegacySecrets,
  saveSecretUpdate,
} from "../src/modules/settings/settings-secret.service.js";
import { cloneDefaultSettings } from "../src/modules/settings/settings.defaults.js";
import {
  SETTINGS_DOCUMENT_KEY,
  SETTINGS_DOCUMENT_NAMESPACE,
  SETTINGS_SECRET_NAMESPACE,
  findSettingsRow,
  upsertSettingsRow,
} from "../src/modules/settings/settings.repository.js";
import {
  applyRuntimeSettingsToProcess,
  resolveSecretValue,
} from "../src/modules/settings/settings.runtime-cache.js";
import {
  invalidateRuntimeSettingsCache,
  reloadRuntimeSettingsCache,
} from "../src/modules/settings/settings.service.js";
let directory = "";
let sequence = 0;
const entries = new Map<string, string>();
const store: SecretStoreClient = {
  reserve(key) {
    return `cs-secret:v1:${"a".repeat(64)}:${key}:${(++sequence).toString(16).padStart(32, "0")}`;
  },
  async put(_key, value, ref) {
    entries.set(ref, value);
    return ref;
  },
  async get(_key, ref) {
    const value = entries.get(ref);
    if (value === undefined) throw new Error("secret_store_missing");
    return value;
  },
  async delete(_key, ref) {
    entries.delete(ref);
  },
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "context-still-secret-test-"));
  process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
  process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(directory, "core.sqlite");
  resetRuntimeSqliteCoreDatabaseForTests();
  entries.clear();
});
afterEach(async () => {
  (await getRuntimeSqliteCoreDatabase()).db.close();
  resetRuntimeSqliteCoreDatabaseForTests();
  await rm(directory, { recursive: true, force: true });
});
test("persists references only, resolves values, rotates, clears and retains disabled state after reopen", async () => {
  await saveSecretUpdate(
    "openaiApiKey",
    { value: "synthetic-do-not-store-plaintext" },
    null,
    store,
  );
  const first = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey");
  expect(first?.valueKind).toBe("secret_ref");
  expect(JSON.stringify(first)).not.toContain("synthetic-do-not-store-plaintext");
  if (!first?.secretRef) throw new Error("missing reference");
  const resolved = await resolveSecretRows([first], store);
  expect(resolved[0]?.value.value).toBe("synthetic-do-not-store-plaintext");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  sqlite.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(
    (await readFile(path.join(directory, "core.sqlite"))).includes(
      Buffer.from("synthetic-do-not-store-plaintext"),
    ),
  ).toBe(false);
  await saveSecretUpdate("openaiApiKey", { value: "next-secret" }, null, store);
  expect(entries.has(first.secretRef)).toBe(false);
  await saveSecretUpdate("openaiApiKey", { clear: true }, null, store);
  expect(entries.size).toBe(0);
  sqlite.db.close();
  resetRuntimeSqliteCoreDatabaseForTests();
  const row = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey");
  expect(row?.value.disabled).toBe(true);
  if (!row) throw new Error("missing tombstone");
  expect(resolveSecretValue("openaiApiKey", row)).toBeNull();
});
test("forbids plaintext through the repository and fails closed when the store is missing", async () => {
  await expect(
    upsertSettingsRow({
      namespace: SETTINGS_SECRET_NAMESPACE,
      key: "openaiApiKey",
      value: { value: "secret" },
      valueKind: "encrypted",
      schemaVersion: 1,
    }),
  ).rejects.toThrow("secret_plaintext_write_forbidden");
  await saveSecretUpdate("openaiApiKey", { value: "secret" }, null, store);
  entries.clear();
  const row = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey");
  if (!row) throw new Error("missing row");
  await expect(resolveSecretRows([row], store)).rejects.toThrow("missing");
});
test("legacy migration is resumable and idempotent", async () => {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const now = new Date().toISOString();
  sqlite.db
    .query(
      "insert into settings(id,namespace,key,value,value_kind,is_secret,schema_version,created_at,updated_at) values ('legacy','runtime.secret','openaiApiKey',?,'encrypted',1,1,?,?)",
    )
    .run(JSON.stringify({ value: "legacy-synthetic" }), now, now);
  const denied: SecretStoreClient = {
    ...store,
    async put() {
      throw new Error("denied");
    },
  };
  await expect(migrateLegacySecrets(denied)).rejects.toThrow("denied");
  expect((await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey"))?.value.value).toBe(
    "legacy-synthetic",
  );
  expect((await migrateLegacySecrets(store)).migrated).toBe(1);
  expect((await migrateLegacySecrets(store)).migrated).toBe(0);
});
test("failed retirement keeps a retry and does not resurrect the old value", async () => {
  await saveSecretUpdate("openaiApiKey", { value: "old" }, null, store);
  const failedDelete: SecretStoreClient = {
    ...store,
    async delete() {
      throw new Error("locked");
    },
  };
  await expect(
    saveSecretUpdate("openaiApiKey", { clear: true }, null, failedDelete),
  ).rejects.toThrow("locked");
  expect((await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey"))?.value.disabled).toBe(
    true,
  );
  expect((await migrateLegacySecrets(store)).cleanup).toBe(1);
  expect(entries.size).toBe(0);
});
test("concurrent updates reject the stale reference and collect only the losing generation", async () => {
  await saveSecretUpdate("openaiApiKey", { value: "initial" }, null, store);
  let interleaved = false;
  const competing: SecretStoreClient = {
    ...store,
    async put(key, value, reference) {
      const ref = await store.put(key, value, reference);
      if (!interleaved) {
        interleaved = true;
        await saveSecretUpdate(key, { value: "winner" }, null, store);
      }
      return ref;
    },
  };
  await expect(
    saveSecretUpdate("openaiApiKey", { value: "stale" }, null, competing),
  ).rejects.toThrow("settings_revision_conflict");
  const row = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey");
  if (!row) throw new Error("missing winner");
  expect((await resolveSecretRows([row], store))[0]?.value.value).toBe("winner");
  expect([...entries.values()]).toEqual(["winner"]);
});
test("recovery waits for in-flight reservations and collects expired unreferenced generations", async () => {
  const reference = store.reserve("openaiApiKey");
  await upsertSettingsRow({
    namespace: "runtime.secret-gc",
    key: reference,
    value: { key: "openaiApiKey", reference, notBefore: Date.now() + 60_000 },
    schemaVersion: 1,
  });
  await store.put("openaiApiKey", "interrupted", reference);
  expect((await migrateLegacySecrets(store)).cleanup).toBe(0);
  await upsertSettingsRow({
    namespace: "runtime.secret-gc",
    key: reference,
    value: { key: "openaiApiKey", reference, notBefore: 0 },
    schemaVersion: 2,
  });
  expect((await migrateLegacySecrets(store)).cleanup).toBe(1);
  expect(entries.size).toBe(0);
});
test("environment fallback requires an explicit persisted choice after clear", async () => {
  await saveSecretUpdate("openaiApiKey", { value: "previous" }, null, store);
  await saveSecretUpdate("openaiApiKey", { clear: true }, null, store);
  await saveSecretUpdate("openaiApiKey", { useEnvironment: true }, null, store);
  const row = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "openaiApiKey");
  if (!row) throw new Error("missing environment choice");
  expect(row.value).toEqual({ environment: true });
  expect((await resolveSecretRows([row], store))[0]?.secretRef).toBeNull();
  expect(entries.size).toBe(0);
});

test("isolates denied Azure references, keeps other credentials and never falls back to environment", async () => {
  await saveSecretUpdate("azureOpenAiApiKey", { value: "azure-synthetic" }, null, store);
  await saveSecretUpdate("localLlmApiKey", { value: "local-synthetic" }, null, store);
  const azure = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "azureOpenAiApiKey");
  const local = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "localLlmApiKey");
  if (!azure || !local) throw new Error("missing rows");
  const denied: SecretStoreClient = {
    ...store,
    async get(key, ref) {
      if (key === "azureOpenAiApiKey") throw new SecretStoreError("secret_store_denied");
      return store.get(key, ref);
    },
  };
  await expect(resolveSecretRows([azure, local], denied)).rejects.toThrow("secret_store_denied");
  const resolved = await resolveSecretRows([azure, local], denied, { isolateFailures: true });
  const bad = resolveSecretValue("azureOpenAiApiKey", resolved[0]);
  const good = resolveSecretValue("localLlmApiKey", resolved[1]);
  expect(bad).toMatchObject({ value: "", source: "db", error: "secret_store_denied" });
  expect(good?.value).toBe("local-synthetic");
  expect((await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "azureOpenAiApiKey"))?.value).toEqual(
    azure.value,
  );
  const settings = cloneDefaultSettings();
  settings.providers["local-llm"].enabled = true;
  applyRuntimeSettingsToProcess(settings, { azureOpenAiApiKey: bad, localLlmApiKey: good });
  expect(groupedConfig.azureOpenAi.apiKey).toBe("");
  expect(groupedConfig.localLlm.apiKey).toBe("local-synthetic");
});

test("settings API remains readable with a denied Keychain reference and reports its reason", async () => {
  await saveSecretUpdate("azureOpenAiApiKey", { value: "azure-synthetic" }, null, store);
  const persisted = cloneDefaultSettings();
  persisted.advanced.doctorFreshnessThresholdMinutes = 123;
  persisted.providers["azure-openai"].enabled = true;
  await upsertSettingsRow({
    namespace: SETTINGS_DOCUMENT_NAMESPACE,
    key: SETTINGS_DOCUMENT_KEY,
    value: { settings: persisted },
    schemaVersion: 7,
  });
  const original = secretStoreClient.get;
  secretStoreClient.get = async () => {
    throw new SecretStoreError("secret_store_denied");
  };
  invalidateRuntimeSettingsCache();
  try {
    const result = await getSettingsForApi();
    expect(result.settings.providers["azure-openai"].apiKeySecret).toMatchObject({
      configured: false,
      source: "db",
      maskedValue: null,
      error: "secret_store_denied",
    });
    expect(result.revision).toBe(7);
    expect(result.settings.advanced.doctorFreshnessThresholdMinutes).toBe(123);
    expect(groupedConfig.azureOpenAi.apiKey).toBe("");
    secretStoreClient.get = store.get;
    await reloadRuntimeSettingsCache();
    const recovered = await getSettingsForApi();
    expect(recovered.settings.providers["azure-openai"].apiKeySecret).toMatchObject({
      configured: true,
    });
    expect(recovered.settings.providers["azure-openai"].apiKeySecret.error).toBeUndefined();
    expect(groupedConfig.azureOpenAi.apiKey).toBe("azure-synthetic");
  } finally {
    secretStoreClient.get = original;
    invalidateRuntimeSettingsCache();
  }
});
