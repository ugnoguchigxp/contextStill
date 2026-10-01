import { Hono } from "hono";
import { z } from "zod";
import { groupedConfig } from "../../../src/config.js";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { probeSqliteWriter } from "../../../src/db/sqlite/writer-client.js";
import { upsertSourceDocument } from "../../../src/modules/sources/source.repository.js";
import { WikiError } from "../../../src/modules/sources/wiki/wiki-contract.js";
import {
  WikiPageService,
  type WikiWrite,
} from "../../../src/modules/sources/wiki/wiki-page.service.js";
import { readProjectEnv } from "../../../src/project-identity.js";
import { isAuthorizedAdminApiKey } from "../../middleware/admin-session.js";

const writeSchema = z
  .object({
    slug: z.string(),
    title: z.string().optional(),
    body: z.string(),
    ifVersion: z.string().optional(),
    requestId: z.string(),
    extract: z.boolean(),
  })
  .strict();
function service() {
  return new WikiPageService({
    root: groupedConfig.sourceContent.root,
    namespace: readProjectEnv("WIKI_CLI_NAMESPACE")?.trim() ?? "",
    preflight: async () => {
      const backend = resolveDatabaseBackendConfig();
      if (backend.kind !== "sqlite" || !backend.sqlitePath)
        throw new WikiError("BACKEND_UNSUPPORTED", 422);
      // A loopback daemon URL alone cannot prove its downstream provider is private.
      // Disabled embeddings still retain atomic, searchable text fragments.
      if (groupedConfig.embedding.provider !== "disabled")
        throw new WikiError("PRIVATE_EMBEDDING_REQUIRED", 422);
      await probeSqliteWriter(AbortSignal.timeout(5000), backend.sqlitePath);
    },
    index: (page) =>
      upsertSourceDocument({
        sourceKind: "wiki",
        scope: "global",
        uri: page.path,
        title: page.title,
        body: page.body,
        metadata: page.meta,
        actor: "user",
      }),
  });
}
function pathSlug(url: string): string {
  const pathname = new URL(url).pathname;
  const prefix = "/cli/pages/";
  const start = pathname.indexOf(prefix);
  const raw = start < 0 ? "" : pathname.slice(start + prefix.length);
  if (/%2f|%5c/i.test(raw)) throw new WikiError("INVALID_SLUG", 400);
  try {
    return raw
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    throw new WikiError("INVALID_SLUG", 400);
  }
}
export const wikiCliRouter = new Hono()
  .use("*", async (c, next) => {
    if (!readProjectEnv("WIKI_CLI_NAMESPACE")?.trim())
      return c.json(
        {
          ok: false,
          error: { code: "WIKI_CLI_DISABLED", message: "WIKI_CLI_DISABLED", retryable: false },
        },
        503,
      );
    const key = c.req.header("x-admin-api-key") ?? "";
    if (!key || !isAuthorizedAdminApiKey(groupedConfig.admin.apiKey, key))
      return c.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "UNAUTHORIZED", retryable: false } },
        401,
      );
    await next();
  })
  .onError((error, c) => {
    const safe = error instanceof WikiError ? error : new WikiError("INTERNAL_ERROR", 500);
    return c.json(
      { ok: false, error: { code: safe.code, message: safe.code, retryable: safe.retryable } },
      safe.status,
    );
  })
  .get("/pages", async (c) => c.json(await service().list()))
  .get("/pages/*", async (c) => c.json(await service().get(pathSlug(c.req.url))))
  .on(["POST", "PUT"], ["/pages", "/pages/*"], async (c) => {
    if ((c.req.method === "POST") !== c.req.routePath.endsWith("/pages"))
      throw new WikiError("INVALID_ARGUMENTS", 400);
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength > 16 * 1024 * 1024) throw new WikiError("REQUEST_TOO_LARGE", 413);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new WikiError("INVALID_INPUT", 400);
    }
    const parsed = writeSchema.safeParse(value);
    if (!parsed.success) throw new WikiError("INVALID_INPUT", 400);
    const input: WikiWrite = {
      ...parsed.data,
      command: c.req.method === "POST" ? "create" : "update",
    };
    if (input.command === "update" && pathSlug(c.req.url) !== input.slug)
      throw new WikiError("INVALID_SLUG", 400);
    const output = await service().write(input);
    return c.json(output.result, output.status);
  });
