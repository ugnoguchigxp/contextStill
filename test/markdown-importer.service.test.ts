import { readFile, readdir } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  collectMarkdownFiles,
  importMarkdownDirectory,
} from "../src/modules/sources/markdown-importer.service.js";
import {
  deleteStaleSourcesForRoot,
  upsertSourceDocument,
} from "../src/modules/sources/source.repository.js";

vi.mock("node:fs/promises");
vi.mock("../src/modules/sources/source.repository.js");

describe("Markdown Importer Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("collects markdown files recursively", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "a.md", parentPath: "/root" },
      { isFile: () => true, name: "b.txt", parentPath: "/root" },
      { isFile: () => false, name: "subdir", parentPath: "/root" },
    ] as any);

    const files = await collectMarkdownFiles("/root");
    expect(files).toEqual(["/root/a.md"]);
  });

  test("imports a directory of markdown files", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "test.md", parentPath: "/root" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue(
      '---\ntitle: "Frontmatter Title"\n---\n# Heading Title\nBody content',
    );
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");
    vi.mocked(deleteStaleSourcesForRoot).mockResolvedValue(0);

    const result = await importMarkdownDirectory("/root");

    expect(result.importedFiles).toBe(1);
    expect(result.files[0].sourceId).toBe("s1");
    expect(upsertSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Frontmatter Title",
      }),
    );
  });

  test("uses inferred title when frontmatter is missing", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "test.md", parentPath: "/root" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("# Heading Title\nBody content");
    vi.mocked(upsertSourceDocument).mockResolvedValue("s1");

    await importMarkdownDirectory("/root");

    expect(upsertSourceDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Heading Title",
      }),
    );
  });

  test("skips empty files", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { isFile: () => true, name: "empty.md", parentPath: "/root" },
    ] as any);
    vi.mocked(readFile).mockResolvedValue("  \n ");

    const result = await importMarkdownDirectory("/root");

    expect(result.skippedFiles).toBe(1);
    expect(upsertSourceDocument).not.toHaveBeenCalled();
  });
});
