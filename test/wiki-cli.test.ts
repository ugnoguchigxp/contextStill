import { describe, expect, test, vi } from "vitest";
import { wikiBaseUrl, wikiRequest } from "../src/cli/wiki-client.js";
import { parseWikiOptions } from "../src/cli/wiki-options.js";
import { readWikiInput, runWiki } from "../src/cli/wiki.js";
import { strictWikiSlug, wikiExitCode } from "../src/modules/sources/wiki/wiki-contract.js";
const id = "9c78b38b-2d4b-4ce5-a0cc-8c9e8290f923";
const version = `sha256:${"a".repeat(64)}`;
describe("Wiki CLI contract", () => {
  test("explicit write choices, title, version, input and request ID", () => {
    expect(
      parseWikiOptions([
        "create",
        "notes/test",
        "--title",
        "題名",
        "--stdin",
        "--no-extract",
        "--request-id",
        id,
      ]).extract,
    ).toBe(false);
    expect(
      parseWikiOptions([
        "update",
        "notes/test",
        "--file",
        "note.md",
        "--if-version",
        version,
        "--extract",
        "--request-id",
        id,
      ]).ifVersion,
    ).toBe(version);
    for (const args of [
      ["create", "notes/test", "--title", "Title", "--stdin", "--request-id", id],
      ["update", "notes/test", "--stdin", "--no-extract", "--request-id", id],
      ["get", "notes/test", "--json", "--format", "markdown"],
      ["get", "notes/test", "--body", "secret"],
      ["list", "--stdin"],
      [
        "create",
        "notes/test",
        "--title",
        "Title",
        "--stdin",
        "--file",
        "a",
        "--no-extract",
        "--request-id",
        id,
      ],
    ])
      expect(() => parseWikiOptions(args)).toThrow();
  });
  test("reject normalized traversal and aliases", () => {
    for (const slug of [
      "/notes/a",
      "notes/../a",
      "notes//a",
      "notes\\a",
      "notes/%2e%2e/a",
      "notes/%252e/a",
      "notes/a\u0000",
      "notes/index",
    ])
      expect(() => strictWikiSlug(slug)).toThrow();
  });
  test("literal loopback URL only", () => {
    expect(wikiBaseUrl("http://[::1]:39170")).toBe("http://[::1]:39170");
    for (const url of [
      "https://127.0.0.1:39170",
      "http://localhost:39170",
      "http://127.1:39170",
      "http://2130706433:39170",
      "http://127.0.0.1",
      "http://127.0.0.1:0",
      "http://127.0.0.1:70000",
      "http://127.0.0.1:39170/api",
      "http://user@127.0.0.1:39170",
      "http://127.0.0.1:39170?x",
    ])
      expect(() => wikiBaseUrl(url)).toThrow();
  });
  test("UTF-8, frontmatter and bounded input", async () => {
    async function* chunks(bytes: Uint8Array) {
      yield bytes;
    }
    expect(await readWikiInput(chunks(Buffer.from("日本語")))).toBe("日本語");
    await expect(readWikiInput(chunks(Buffer.from([0xff])))).rejects.toThrow("INVALID_UTF8");
    await expect(readWikiInput(chunks(Buffer.from("---\ntitle: a\n---\nbody")))).rejects.toThrow(
      "INVALID_BODY",
    );
    await expect(readWikiInput(chunks(Buffer.alloc(8 * 1024 * 1024 + 1)))).rejects.toThrow(
      "INPUT_TOO_LARGE",
    );
  });
  test("four HTTP methods, paths and redirect refusal", async () => {
    const env = { CONTEXT_STILL_ADMIN_API_KEY: "test-key" };
    const request = vi.fn(async (_url, init) => {
      const command =
        init?.method === "POST"
          ? "create"
          : init?.method === "PUT"
            ? "update"
            : String(_url).endsWith("/pages")
              ? "list"
              : "get";
      const page = {
        slug: "notes/日本語",
        title: "Title",
        version,
        body: "text",
        meta: {},
        path: "notes/日本語.md",
      };
      const result =
        command === "list"
          ? { ok: true, command, items: [page] }
          : command === "get"
            ? { ok: true, command, page }
            : {
                ok: true,
                command,
                page: { slug: page.slug, version },
                operationId: id,
                commit: "a".repeat(40),
                sourceId: "source",
                fileState: "saved",
                indexState: "ready",
                extractionState: "not_requested",
                knowledgeState: "not_requested",
              };
      return new Response(JSON.stringify(result), { status: 200 });
    }) as unknown as typeof fetch;
    for (const command of ["list", "get", "create", "update"] as const) {
      const options = {
        command,
        slug: "notes/日本語",
        title: "Title",
        stdin: false,
        json: true,
        requestId: id,
        extract: false,
        ifVersion: version,
      };
      await wikiRequest(
        options,
        command === "create" || command === "update" ? "text" : undefined,
        env,
        request,
      );
    }
    const calls = vi.mocked(request).mock.calls;
    expect(calls.map((call) => call[1]?.method)).toEqual(["GET", "GET", "POST", "PUT"]);
    expect(calls[1]?.[0]).toBe(
      "http://127.0.0.1:39170/api/sources/cli/pages/notes/%E6%97%A5%E6%9C%AC%E8%AA%9E",
    );
    expect(calls[2]?.[1]?.redirect).toBe("error");
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toMatchObject({
      requestId: id,
      extract: false,
      body: "text",
    });
    await expect(
      wikiRequest({ command: "list", stdin: false, json: false }, undefined, {}, request),
    ).rejects.toThrow("ADMIN_KEY_REQUIRED");
  });
  test("uncertain writes do not retry", async () => {
    const request = vi.fn(async () => {
      throw new Error("secret-key");
    }) as unknown as typeof fetch;
    await expect(
      wikiRequest(
        { command: "create", slug: "notes/a", stdin: true, json: true },
        "body",
        { CONTEXT_STILL_ADMIN_API_KEY: "key" },
        request,
      ),
    ).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
    expect(request).toHaveBeenCalledTimes(1);
  });
  test("exit code mapping and JSON argument failures", async () => {
    expect([400, 401, 404, 412, 503, 207, 500].map(wikiExitCode)).toEqual([2, 3, 4, 5, 6, 7, 1]);
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runWiki(["create", "--json"])).toBe(2);
    expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    out.mockRestore();
  });
  test("HTTP 200 failure is never accepted as a successful write", async () => {
    const response = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: { code: "FAILED" } })),
    ) as unknown as typeof fetch;
    await expect(
      wikiRequest(
        { command: "create", slug: "notes/a", stdin: true, json: true },
        "body",
        { CONTEXT_STILL_ADMIN_API_KEY: "key" },
        response,
      ),
    ).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
  });

  test("non-JSON authentication failures preserve their HTTP exit classification", async () => {
    const request = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    const result = await wikiRequest(
      { command: "list", stdin: false, json: true },
      undefined,
      { CONTEXT_STILL_ADMIN_API_KEY: "key" },
      request,
    );
    expect(wikiExitCode(result.status)).toBe(3);
    expect(result.result).toMatchObject({ ok: false, error: { code: "HTTP_401" } });
  });
  test("rejects malformed get results", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, command: "get", page: { body: "private" } })),
    ) as unknown as typeof fetch;
    await expect(
      wikiRequest(
        { command: "get", slug: "notes/a", stdin: false, json: true },
        undefined,
        { CONTEXT_STILL_ADMIN_API_KEY: "key" },
        request,
      ),
    ).rejects.toThrow("CONNECTION_FAILED");
  });
  test("slug length and C1 control characters are rejected before requests", () => {
    for (const slug of [
      `notes/${"x".repeat(256)}`,
      `notes/${String.fromCharCode(0x85)}`,
      `notes/${Array(100).fill("segment123").join("/")}`,
    ])
      expect(() => strictWikiSlug(slug)).toThrow();
  });
});

test("a write response for a different operation is not accepted", async () => {
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          command: "create",
          page: { slug: "notes/a", version },
          operationId: "11111111-1111-4111-8111-111111111111",
          commit: "a".repeat(40),
          sourceId: "source",
          fileState: "saved",
          indexState: "ready",
          extractionState: "not_requested",
          knowledgeState: "not_requested",
        }),
      ),
  ) as unknown as typeof fetch;
  await expect(
    wikiRequest(
      { command: "create", slug: "notes/a", requestId: id, stdin: true, json: true },
      "body",
      { CONTEXT_STILL_ADMIN_API_KEY: "key" },
      request,
    ),
  ).rejects.toThrow("WRITE_OUTCOME_UNKNOWN");
});
