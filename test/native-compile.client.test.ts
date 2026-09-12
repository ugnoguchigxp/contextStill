import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import fixture from "../shared/context-compile/client-envelope.v1.json";
const mocks = vi.hoisted(() => ({ backend: "sqlite", legacy: vi.fn() }));
vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({
    kind: mocks.backend,
    sqlitePath: "/fixture.sqlite",
    url: "",
  }),
}));
vi.mock("../src/db/sqlite/writer-client.js", () => ({
  resolveWriterEndpoint: () => ({
    url: "http://127.0.0.1:1234/writer/query",
    token: "synthetic-test-token",
  }),
}));
vi.mock("../src/modules/context-compiler/context-compiler.legacy.js", () => ({
  compileContextPack: mocks.legacy,
}));
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import {
  adaptNativeCompile,
  compileNativeContext,
} from "../src/modules/context-compiler/native-compile.client.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.backend = "sqlite";
});
test("adapts the shared native fixture without losing body, refs, identity or diagnostics", () => {
  const result = adaptNativeCompile(fixture, fixture.databaseFingerprint);
  expect(result.pack.runId).toBe(fixture.runId);
  expect(result.pack.rules[0]).toMatchObject({
    itemId: "knowledge-fixture",
    content: fixture.pack.rules[0]?.body,
    sourceRefs: fixture.pack.rules[0]?.sourceRefs,
    scopeSnapshot: { scope: "global" },
  });
  expect(result.markdown).toBe(fixture.markdown);
  expect(() => adaptNativeCompile(fixture, "wrong")).toThrow("binding");
  expect(() =>
    adaptNativeCompile({ ...fixture, contractVersion: 2 }, fixture.databaseFingerprint),
  ).toThrow();
  expect(() =>
    adaptNativeCompile({ ...fixture, contentStatus: "empty" }, fixture.databaseFingerprint),
  ).toThrow("content_status");
});
test("native request binds the configured DB and metadata, and returns the single persisted run", async () => {
  const fingerprint = createHash("sha256")
    .update("context-stilld-effective-db-v1\n/fixture.sqlite")
    .digest("hex");
  const fetch = vi.fn(async () =>
    Response.json({ ok: true, envelope: { ...fixture, databaseFingerprint: fingerprint } }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await compileContextPack(
    {
      goal: "sqlite workflow",
      changeTypes: ["docs"],
      projectRef: "fixture-project",
      repoKey: "fixture-key",
      repoPath: "/fixture-repo",
      domains: ["workflow"],
      technologies: ["sqlite"],
    },
    { source: "cli", sessionId: "session" },
  );
  expect(result.pack.runId).toBe(fixture.runId);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe("/internal/context-compile");
  expect(JSON.parse(String(init.body))).toMatchObject({
    databaseFingerprint: fingerprint,
    input: {
      goal: "sqlite workflow",
      changeTypes: ["docs"],
      projectRef: "fixture-project",
      repoKey: "fixture-key",
      repoPath: "/fixture-repo",
      domains: ["workflow"],
      technologies: ["sqlite"],
    },
    options: { source: "cli", sessionId: "session", retrievalMode: "architecture_context" },
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
});
test("unsupported legacy inputs, unavailable daemon and protocol errors never invoke legacy fallback", async () => {
  const fetch = vi.fn(async () => {
    throw new Error("offline");
  });
  vi.stubGlobal("fetch", fetch);
  for (const extra of [
    { files: [] },
    { includeDraft: true },
    { queryEmbedding: [] },
    { tokenBudget: 127 },
  ])
    await expect(compileNativeContext({ goal: "sqlite workflow", ...extra })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await expect(compileContextPack({ goal: "sqlite workflow" })).rejects.toThrow("transport");
  expect(mocks.legacy).not.toHaveBeenCalled();
});
test("Postgres compatibility is explicit and does not depend on a native failure", async () => {
  mocks.backend = "postgres";
  mocks.legacy.mockResolvedValue({ pack: {}, markdown: "legacy" });
  expect((await compileContextPack({ goal: "sqlite workflow" })).markdown).toBe("legacy");
  expect(mocks.legacy).toHaveBeenCalledTimes(1);
});
