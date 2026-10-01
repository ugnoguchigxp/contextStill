import {
  WikiError,
  wikiFailureSchema,
  wikiListSuccessSchema,
  wikiReadSuccessSchema,
  wikiWriteSuccessSchema,
} from "../modules/sources/wiki/wiki-contract.js";
import type { WikiOptions } from "./wiki-options.js";
export function wikiBaseUrl(raw: string): string {
  // Reject alternate numeric host spellings before URL normalization.
  if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):[0-9]+\/?$/.test(raw))
    throw new WikiError("INVALID_API_URL", 401);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WikiError("INVALID_API_URL", 401);
  }
  const port = Number(raw.match(/:([0-9]+)\/?$/)?.[1]);
  if (port < 1 || port > 65535) throw new WikiError("INVALID_API_URL", 401);
  return url.origin;
}
export async function wikiRequest(
  options: WikiOptions,
  body: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<{ status: number; result: Record<string, unknown> }> {
  const base = wikiBaseUrl(env.CONTEXT_STILL_WIKI_API_URL ?? "http://127.0.0.1:39170");
  const key = env.CONTEXT_STILL_ADMIN_API_KEY;
  if (!key?.trim() || /[\r\n]/.test(key)) throw new WikiError("ADMIN_KEY_REQUIRED", 401);
  const write = options.command === "create" || options.command === "update";
  const suffix =
    options.command === "list" || options.command === "create"
      ? "/cli/pages"
      : `/cli/pages/${options.slug?.split("/").map(encodeURIComponent).join("/")}`;
  const payload = write
    ? JSON.stringify({
        slug: options.slug,
        body,
        title: options.title,
        ifVersion: options.ifVersion,
        requestId: options.requestId,
        extract: options.extract,
      })
    : undefined;
  if (payload && Buffer.byteLength(payload) > 16 * 1024 * 1024)
    throw new WikiError("REQUEST_TOO_LARGE", 413);
  try {
    const response = await request(`${base}/api/sources${suffix}`, {
      method: options.command === "create" ? "POST" : options.command === "update" ? "PUT" : "GET",
      headers: { "x-admin-api-key": key, "content-type": "application/json" },
      body: payload,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.body) throw new Error("missing response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32 * 1024 * 1024) throw new Error("response limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      if (response.status < 400) throw new Error("invalid response");
      result = null;
    }
    if (response.ok && response.status !== 207) {
      const schema = write
        ? wikiWriteSuccessSchema
        : options.command === "get"
          ? wikiReadSuccessSchema
          : wikiListSuccessSchema;
      const parsed = schema.safeParse(result);
      if (!parsed.success || parsed.data.command !== options.command)
        throw new Error("invalid success");
      if (
        write &&
        "operationId" in parsed.data &&
        parsed.data.operationId.toLowerCase() !== options.requestId?.toLowerCase()
      )
        throw new Error("wrong operation");
      if (
        options.command !== "list" &&
        "page" in parsed.data &&
        parsed.data.page.slug !== options.slug
      )
        throw new Error("wrong page");
      return { status: response.status, result: parsed.data };
    }
    const failure = wikiFailureSchema.safeParse(result);
    if (
      response.status === 207 &&
      (!failure.success ||
        !failure.data.phase ||
        !failure.data.operationId ||
        !failure.data.fileState ||
        !failure.data.indexState ||
        failure.data.operationId.toLowerCase() !== options.requestId?.toLowerCase())
    )
      throw new Error("invalid partial result");
    const errorResult = failure.success
      ? failure.data
      : {
          ok: false,
          error: {
            code: `HTTP_${response.status}`,
            message: `HTTP_${response.status}`,
            retryable: response.status >= 500,
          },
        };
    return { status: response.status, result: errorResult };
  } catch {
    throw new WikiError(write ? "WRITE_OUTCOME_UNKNOWN" : "CONNECTION_FAILED", 503, true);
  }
}
