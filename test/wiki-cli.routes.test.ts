import { Hono } from "hono";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { wikiCliRouter } from "../api/modules/sources/wiki-cli.routes.js";
import { groupedConfig } from "../src/config.js";
import { resolveDatabaseBackendConfig } from "../src/db/backend.js";
import { probeSqliteWriter } from "../src/db/sqlite/writer-client.js";
vi.mock("../src/modules/sources/source.repository.js", () => ({ upsertSourceDocument: vi.fn() }));
vi.mock("../src/db/sqlite/writer-client.js", () => ({ probeSqliteWriter: vi.fn() }));
vi.mock("../src/db/backend.js", () => ({ resolveDatabaseBackendConfig: vi.fn() }));
const key = "wiki-test-key-0123456789abcdef0123456789abcdef";
const payload = {
  slug: "notes/test",
  title: "Title",
  body: "body",
  extract: false,
  requestId: "9c78b38b-2d4b-4ce5-a0cc-8c9e8290f923",
};
const app = new Hono().route("/api/sources/cli", wikiCliRouter);
const call = (path: string, body?: unknown, method = "POST", authenticated = true) =>
  app.request(`/api/sources/cli${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { "x-admin-api-key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
beforeEach(() => {
  vi.stubEnv("CONTEXT_STILL_WIKI_CLI_NAMESPACE", "notes");
  vi.spyOn(groupedConfig.admin, "apiKey", "get").mockReturnValue(key);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
test("namespace remains disabled until explicitly configured", async () => {
  vi.stubEnv("CONTEXT_STILL_WIKI_CLI_NAMESPACE", "");
  const response = await call("/pages", undefined, "GET");
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "WIKI_CLI_DISABLED" } });
});
test("requires explicit key even if a session could be present", async () => {
  expect((await call("/pages", undefined, "GET", false)).status).toBe(401);
});
test("missing version, outside namespace and encoded separators are rejected", async () => {
  expect((await call("/pages/notes/test", payload, "PUT")).status).toBe(428);
  expect((await call("/pages", { ...payload, slug: "notes-other/test" })).status).toBe(400);
  expect((await call("/pages/notes%2Ftest", undefined, "GET")).status).toBe(400);
  expect((await call("/pages/notes/%252e%252e", undefined, "GET")).status).toBe(400);
});
test("unsupported extraction does not probe writer or index", async () => {
  const response = await call("/pages", { ...payload, extract: true });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "EXTRACTION_UNSUPPORTED" } });
  expect(probeSqliteWriter).not.toHaveBeenCalled();
  expect(resolveDatabaseBackendConfig).not.toHaveBeenCalled();
});
test("strict JSON payload rejects arbitrary meta and malformed requests", async () => {
  expect((await call("/pages", { ...payload, meta: { secret: "value" } })).status).toBe(400);
  expect((await call("/pages", { ...payload, extract: undefined })).status).toBe(400);
  expect((await call("/pages/notes/other", payload, "PUT")).status).toBe(400);
});

test("slugs ending in cli/pages use the item route instead of the collection route", async () => {
  const response = await call(
    "/pages/notes/cli/pages",
    { ...payload, slug: "notes/cli/pages", extract: true, ifVersion: `sha256:${"a".repeat(64)}` },
    "PUT",
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: { code: "EXTRACTION_UNSUPPORTED" } });
});
