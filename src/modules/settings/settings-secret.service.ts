import { type SecretStoreClient, secretStoreClient } from "./secret-store.client.js";
import type { SettingsMutationRow } from "./settings-atomic.repository.js";
import {
  SETTINGS_SECRET_NAMESPACE,
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
  upsertSettingsRow,
} from "./settings.repository.js";

export type PreparedSecret = {
  row: SettingsMutationRow;
  priorReference: string | null;
  reference: string | null;
  key: string;
};
export async function prepareSecretChange(
  key: string,
  update: { value?: string; clear?: boolean; useEnvironment?: boolean },
  store: SecretStoreClient = secretStoreClient,
): Promise<PreparedSecret> {
  const prior = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, key);
  const reference = update.clear || update.useEnvironment ? null : store.reserve(key);
  if (reference) {
    await journal(key, reference);
    try {
      if ((await store.put(key, update.value?.trim() ?? "", reference)) !== reference)
        throw new Error("secret_reference_mismatch");
    } catch (error) {
      await retire(key, reference, store);
      throw error;
    }
  }
  if (prior?.secretRef) await journal(key, prior.secretRef);
  return {
    key,
    reference,
    priorReference: prior?.secretRef ?? null,
    row: {
      namespace: SETTINGS_SECRET_NAMESPACE,
      key,
      expectedVersion: prior?.schemaVersion ?? 0,
      value: reference
        ? { secretRef: reference }
        : update.useEnvironment
          ? { environment: true }
          : { disabled: true },
      valueKind: "secret_ref",
      secretRef: reference,
      isSecret: true,
    },
  };
}
export async function finishSecretChange(
  prepared: PreparedSecret,
  committed: boolean,
  store: SecretStoreClient = secretStoreClient,
): Promise<void> {
  const current = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, prepared.key);
  if (prepared.reference) {
    if (current?.secretRef === prepared.reference)
      await deleteSettingsRow(GC_NAMESPACE, prepared.reference);
    else await retire(prepared.key, prepared.reference, store);
  }
  if (committed && prepared.priorReference && current?.secretRef !== prepared.priorReference)
    await retire(prepared.key, prepared.priorReference, store);
}

const GC_NAMESPACE = "runtime.secret-gc";
async function journal(key: string, reference: string) {
  await upsertSettingsRow({
    namespace: GC_NAMESPACE,
    key: reference,
    value: { key, reference, notBefore: Date.now() + 3_600_000 },
    schemaVersion: 1,
  });
}
async function retire(key: string, reference: string, store: SecretStoreClient) {
  // Persist the retry before trying deletion, so a process crash cannot lose the cleanup.
  await upsertSettingsRow({
    namespace: GC_NAMESPACE,
    key: reference,
    value: { key, reference },
    schemaVersion: 1,
  });
  await store.delete(key, reference);
  await deleteSettingsRow(GC_NAMESPACE, reference);
}
export async function saveSecretUpdate(
  key: string,
  update: { value?: string; clear?: boolean; useEnvironment?: boolean },
  updatedBy: string | null,
  store: SecretStoreClient = secretStoreClient,
  expectedVersion?: number,
): Promise<void> {
  const old = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, key);
  if (expectedVersion !== undefined && old?.schemaVersion !== expectedVersion)
    throw new Error("settings_revision_conflict");
  const value = update.value?.trim();
  if (!update.clear && !update.useEnvironment && !value) return;
  const reference = update.clear || update.useEnvironment ? null : store.reserve(key);
  if (reference) await journal(key, reference);
  if (old?.secretRef) await journal(key, old.secretRef);
  try {
    if (reference && (await store.put(key, value ?? "", reference)) !== reference)
      throw new Error("secret_reference_mismatch");
    await upsertSettingsRow({
      namespace: SETTINGS_SECRET_NAMESPACE,
      key,
      value: reference
        ? { secretRef: reference }
        : update.useEnvironment
          ? { environment: true }
          : { disabled: true },
      valueKind: "secret_ref",
      secretRef: reference,
      isSecret: true,
      schemaVersion: (old?.schemaVersion ?? 0) + 1,
      expectedVersion: old?.schemaVersion ?? 0,
      updatedBy,
    });
  } catch (error) {
    // A transport timeout may have committed. Never delete a reference that is now current.
    const current = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, key);
    if (reference && current?.secretRef !== reference) await retire(key, reference, store);
    throw error;
  }
  if (reference) await deleteSettingsRow(GC_NAMESPACE, reference);
  if (old?.secretRef && old.secretRef !== reference) {
    await retire(key, old.secretRef, store);
  }
}

export async function migrateLegacySecrets(
  store = secretStoreClient,
): Promise<{ migrated: number; cleanup: number }> {
  let migrated = 0;
  for (const row of await listSettingsRows(SETTINGS_SECRET_NAMESPACE)) {
    if (row.valueKind === "secret_ref") continue;
    if (typeof row.value.value !== "string" || !row.value.value.trim())
      throw new Error("secret_legacy_value_invalid");
    await saveSecretUpdate(
      row.key,
      { value: row.value.value },
      "secret-migration",
      store,
      row.schemaVersion,
    );
    migrated += 1;
  }
  let cleanup = 0;
  for (const row of await listSettingsRows(GC_NAMESPACE)) {
    const { key, reference, notBefore } = row.value;
    if (typeof notBefore === "number" && notBefore > Date.now()) continue;
    if (typeof key !== "string" || typeof reference !== "string")
      throw new Error("secret_cleanup_invalid");
    const current = await findSettingsRow(SETTINGS_SECRET_NAMESPACE, key);
    if (current?.secretRef === reference) continue;
    await store.delete(key, reference);
    await deleteSettingsRow(GC_NAMESPACE, row.key);
    cleanup += 1;
  }
  return { migrated, cleanup };
}
