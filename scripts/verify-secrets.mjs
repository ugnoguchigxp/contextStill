import assert from "node:assert/strict";
import { copyFile, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createIsolatedRuntime } from "./testing/isolated-runtime.mjs";

if (process.platform !== "darwin")
  throw new Error("Real secret-store acceptance requires macOS Keychain");
const runtime = await createIsolatedRuntime();
let reference;
let endpoint;
let token;
const synthetic = `contextstill-synthetic-secret-acceptance-${crypto.randomUUID()}`;
async function refreshEndpoint() {
  const metadata = JSON.parse(await readFile(runtime.env.CONTEXT_STILL_MCP_ENDPOINT_PATH, "utf8"));
  token = (await readFile(metadata.writerTokenPath, "utf8")).trim();
  endpoint = new URL("/writer/secrets", metadata.writerUrl);
}
async function secret(operation, extra = {}, authorized = true) {
  return fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      authorization: authorized ? `Bearer ${token}` : "Bearer invalid",
    },
    body: JSON.stringify({
      operation,
      profile: await realpath(runtime.env.CONTEXT_STILL_SQLITE_CORE_PATH),
      key: "openaiApiKey",
      ...extra,
    }),
  });
}
try {
  await runtime.initialize();
  await refreshEndpoint();
  assert.equal((await secret("put", { value: synthetic }, false)).status, 401);
  // Model a legacy database, then exercise the resumable public migration command.
  await runtime.writer(
    "INSERT INTO settings(id,namespace,key,value,value_kind,is_secret,schema_version) VALUES('legacy-secret','runtime.secret','openaiApiKey',?,'encrypted',1,1)",
    [JSON.stringify({ value: synthetic })],
  );
  const migration = JSON.parse(
    await runtime.run("bun", ["--no-env-file", "src/cli/migrate-secrets.ts", "--write"]),
  );
  assert.equal(migration.migrated, 1);
  const saved = JSON.parse(
    await runtime.run("bun", ["--no-env-file", "scripts/testing/secret-client-fixture.ts"], {
      CONTEXT_STILL_SYNTHETIC_TEST_SECRET: synthetic,
    }),
  );
  reference = saved.reference;
  assert.equal((await secret("get", { reference })).headers.get("cache-control"), "no-store");
  assert.equal((await (await secret("get", { reference })).json()).value, synthetic);
  await runtime.stopWriter();
  const backup = JSON.parse(await runtime.cli("backup", "create", "--json"));
  assert.equal((await readFile(backup.output)).includes(Buffer.from(synthetic)), false);
  const restored = path.join(runtime.directory, "restored.sqlite");
  await copyFile(backup.output, restored);
  // The offline VACUUM INTO backup removes old freelist bytes; restore to the same profile.
  await copyFile(backup.output, runtime.env.CONTEXT_STILL_SQLITE_CORE_PATH);
  await runtime.startWriter();
  await refreshEndpoint();
  assert.equal((await (await secret("get", { reference })).json()).value, synthetic);
  const wrongProfile = await secret("get", { reference, profile: restored });
  assert.equal(wrongProfile.status, 503);
  assert.equal((await wrongProfile.json()).error, "secret_profile_mismatch");
  await runtime.writer(
    "UPDATE settings SET value='{\"disabled\":true}',secret_ref=NULL,schema_version=2 WHERE namespace='runtime.secret' AND key='openaiApiKey'",
  );
  assert.equal((await secret("delete", { reference })).status, 200);
  assert.equal((await secret("get", { reference })).status, 503);
  reference = undefined;
  await runtime.stopWriter();
  for (const name of await readdir(runtime.directory)) {
    if (name.startsWith("core.sqlite"))
      assert.equal(
        (await readFile(path.join(runtime.directory, name))).includes(Buffer.from(synthetic)),
        false,
        name,
      );
  }
  console.log(
    JSON.stringify({
      ok: true,
      adapter: "macOS Keychain",
      authentication: true,
      restart: true,
      backupReferenceOnly: true,
      restoredProfileDenied: true,
      deletion: true,
    }),
  );
} finally {
  if (reference) {
    try {
      await secret("delete", { reference });
    } catch {
      /* Cleanup failure must be visible. */ console.error(
        "Synthetic Keychain cleanup requires retry",
      );
    }
  }
  await runtime.cleanup();
}
