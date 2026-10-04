import { createHash } from "node:crypto";
import type { CredentialUpdate } from "./connection-contracts.js";
import { type SettingsMutationRow, commitSettingsRows } from "./settings-atomic.repository.js";
import {
  type PreparedSecret,
  finishSecretChange,
  prepareSecretChange,
} from "./settings-secret.service.js";
import { cloneDefaultSettings, parseDocumentValue } from "./settings.defaults.js";
import {
  SETTINGS_DOCUMENT_KEY,
  SETTINGS_DOCUMENT_NAMESPACE,
  deleteSettingsRow,
  findSettingsRow,
  listSettingsRows,
} from "./settings.repository.js";
import { type RuntimeSettingsEditable, runtimeSettingsEditableSchema } from "./settings.types.js";
const OP_NAMESPACE = "runtime.settings-operation";
export class SettingsConflict extends Error {
  constructor(
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function currentSettings() {
  const row = await findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY);
  return {
    settings: row ? parseDocumentValue(row) : cloneDefaultSettings(),
    revision: row?.schemaVersion ?? 0,
  };
}
async function pruneOperations() {
  const rows = await listSettingsRows(OP_NAMESPACE);
  for (const row of rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(256))
    await deleteSettingsRow(OP_NAMESPACE, row.key);
}
export async function getSettingsOperation(id: string) {
  const row = await findSettingsRow(OP_NAMESPACE, id);
  return row?.value.result ?? null;
}

export async function mutateSettings<T>(
  expectedRevision: number,
  operationId: string,
  request: unknown,
  change: (
    settings: RuntimeSettingsEditable,
    secrets: Map<string, CredentialUpdate>,
  ) => Promise<T> | T,
) {
  const digest = fingerprint(request);
  const prior = await findSettingsRow(OP_NAMESPACE, operationId);
  if (prior) {
    if (prior.value.digest !== digest) throw new SettingsConflict("operation_id_conflict");
    return prior.value.result as { revision: number; value: T };
  }
  const { settings, revision } = await currentSettings();
  if (revision !== expectedRevision)
    throw new SettingsConflict("settings_revision_conflict", { revision });
  const next = structuredClone(settings);
  const secretChanges = new Map<string, CredentialUpdate>();
  const value = await change(next, secretChanges);
  const validated = runtimeSettingsEditableSchema.parse(next);
  const prepared: PreparedSecret[] = [];
  let committed = false;
  const result = { revision: revision + 1, value };
  try {
    for (const [key, update] of secretChanges) {
      if (update.action === "keep") continue;
      prepared.push(
        await prepareSecretChange(key, {
          value: update.action === "set" ? update.value : undefined,
          clear: update.action === "clear" || update.action === "inherit",
          useEnvironment: update.action === "environment",
        }),
      );
    }
    const rows: SettingsMutationRow[] = [
      {
        namespace: SETTINGS_DOCUMENT_NAMESPACE,
        key: SETTINGS_DOCUMENT_KEY,
        value: { settings: validated },
        expectedVersion: revision,
      },
      ...prepared.map((p) => p.row),
      { namespace: OP_NAMESPACE, key: operationId, value: { digest, result }, expectedVersion: 0 },
    ];
    await commitSettingsRows(rows);
    committed = true;
  } catch (error) {
    const recovered = await findSettingsRow(OP_NAMESPACE, operationId);
    if (recovered?.value.digest === digest) {
      committed = true;
      return recovered.value.result as typeof result;
    }
    throw error;
  } finally {
    for (const p of prepared)
      try {
        await finishSecretChange(p, committed);
      } catch {
        /* Existing GC journal retains cleanup. */
      }
  }
  await pruneOperations();
  return result;
}
