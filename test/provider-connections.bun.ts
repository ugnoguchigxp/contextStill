import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getRuntimeSqliteCoreDatabase,
  resetRuntimeSqliteCoreDatabaseForTests,
} from "../src/db/sqlite/runtime.js";
import {
  connectionInputSchema,
  localConnectionModel,
  routeEntries,
  setRoute,
} from "../src/modules/settings/connection-contracts.js";
import {
  SettingsConflict,
  connectionRows,
  currentSettings,
  deleteConnection,
  mutateSettings,
  patchSection,
  resolveConnectionCredential,
  saveConnection,
} from "../src/modules/settings/provider-connections.service.js";
import {
  getProviderTest,
  startProviderTest,
} from "../src/modules/settings/provider-tests.service.js";
import {
  type SecretStoreClient,
  secretStoreClient,
} from "../src/modules/settings/secret-store.client.js";
import {
  SETTINGS_DOCUMENT_KEY,
  SETTINGS_DOCUMENT_NAMESPACE,
  SETTINGS_SECRET_NAMESPACE,
  findSettingsRow,
} from "../src/modules/settings/settings.repository.js";
import { invalidateRuntimeSettingsCache } from "../src/modules/settings/settings.service.js";
let directory = "";
let sequence = 0;
let failKey = "";
let server: ReturnType<typeof Bun.serve> | undefined;
const entries = new Map<string, string>();
const original = { ...secretStoreClient };
const fakeStore: SecretStoreClient = {
  reserve(key) {
    return `cs-secret:v1:${"a".repeat(64)}:${key}:${(++sequence).toString(16).padStart(32, "0")}`;
  },
  async put(key, value, reference) {
    if (key === failKey) throw new Error("secret_store_unavailable");
    entries.set(reference, value);
    return reference;
  },
  async get(_key, reference) {
    const value = entries.get(reference);
    if (value === undefined) throw new Error("secret_store_missing");
    return value;
  },
  async delete(_key, reference) {
    entries.delete(reference);
  },
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "contextstill-connection-test-"));
  process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
  process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(directory, "core.sqlite");
  resetRuntimeSqliteCoreDatabaseForTests();
  invalidateRuntimeSettingsCache();
  Object.assign(secretStoreClient, fakeStore);
  entries.clear();
  failKey = "";
});
afterEach(async () => {
  server?.stop(true);
  server = undefined;
  Object.assign(secretStoreClient, original);
  (await getRuntimeSqliteCoreDatabase()).db.close();
  resetRuntimeSqliteCoreDatabaseForTests();
  invalidateRuntimeSettingsCache();
  await rm(directory, { recursive: true, force: true });
});
async function baseline() {
  const { revision } = await currentSettings();
  return mutateSettings(revision, randomUUID(), { baseline: true }, (settings) => {
    settings.providers["azure-openai"].deployments = [];
    settings.providers["azure-openai"].apiBaseUrl = "";
    settings.providers["azure-openai"].model = "";
    settings.providers["local-llm"].models = [];
    settings.providers["local-llm"].apiBaseUrl = "";
    settings.providers["local-llm"].model = "";
    settings.providerPools = [];
    for (const [name] of routeEntries(settings))
      if (name !== "agenticCompile") setRoute(settings, name, { provider: "auto", fallback: [] });
    settings.advanced.agentRuntime = {
      enabled: true,
      research: {
        baseUrl: "http://127.0.0.1:9001",
        gatewayUrl: "http://127.0.0.1:9002",
        credentialKey: "researchToken",
        gatewayCredentialKey: "gatewayToken",
      },
    };
  });
}
async function azure(name: string, credential: string) {
  const { revision } = await currentSettings();
  return saveConnection(
    connectionInputSchema.parse({
      kind: "azure-openai",
      fields: {
        name,
        apiBaseUrl: `https://${name}.example.test`,
        apiPath: "/openai/deployments",
        apiVersion: "2024-10-21",
        model: name,
        enabled: true,
      },
      credential: { action: "set", value: credential },
      expectedRevision: revision,
      operationId: randomUUID(),
    }),
  );
}
test("individual save persists stable IDs and retry receipt without touching AgentRuntime", async () => {
  await baseline();
  const { revision } = await currentSettings();
  const input = connectionInputSchema.parse({
    kind: "local-llm",
    fields: {
      name: "Worker",
      apiBaseUrl: "http://127.0.0.1:12345",
      apiPath: "/v1/chat/completions",
      model: "model-a",
      enabled: true,
    },
    credential: { action: "set", value: "synthetic-fixed-key" },
    expectedRevision: revision,
    operationId: randomUUID(),
  });
  const first = await saveConnection(input);
  const second = await saveConnection(input);
  expect(second).toEqual(first);
  expect((await currentSettings()).revision).toBe(revision + 1);
  expect(entries.size).toBe(1);
  const id = first.value.id;
  await saveConnection(
    {
      ...input,
      fields: { ...input.fields, name: "Renamed" },
      credential: { action: "keep" },
      expectedRevision: first.revision,
      operationId: randomUUID(),
    },
    id,
  );
  const state = await currentSettings();
  expect(state.settings.providers["local-llm"].models[0].id).toBe(id);
  expect(state.settings.advanced.agentRuntime?.research?.credentialKey).toBe("researchToken");
  const document = await findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY);
  expect(JSON.stringify(document)).not.toContain("synthetic-fixed-key");
});
test("concurrent document revision rejects the losing credential change atomically", async () => {
  await baseline();
  const { revision } = await currentSettings();
  const request = (name: string) =>
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: {
        name,
        apiBaseUrl: "http://127.0.0.1:12345",
        apiPath: "/v1/chat/completions",
        model: name,
      },
      credential: { action: "set", value: `synthetic-${name}` },
      expectedRevision: revision,
      operationId: randomUUID(),
    });
  const results = await Promise.allSettled([
    saveConnection(request("one")),
    saveConnection(request("two")),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect((await currentSettings()).settings.providers["local-llm"].models).toHaveLength(1);
  expect(entries.size).toBe(1);
});
test("failure to prepare the second credential adopts neither the document nor the first key", async () => {
  await baseline();
  const before = await currentSettings();
  failKey = "gatewayToken";
  await expect(
    patchSection({
      section: "advanced",
      changes: { pipelineClaimLimit: before.settings.advanced.pipelineClaimLimit + 1 },
      secrets: {
        researchToken: { action: "set", value: "synthetic-research" },
        gatewayToken: { action: "set", value: "synthetic-gateway" },
      },
      expectedRevision: before.revision,
      operationId: randomUUID(),
    }),
  ).rejects.toThrow("secret_store_unavailable");
  expect((await currentSettings()).revision).toBe(before.revision);
  expect(entries.size).toBe(0);
  expect(await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "researchToken")).toBeNull();
});
test("Azure deletion shifts credentials and later slot references together", async () => {
  await baseline();
  const a = await azure("a", "synthetic-a");
  const b = await azure("b", "synthetic-b");
  await azure("c", "synthetic-c");
  let state = await currentSettings();
  await patchSection({
    section: "taskRouting",
    changes: {
      findCandidate: {
        source: { provider: "azure-openai", model: "c", azureDeploymentSlots: [3], fallback: [] },
      },
    },
    expectedRevision: state.revision,
    operationId: randomUUID(),
  });
  state = await currentSettings();
  await deleteConnection(b.value.id, {
    expectedRevision: state.revision,
    operationId: randomUUID(),
  });
  state = await currentSettings();
  expect(state.settings.providers["azure-openai"].deployments.map((d) => d.model)).toEqual([
    "a",
    "c",
  ]);
  expect(state.settings.taskRouting.findCandidate.source).toMatchObject({
    azureDeploymentSlots: [2],
  });
  const rows = connectionRows(state.settings);
  expect(
    await resolveConnectionCredential(
      rows.find((r) => r.id === a.value.id) ??
        (() => {
          throw new Error("missing a");
        })(),
    ),
  ).toBe("synthetic-a");
  expect(
    await resolveConnectionCredential(
      rows.find((r) => r.model === "c") ??
        (() => {
          throw new Error("missing c");
        })(),
    ),
  ).toBe("synthetic-c");
  expect((await findSettingsRow(SETTINGS_SECRET_NAMESPACE, "azureOpenAiApiKey3"))?.value).toEqual({
    disabled: true,
  });
});
test("encoded fixed endpoint and Pool references block deletion", async () => {
  await baseline();
  const { revision } = await currentSettings();
  const saved = await saveConnection(
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: {
        name: "Fixed",
        apiBaseUrl: "http://127.0.0.1:12345",
        apiPath: "/v1/chat/completions",
        model: "same-model",
      },
      expectedRevision: revision,
      operationId: randomUUID(),
    }),
  );
  let state = await currentSettings();
  await patchSection({
    section: "taskRouting",
    changes: {
      findCandidate: {
        vibe: {
          provider: "local-llm",
          model: JSON.stringify({
            apiBaseUrl: "http://127.0.0.1:12345",
            apiPath: "/v1/chat/completions",
            model: "same-model",
          }),
          fallback: [],
        },
      },
    },
    expectedRevision: state.revision,
    operationId: randomUUID(),
  });
  state = await currentSettings();
  await expect(
    deleteConnection(saved.value.id, {
      expectedRevision: state.revision,
      operationId: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(SettingsConflict);
});
test("dynamic to static route replacement does not carry old discriminator or connectionId", async () => {
  await baseline();
  let state = await currentSettings();
  const larm = await saveConnection(
    connectionInputSchema.parse({
      kind: "larm-agent-connection",
      fields: {
        id: "queue-connection",
        controlBaseUrl: "http://127.0.0.1:12346",
        audience: "same-host",
        enabled: true,
      },
      expectedRevision: state.revision,
      operationId: randomUUID(),
    }),
  );
  await patchSection({
    section: "taskRouting",
    changes: {
      findCandidate: { source: { kind: "larm-agent-connection", connectionId: larm.value.id } },
    },
    expectedRevision: larm.revision,
    operationId: randomUUID(),
  });
  state = await currentSettings();
  await patchSection({
    section: "taskRouting",
    changes: {
      findCandidate: { source: { provider: "openai", model: "custom-model", fallback: [] } },
    },
    expectedRevision: state.revision,
    operationId: randomUUID(),
  });
  state = await currentSettings();
  expect(state.settings.taskRouting.findCandidate.source).toEqual({
    provider: "openai",
    model: "custom-model",
    fallback: [],
  });
  expect(state.settings.taskRouting.findCandidate.vibe).toMatchObject({
    provider: "auto",
    fallback: [],
  });
});
test("per-row probes reject HTTP errors, use one endpoint, keep empty valid responses, and stale old saved results", async () => {
  await baseline();
  let status = 401;
  let calls = 0;
  let seenAuth = "";
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      calls++;
      seenAuth = request.headers.get("authorization") ?? "";
      return Response.json(
        status === 200
          ? { choices: [{ message: { content: "" }, finish_reason: "stop" }] }
          : { error: "synthetic-private-error" },
        { status },
      );
    },
  });
  const state = await currentSettings();
  const saved = await saveConnection(
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: {
        name: "Probe",
        apiBaseUrl: server.url.origin,
        apiPath: "/v1/chat/completions",
        model: "exact-model",
      },
      credential: { action: "set", value: "synthetic-token" },
      expectedRevision: state.revision,
      operationId: randomUUID(),
    }),
  );
  async function probe() {
    const started = await startProviderTest({ id: saved.value.id });
    for (let i = 0; i < 100; i++) {
      const current = await getProviderTest(started?.id ?? "missing");
      if (current?.status !== "running") return current;
      await Bun.sleep(10);
    }
    throw new Error("probe did not finish");
  }
  for (const code of [401, 403, 404, 429, 500]) {
    status = code;
    const result = await probe();
    expect(result?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
  }
  status = 200;
  const result = await probe();
  expect(result?.status).toBe("success");
  expect(calls).toBe(6);
  expect(seenAuth).toBe("Bearer synthetic-token");
  const now = await currentSettings();
  await saveConnection(
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: { model: "new-model" },
      expectedRevision: now.revision,
      operationId: randomUUID(),
    }),
    saved.value.id,
  );
  expect((await getProviderTest(result?.id ?? "missing"))?.status).toBe("stale");
});

test("editing a stable fixed connection updates exact routes and keeps custom models", async () => {
  await baseline();
  const saved = await saveConnection(
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: {
        name: "Worker",
        apiBaseUrl: "http://127.0.0.1:10001",
        apiPath: "/v1/chat/completions",
        model: "old",
      },
      expectedRevision: (await currentSettings()).revision,
      operationId: randomUUID(),
    }),
  );
  let state = await currentSettings();
  const oldRow = connectionRows(state.settings).find((r) => r.id === saved.value.id);
  if (!oldRow) throw new Error("missing connection");
  const encoded = localConnectionModel(oldRow);
  await patchSection({
    section: "taskRouting",
    changes: {
      findCandidate: {
        source: { provider: "local-llm", model: encoded, localLlmModel: encoded, fallback: [] },
        vibe: { provider: "openai", model: "custom", fallback: [] },
      },
    },
    expectedRevision: state.revision,
    operationId: randomUUID(),
  });
  state = await currentSettings();
  await saveConnection(
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: { apiBaseUrl: "http://127.0.0.1:10002", model: "new" },
      expectedRevision: state.revision,
      operationId: randomUUID(),
    }),
    saved.value.id,
  );
  state = await currentSettings();
  const newRow = connectionRows(state.settings).find((r) => r.id === saved.value.id);
  if (!newRow) throw new Error("missing connection");
  expect(state.settings.taskRouting.findCandidate.source).toMatchObject({
    model: newRow.model,
    localLlmModel: newRow.model,
  });
  expect(state.settings.taskRouting.findCandidate.vibe.model).toBe("custom");
  const stored = await findSettingsRow(SETTINGS_DOCUMENT_NAMESPACE, SETTINGS_DOCUMENT_KEY);
  expect(
    (stored?.value.settings as typeof state.settings).taskRouting.findCandidate.source,
  ).toMatchObject({
    model: localConnectionModel(newRow),
    localLlmModel: localConnectionModel(newRow),
  });
});
test("connection test receipt cannot be replayed for another request", async () => {
  await baseline();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }),
  });
  const saved = await saveConnection(
    connectionInputSchema.parse({
      kind: "local-llm",
      fields: {
        name: "receipt",
        apiBaseUrl: server.url.origin,
        apiPath: "/v1/chat/completions",
        model: "receipt",
      },
      expectedRevision: (await currentSettings()).revision,
      operationId: randomUUID(),
    }),
  );
  const operationId = randomUUID();
  const original = await startProviderTest({ operationId, id: saved.value.id });
  expect((await startProviderTest({ operationId, id: saved.value.id }))?.id).toBe(original?.id);
  await expect(startProviderTest({ operationId, id: "another" })).rejects.toThrow(
    "operation_id_conflict",
  );
  for (let i = 0; i < 100; i++) {
    if ((await getProviderTest(original?.id ?? ""))?.status !== "running") break;
    await Bun.sleep(10);
  }
  expect((await getProviderTest(original?.id ?? ""))?.status).toBe("success");
});
