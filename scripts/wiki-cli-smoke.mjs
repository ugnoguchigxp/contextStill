import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createIsolatedRuntime, freePort, projectRoot } from "./testing/isolated-runtime.mjs";

const runtime = await createIsolatedRuntime();
try {
  runtime.env.CONTEXT_STILL_WIKI_CLI_NAMESPACE = "notes";
  // Keep the temporary fixture canonical on macOS (/var aliases /private/var).
  const { realpath } = await import("node:fs/promises");
  runtime.env.CONTEXT_STILL_APP_DATA_DIR = await realpath(runtime.directory);
  runtime.env.CONTEXT_STILL_SOURCE_CONTENT_ROOT = await realpath(
    runtime.env.CONTEXT_STILL_SOURCE_CONTENT_ROOT,
  );
  await runtime.initialize();
  const root = runtime.env.CONTEXT_STILL_SOURCE_CONTENT_ROOT;
  await mkdir(path.join(root, "pages"), { recursive: true });
  await runtime.run("git", ["-C", root, "init", "-q"]);
  await runtime.run("git", ["-C", root, "config", "user.name", "Wiki Test"]);
  await runtime.run("git", ["-C", root, "config", "user.email", "wiki@example.invalid"]);
  const port = await freePort();
  runtime.env.CONTEXT_STILL_WIKI_API_URL = `http://127.0.0.1:${port}`;
  await runtime.startApi(port);
  const cli = async (...args) =>
    JSON.parse(
      await runtime.run("bun", [
        "--no-env-file",
        path.join(projectRoot, "src/cli/context-still.ts"),
        "wiki",
        ...args,
      ]),
    );
  const file = path.join(runtime.directory, "body.md");
  await writeFile(file, "First isolated page");
  const id = randomUUID();
  const args = [
    "create",
    "notes/example",
    "--title",
    "Title",
    "--file",
    file,
    "--no-extract",
    "--request-id",
    id,
    "--json",
  ];
  const created = await cli(...args);
  assert.equal(created.ok, true);
  assert.equal(created.fileState, "saved");
  assert.equal(created.indexState, "ready");
  assert.deepEqual(await cli(...args), created);
  const page = (await cli("get", "notes/example", "--json")).page;
  assert.equal(page.version, created.page.version);
  assert.equal(page.body, "First isolated page\n");
  assert.equal((await cli("list", "--json")).items.length, 1);
  await writeFile(file, "Updated isolated page");
  const update = await cli(
    "update",
    "notes/example",
    "--file",
    file,
    "--no-extract",
    "--if-version",
    page.version,
    "--request-id",
    randomUUID(),
    "--json",
  );
  assert.equal(update.ok, true);
  const rows = await runtime.writer(
    "SELECT id, body FROM sources WHERE uri = ?",
    ["notes/example.md"],
    "all",
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].body, "Updated isolated page\n");
  const orphans = await runtime.writer(
    "SELECT COUNT(*) AS count FROM source_fragments_fts WHERE id NOT IN (SELECT id FROM source_fragments)",
    [],
    "get",
  );
  assert.equal(orphans.rows[0].count, 0);
  const fragments = await runtime.writer(
    "SELECT content FROM source_fragments WHERE source_id = ?",
    [rows.rows[0].id],
    "all",
  );
  assert.equal(fragments.rows.length, 1);
  assert.equal(fragments.rows[0].content, "Updated isolated page");
  assert.equal(await runtime.run("git", ["-C", root, "rev-list", "--count", "HEAD"]), "2");

  // Force fragment replacement to fail, proving source+fragment rollback at the real writer.
  await runtime.writer(
    "CREATE TRIGGER wiki_test_fail BEFORE INSERT ON source_fragments BEGIN SELECT RAISE(ABORT, 'isolated fragment failure'); END",
    [],
    "exec",
  );
  const previousVersion = update.page.version;
  await writeFile(file, "Failed replacement");
  const retryId = randomUUID();
  const retryArgs = [
    "update",
    "notes/example",
    "--file",
    file,
    "--no-extract",
    "--if-version",
    previousVersion,
    "--request-id",
    retryId,
    "--json",
  ];
  const response = await fetch(
    `${runtime.env.CONTEXT_STILL_WIKI_API_URL}/api/sources/cli/pages/notes/example`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-api-key": runtime.env.CONTEXT_STILL_ADMIN_API_KEY,
      },
      body: JSON.stringify({
        slug: "notes/example",
        body: await readFile(file, "utf8"),
        ifVersion: previousVersion,
        requestId: retryId,
        extract: false,
      }),
    },
  );
  assert.equal(response.status, 207);
  const unchanged = await runtime.writer(
    "SELECT body FROM sources WHERE uri = ?",
    ["notes/example.md"],
    "all",
  );
  assert.equal(unchanged.rows[0].body, "Updated isolated page\n");
  assert.equal(
    (
      await runtime.writer(
        "SELECT content FROM source_fragments WHERE source_id = ?",
        [rows.rows[0].id],
        "all",
      )
    ).rows[0].content,
    "Updated isolated page",
  );
  await runtime.writer("DROP TRIGGER wiki_test_fail", [], "exec");
  assert.equal((await cli(...retryArgs)).ok, true);
  assert.equal(await runtime.run("git", ["-C", root, "rev-list", "--count", "HEAD"]), "3");

  // The existing UI route participates in the same write path and invalidates CLI versions.
  const beforeUi = (await cli("get", "notes/example", "--json")).page.version;
  const ui = await fetch(
    `${runtime.env.CONTEXT_STILL_WIKI_API_URL}/api/sources/pages/notes/example`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-api-key": runtime.env.CONTEXT_STILL_ADMIN_API_KEY,
      },
      body: JSON.stringify({ body: "UI update" }),
    },
  );
  assert.equal(ui.status, 200);
  const stale = await fetch(
    `${runtime.env.CONTEXT_STILL_WIKI_API_URL}/api/sources/cli/pages/notes/example`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-admin-api-key": runtime.env.CONTEXT_STILL_ADMIN_API_KEY,
      },
      body: JSON.stringify({
        slug: "notes/example",
        body: "Stale update",
        ifVersion: beforeUi,
        requestId: randomUUID(),
        extract: false,
      }),
    },
  );
  assert.equal(stale.status, 412);

  // Paths containing the endpoint's own segments must still be decoded in full.
  const nestedSlug = "notes/cli/pages/example";
  const nested = await cli(
    "create",
    nestedSlug,
    "--title",
    "Nested",
    "--file",
    file,
    "--no-extract",
    "--request-id",
    randomUUID(),
    "--json",
  );
  assert.equal(nested.ok, true);
  assert.equal((await cli("get", nestedSlug, "--json")).page.slug, nestedSlug);

  // Exercise the maximum body size through the actual 30-second writer transaction lease.
  const largeBody = "abcdefghij"
    .repeat(Math.ceil((8 * 1024 * 1024) / 10))
    .slice(0, 8 * 1024 * 1024);
  await writeFile(file, largeBody);
  const started = Date.now();
  const large = await cli(
    "create",
    "notes/large",
    "--title",
    "Large",
    "--file",
    file,
    "--no-extract",
    "--request-id",
    randomUUID(),
    "--json",
  );
  assert.equal(large.ok, true);
  const largeRows = await runtime.writer(
    "SELECT content FROM source_fragments WHERE source_id = ? ORDER BY locator",
    [large.sourceId],
    "all",
  );
  assert.equal(largeRows.rows.map((row) => row.content).join(""), largeBody);
  const finalOrphans = await runtime.writer(
    "SELECT COUNT(*) AS count FROM source_fragments_fts WHERE id NOT IN (SELECT id FROM source_fragments)",
    [],
    "get",
  );
  assert.equal(finalOrphans.rows[0].count, 0);
  console.log(
    JSON.stringify({
      largeBodyBytes: largeBody.length,
      largeWriteMs: Date.now() - started,
      fragments: largeRows.rows.length,
    }),
  );

  const headingBody = `intro\n# ${largeBody.slice(0, largeBody.length - 8)}`;
  await writeFile(file, headingBody);
  const headingUpdate = await cli(
    "update",
    "notes/large",
    "--file",
    file,
    "--if-version",
    large.page.version,
    "--no-extract",
    "--request-id",
    randomUUID(),
    "--json",
  );
  assert.equal(headingUpdate.ok, true);
  const headingRows = await runtime.writer(
    "SELECT length(heading) AS length FROM source_fragments WHERE source_id = ?",
    [large.sourceId],
    "all",
  );
  assert.ok(headingRows.rows.every((row) => row.length <= 2500));
  const bodyRow = await runtime.writer(
    "SELECT body FROM sources WHERE id = ?",
    [large.sourceId],
    "get",
  );
  assert.equal(bodyRow.rows[0].body, `${headingBody}\n`);

  // Stop the owner: preflight must refuse a new write before touching Markdown.
  await runtime.stopWriter();
  const offline = await fetch(`${runtime.env.CONTEXT_STILL_WIKI_API_URL}/api/sources/cli/pages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-api-key": runtime.env.CONTEXT_STILL_ADMIN_API_KEY,
    },
    body: JSON.stringify({
      slug: "notes/offline",
      title: "Offline",
      body: "Never saved",
      requestId: randomUUID(),
      extract: false,
    }),
  });
  assert.equal(offline.status, 503);
  assert.deepEqual(
    (await cli("list", "--json")).items.map((item) => item.slug),
    ["notes/cli/pages/example", "notes/example", "notes/large"],
  );
  console.log(
    JSON.stringify({
      ok: true,
      writer: "Rust",
      runtime: "production",
      atomicRollback: true,
      idempotentRetry: true,
      noWriterFallback: true,
    }),
  );
} finally {
  await runtime.cleanup();
}
