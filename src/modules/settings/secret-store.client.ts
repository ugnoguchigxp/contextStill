import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { resolveWriterEndpoint } from "../../db/sqlite/writer-client.js";
import type { SettingsRow } from "./settings.repository.js";

export class SecretStoreError extends Error {}
export type SecretStoreClient = {
  reserve(key: string): string;
  put(key: string, value: string, reference: string): Promise<string>;
  get(key: string, reference: string): Promise<string>;
  delete(key: string, reference: string): Promise<void>;
};

function profile(): string {
  const db = resolveDatabaseBackendConfig();
  if (db.sqlitePath) {
    try {
      return realpathSync(db.sqlitePath);
    } catch {
      return path.resolve(db.sqlitePath);
    }
  }
  const url = new URL(db.url);
  return `postgres://${url.hostname}:${url.port || "5432"}${url.pathname}`;
}
async function request(
  operation: string,
  key: string,
  input: { value?: string; reference?: string },
) {
  let endpoint: ReturnType<typeof resolveWriterEndpoint>;
  try {
    endpoint = resolveWriterEndpoint();
  } catch {
    throw new SecretStoreError("secret_store_resident_unavailable");
  }
  const url = new URL(endpoint.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new SecretStoreError("secret_store_requires_loopback");
  }
  url.pathname = "/writer/secrets";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation, key, profile: profile(), ...input }),
    });
  } catch {
    throw new SecretStoreError("secret_store_transport_unavailable");
  }
  let result: { ok?: boolean; value?: string; reference?: string; error?: string };
  try {
    result = await response.json();
  } catch {
    throw new SecretStoreError("secret_store_protocol_unavailable");
  }
  if (!response.ok || !result.ok) {
    const code = /^secret_[a-z_]+$/.test(result.error ?? "")
      ? result.error
      : "secret_store_unavailable";
    throw new SecretStoreError(code);
  }
  return result;
}
export const secretStoreClient: SecretStoreClient = {
  reserve(key) {
    return `cs-secret:v1:${createHash("sha256").update(profile()).digest("hex")}:${key}:${randomBytes(16).toString("hex")}`;
  },
  async put(key, value, reference) {
    const result = await request("put", key, { value, reference });
    if (!result.reference?.startsWith("cs-secret:v1:"))
      throw new SecretStoreError("secret_reference_invalid");
    return result.reference;
  },
  async get(key, reference) {
    const result = await request("get", key, { reference });
    if (typeof result.value !== "string")
      throw new SecretStoreError("secret_store_response_invalid");
    return result.value;
  },
  async delete(key, reference) {
    await request("delete", key, { reference });
  },
};

export async function resolveSecretRows(
  rows: SettingsRow[],
  store = secretStoreClient,
): Promise<SettingsRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (row.value.disabled === true || row.value.environment === true) return row;
      if (row.valueKind !== "secret_ref") return row;
      const reference = row.secretRef;
      if (!reference || row.value.secretRef !== reference)
        throw new SecretStoreError("secret_reference_invalid");
      return { ...row, value: { value: await store.get(row.key, reference) } };
    }),
  );
}
