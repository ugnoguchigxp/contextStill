import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectMarkdownFiles } from "../src/modules/sources/markdown-importer.service.js";

describe("markdown importer file collection", () => {
  test("collects only markdown files recursively", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "memory-router-md-"));
    const nested = path.join(root, "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, "a.md"), "# a");
    await writeFile(path.join(nested, "b.md"), "# b");
    await writeFile(path.join(nested, "c.txt"), "not markdown");

    const files = await collectMarkdownFiles(root);
    expect(files.length).toBe(2);
    expect(files.every((file) => file.endsWith(".md"))).toBe(true);

    await rm(root, { recursive: true, force: true });
  });
});
