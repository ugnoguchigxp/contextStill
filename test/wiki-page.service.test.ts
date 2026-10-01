import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WikiPageService } from "../src/modules/sources/wiki/wiki-page.service.js";
import { wikiStateRoot, withWikiWriteLock } from "../src/modules/sources/wiki/wiki-write-state.js";
const execute = promisify(execFile);
describe("Wiki page service with isolated real Git", () => {
  let directory: string;
  let root: string;
  let service: WikiPageService;
  const index = vi.fn(async () => "source-id");
  const preflight = vi.fn(async () => {});
  const git = async (...args: string[]) =>
    (await execute("git", ["-C", root, ...args])).stdout.trim();
  const create = (slug = "notes/example", body = "Hello") => ({
    command: "create" as const,
    slug,
    title: "Title",
    body,
    requestId: randomUUID(),
    extract: false,
  });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-cli-test-"));
    directory = await fs.realpath(directory);
    vi.stubEnv("CONTEXT_STILL_APP_DATA_DIR", path.join(directory, "runtime"));
    root = path.join(directory, "wiki");
    await fs.mkdir(path.join(root, "pages"), { recursive: true });
    await git("init", "-q");
    await git("config", "user.name", "Wiki Test");
    await git("config", "user.email", "wiki@example.invalid");
    await git("config", "core.hooksPath", path.join(root, ".git", "hooks"));
    index.mockReset();
    index.mockResolvedValue("source-id");
    preflight.mockReset();
    preflight.mockResolvedValue();
    service = new WikiPageService({ root, namespace: "notes", index, preflight });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });
  test("create/get/list/update agree, preserve metadata and reuse operation result", async () => {
    const input = create();
    const first = await service.write(input);
    expect(first.result).toMatchObject({
      ok: true,
      fileState: "saved",
      indexState: "ready",
      extractionState: "not_requested",
    });
    const page = (await service.get(input.slug)).page;
    expect(page.body).toBe("Hello\n");
    expect(page.version).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await service.list()).items).toEqual([
      { slug: input.slug, title: "Title", version: page.version },
    ]);
    const update = {
      command: "update" as const,
      slug: input.slug,
      body: "Updated",
      requestId: randomUUID(),
      ifVersion: page.version,
      extract: false,
    };
    expect((await service.write(update)).status).toBe(200);
    expect((await service.get(input.slug)).page.title).toBe("Title");
    expect((await service.write(input)).result).toEqual(first.result);
    expect(await git("rev-list", "--count", "HEAD")).toBe("2");
    expect(index).toHaveBeenCalledTimes(2);
    await expect(service.write({ ...input, body: "different" })).rejects.toThrow(
      "REQUEST_ID_CONFLICT",
    );
    expect((await service.write({ ...update, requestId: randomUUID() })).status).toBe(412);
  });
  test("parallel updates and creates have one winner", async () => {
    const a = create();
    const results = await Promise.allSettled([
      service.write(a),
      service.write({ ...a, requestId: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const page = (await service.get(a.slug)).page;
    const update = {
      command: "update" as const,
      slug: a.slug,
      body: "A",
      ifVersion: page.version,
      extract: false,
      requestId: randomUUID(),
    };
    const updates = await Promise.all([
      service.write(update),
      service.write({ ...update, body: "B", requestId: randomUUID() }),
    ]);
    expect(updates.map((r) => r.status).sort()).toEqual([200, 412]);
  });
  test("namespace, symlink and unsupported extraction reject before save", async () => {
    for (const slug of ["notes-other/a", "other/a", "/notes/a", "notes/%2e%2e/a"])
      await expect(service.write(create(slug))).rejects.toThrow();
    await expect(service.write({ ...create(), extract: true })).rejects.toThrow(
      "EXTRACTION_UNSUPPORTED",
    );
    await fs.symlink(directory, path.join(root, "pages", "notes"));
    await expect(service.get("notes/example")).rejects.toThrow();
    await expect(service.list()).rejects.toThrow();
    expect(await fs.readdir(path.join(root, "pages"))).toEqual(["notes"]);
    expect(index).not.toHaveBeenCalled();
  });
  test("unrelated staged changes and manual target edits are preserved", async () => {
    await fs.writeFile(path.join(root, "unrelated.txt"), "staged");
    await git("add", "unrelated.txt");
    await expect(service.write(create())).rejects.toThrow("GIT_STAGED_CHANGES");
    expect(await git("diff", "--cached", "--name-only")).toBe("unrelated.txt");
    await git("commit", "-qm", "baseline");
    const input = create();
    await service.write(input);
    const page = (await service.get(input.slug)).page;
    await fs.appendFile(path.join(root, "pages", "notes", "example.md"), "manual");
    const changed = (await service.get(input.slug)).page;
    await expect(
      service.write({
        command: "update",
        slug: input.slug,
        body: "replacement",
        ifVersion: changed.version,
        requestId: randomUUID(),
        extract: false,
      }),
    ).rejects.toThrow("PAGE_DIRTY");
    expect(changed.version).not.toBe(page.version);
  });
  test("DB failure resumes the same ID without another Git commit", async () => {
    const input = create();
    index.mockRejectedValueOnce(new Error("private path"));
    const partial = await service.write(input);
    expect(partial.status).toBe(207);
    expect(partial.result.phase).toBe("committed");
    await expect(service.write({ ...input, requestId: randomUUID() })).rejects.toThrow(
      "OPERATION_PENDING",
    );
    expect((await service.write(input)).status).toBe(200);
    expect(await git("rev-list", "--count", "HEAD")).toBe("1");
    const records = await fs.readdir(path.join(wikiStateRoot(root), "operations"));
    const raw = await fs.readFile(path.join(wikiStateRoot(root), "operations", records[0]), "utf8");
    expect(raw).not.toContain("Hello");
    expect(raw).not.toContain("private path");
  });
  test("Git failure resumes after file save", async () => {
    const input = create();
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect((await service.write(input)).status).toBe(207);
    await fs.rm(hook);
    expect((await service.write(input)).status).toBe(200);
    expect(await git("rev-list", "--count", "HEAD")).toBe("1");
  });
  test("writer failure causes no Markdown mutation and stale locks are retained", async () => {
    preflight.mockRejectedValueOnce(new Error("offline"));
    await expect(service.write(create())).rejects.toThrow("WRITER_UNAVAILABLE");
    expect(await fs.readdir(path.join(root, "pages"))).toEqual([]);
    const pending = withWikiWriteLock(root, async () => {
      await expect(withWikiWriteLock(root, async () => undefined, 20)).rejects.toThrow("WIKI_BUSY");
    });
    await pending;
  });
  test("recovery after a commit with stale phase does not commit twice", async () => {
    const input = create();
    await service.write(input);
    const file = path.join(wikiStateRoot(root), "operations", `${input.requestId}.json`);
    const op = JSON.parse(await fs.readFile(file, "utf8"));
    op.phase = "saved";
    op.result = undefined;
    op.commit = undefined;
    op.sourceId = undefined;
    await fs.writeFile(file, JSON.stringify(op));
    expect((await service.write(input)).status).toBe(200);
    expect(await git("rev-list", "--count", "HEAD")).toBe("1");
  });
  test("list rejects a symlink directory even when namespace.md exists", async () => {
    await fs.writeFile(path.join(root, "pages", "notes.md"), "Namespace page");
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private.md"), "Private data");
    await fs.symlink(outside, path.join(root, "pages", "notes"));
    await expect(service.list()).rejects.toThrow("INVALID_PAGE");
  });
  test("malformed operation records cannot bypass recovery checks", async () => {
    const input = create();
    await service.write(input);
    const file = path.join(wikiStateRoot(root), "operations", `${input.requestId}.json`);
    await fs.writeFile(file, "null");
    await expect(service.write(input)).rejects.toThrow("RECOVERY_REQUIRED");
  });
  test("a saved operation remains partial when writer is unavailable on retry", async () => {
    const input = create();
    index.mockRejectedValueOnce(new Error("offline"));
    expect((await service.write(input)).status).toBe(207);
    preflight.mockRejectedValueOnce(new Error("writer offline"));
    const resumed = await service.write(input);
    expect(resumed.status).toBe(207);
    expect(resumed.result).toMatchObject({ phase: "committed", fileState: "saved" });
  });
  test("commit recovery tolerates a later commit on a different page", async () => {
    const input = create();
    await service.write(input);
    const file = path.join(wikiStateRoot(root), "operations", `${input.requestId}.json`);
    const op = JSON.parse(await fs.readFile(file, "utf8"));
    op.phase = "saved";
    op.result = undefined;
    op.commit = undefined;
    op.sourceId = undefined;
    await fs.writeFile(file, JSON.stringify(op));
    expect((await service.write(create("notes/other"))).status).toBe(200);
    expect((await service.write(input)).status).toBe(200);
    expect(await git("rev-list", "--count", "HEAD")).toBe("2");
  });
  test("different app-data roots cannot bypass the Wiki write lock", async () => {
    await withWikiWriteLock(root, async () => {
      vi.stubEnv("CONTEXT_STILL_APP_DATA_DIR", path.join(directory, "different-runtime"));
      await expect(withWikiWriteLock(root, async () => undefined, 20)).rejects.toThrow("WIKI_BUSY");
    });
  });

  test("recovery preserves a manually replaced target in the Git index", async () => {
    const initial = create();
    await service.write(initial);
    const page = (await service.get(initial.slug)).page;
    const input = {
      command: "update" as const,
      slug: initial.slug,
      body: "New body",
      ifVersion: page.version,
      extract: false,
      requestId: randomUUID(),
    };
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect((await service.write(input)).status).toBe(207);
    await fs.rm(hook);
    const relative = "pages/notes/example.md";
    const oldBlob = await git("rev-parse", `HEAD:${relative}`);
    await git("update-index", "--cacheinfo", "100644", oldBlob, relative);
    const result = await service.write(input);
    expect(result.status).toBe(207);
    expect(result.result).toMatchObject({ error: { code: "RECOVERY_REQUIRED", retryable: false } });
    expect(await git("rev-parse", `:${relative}`)).toBe(oldBlob);
    expect(await git("rev-list", "--count", "HEAD")).toBe("1");
  });
  test("committed recovery rejects a mismatching current Git version", async () => {
    const input = create();
    index.mockRejectedValueOnce(new Error("offline"));
    expect((await service.write(input)).status).toBe(207);
    const file = path.join(root, "pages", "notes", "example.md");
    const saved = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "Manual version");
    await git("add", "--", "pages/notes/example.md");
    await git("commit", "-qm", "manual");
    await fs.writeFile(file, saved);
    const result = await service.write(input);
    expect(result.status).toBe(207);
    expect(result.result).toMatchObject({ error: { code: "RECOVERY_REQUIRED" } });
    expect(index).toHaveBeenCalledTimes(1);
  });
  test("runtime binding rejects an alternate ledger after lock release", async () => {
    await service.write(create());
    vi.stubEnv("CONTEXT_STILL_APP_DATA_DIR", path.join(directory, "alternate-runtime"));
    await expect(service.write(create("notes/new"))).rejects.toThrow("WIKI_RUNTIME_MISMATCH");
  });
  test("ignored targets are rejected before saving or recording an operation", async () => {
    await fs.writeFile(path.join(root, ".gitignore"), "pages/notes/\n");
    await expect(service.write(create())).rejects.toThrow("PAGE_IGNORED");
    expect(await fs.readdir(path.join(root, "pages"))).toEqual([]);
    expect(await fs.readdir(path.join(wikiStateRoot(root), "operations"))).toEqual([]);
  });
  test("case aliases cannot bypass pending-operation protection on a case-insensitive filesystem", async () => {
    const input = create();
    index.mockRejectedValueOnce(new Error("offline"));
    expect((await service.write(input)).status).toBe(207);
    const page = (await service.get(input.slug)).page;
    // A case-sensitive filesystem reports missing; a case-insensitive one rejects the alias.
    await expect(service.get("notes/EXAMPLE")).rejects.toThrow();
    await expect(
      service.write({
        command: "update",
        slug: "notes/EXAMPLE",
        body: "alias",
        ifVersion: page.version,
        requestId: randomUUID(),
        extract: false,
      }),
    ).rejects.toThrow();
    expect((await service.get(input.slug)).page.version).toBe(page.version);
    expect((await service.write(input)).status).toBe(200);
  });
  test("Unicode page names retain a single canonical slug", async () => {
    const input = create("notes/é");
    expect((await service.write(input)).status).toBe(200);
    expect((await service.get(input.slug)).page.slug).toBe(input.slug);
    await expect(service.get(`notes/e${String.fromCharCode(0x301)}`)).rejects.toThrow(
      "INVALID_SLUG",
    );
  });
});
