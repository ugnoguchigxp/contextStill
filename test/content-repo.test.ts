import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  ensureContentRoot,
  listPages,
  readPage,
  writePage,
  deletePage,
  createFolder,
  listFolders,
  renameFolder,
  getGitSummary,
  getPageHistory,
} from "../src/modules/sources/wiki/content-repo.js";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

vi.mock("node:fs/promises");
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

describe("Content Repo Service", () => {
  const contentRoot = "/wiki-root";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("ensureContentRoot creates necessary directories", async () => {
    await ensureContentRoot(contentRoot);
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining("pages"), { recursive: true });
    expect(fs.mkdir).toHaveBeenCalledWith(expect.stringContaining(".wiki"), { recursive: true });
  });

  test("listPages returns sorted pages with slugs", async () => {
    vi.mocked(fs.readdir).mockResolvedValue([
      { isFile: () => true, isDirectory: () => false, name: "index.md" },
      { isFile: () => true, isDirectory: () => false, name: "about.md" },
    ] as any);
    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);

    const pages = await listPages(contentRoot);
    expect(pages).toHaveLength(2);
    expect(pages[0].slug).toBe(""); // index.md
    expect(pages[1].slug).toBe("about");
  });

  test("readPage parses gray-matter", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("---\ntitle: Custom Title\n---\n# Content");

    const page = await readPage(contentRoot, "about");
    expect(page?.title).toBe("Custom Title");
    expect(page?.body).toContain("# Content");
  });

  test("writePage serializes content and saves to disk", async () => {
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await writePage(contentRoot, "new-page", "New Page", "Content", {
      author: "test",
    });
    expect(result.path).toContain("new-page.md");
    expect(fs.writeFile).toHaveBeenCalled();
  });

  test("deletePage removes file and cleans up empty directories", async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([]); // Empty dir cleanup
    vi.mocked(fs.rmdir).mockResolvedValue(undefined);

    // Use a nested path to trigger cleanup loop
    await deletePage(contentRoot, "folder/old-page");
    expect(fs.rm).toHaveBeenCalled();
    expect(fs.rmdir).toHaveBeenCalled();
  });

  test("createFolder adds .gitkeep", async () => {
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValue(error);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as any);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);

    const result = await createFolder(contentRoot, "new-folder");
    expect(result.path).toBe("new-folder");
    expect(fs.writeFile).toHaveBeenCalledWith(expect.stringContaining(".gitkeep"), "", "utf8");
  });

  test("listFolders returns recursive folder paths", async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isDirectory: () => true, name: "subdir" },
      { isDirectory: () => false, name: "file.txt" },
    ] as any);
    vi.mocked(fs.readdir).mockResolvedValueOnce([]) as any; // Inside subdir

    const folders = await listFolders(contentRoot);
    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe("subdir");
  });

  test("renameFolder moves directory and updates pages", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
      isFile: () => false,
    } as any); // Old exists
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.stat).mockRejectedValueOnce(error); // New doesn't exist
    vi.mocked(fs.readdir).mockResolvedValue([]); // No pages under folder for simplicity
    vi.mocked(fs.rename).mockResolvedValue(undefined);

    const result = await renameFolder(contentRoot, "old-dir", "new-dir");
    expect(result.path).toBe("new-dir");
    expect(fs.rename).toHaveBeenCalled();
  });

  test("getGitSummary returns current branch and commit", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "main\n" }, "");
      return {} as any;
    });

    const summary = await getGitSummary(contentRoot);
    expect(summary?.branch).toBe("main");
  });

  test("getPageHistory parses git log output", async () => {
    const logOutput = "hash1\tauthor1\t2023-01-01\tmsg1\n";
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: logOutput }, "");
      return {} as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);

    const history = await getPageHistory(contentRoot, "about");
    expect(history).toHaveLength(1);
    expect(history[0].commit).toBe("hash1");
  });

  test("commitFileChange adds and commits a file", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "hash-abc\n" }, "");
      return {} as any;
    });

    const { commitFileChange } = await import("../src/modules/sources/wiki/content-repo.js");
    const commit = await commitFileChange(contentRoot, "/wiki-root/pages/test.md", "feat: test");
    expect(commit).toBe("hash-abc");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["commit", "-m", "feat: test"]),
      expect.any(Function),
    );
  });

  test("deleteFolder removes directory and lists deleted slugs", async () => {
    vi.mocked(fs.stat).mockResolvedValueOnce({
      isDirectory: () => true,
      isFile: () => false,
    } as any); // Folder check
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isFile: () => false, isDirectory: () => true, name: "my-folder" },
    ] as any); // pagesRoot readdir
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      { isFile: () => true, isDirectory: () => false, name: "page.md" },
    ] as any); // my-folder readdir
    vi.mocked(fs.stat).mockResolvedValue({
      mtime: new Date(),
      isFile: () => true,
      isDirectory: () => false,
    } as any);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
    vi.mocked(fs.rmdir).mockResolvedValue(undefined);

    const { deleteFolder } = await import("../src/modules/sources/wiki/content-repo.js");
    const result = await deleteFolder(contentRoot, "my-folder");
    expect(result.deletedSlugs).toContain("my-folder/page");
    expect(fs.rm).toHaveBeenCalledWith(expect.stringContaining("my-folder"), { recursive: true });
  });

  test("getPageDiff returns git diff output", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "diff content" }, "");
      return {} as any;
    });
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, isDirectory: () => false } as any);

    const { getPageDiff } = await import("../src/modules/sources/wiki/content-repo.js");
    const diff = await getPageDiff(contentRoot, "about", "v1", "v2");
    expect(diff).toBe("diff content");
  });

  test("ensureGitRepo initializes if .git is missing", async () => {
    vi.mocked(fs.access).mockRejectedValueOnce(new Error("Missing"));
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "" }, "");
      return {} as any;
    });

    const { ensureGitRepo } = await import("../src/modules/sources/wiki/content-repo.js");
    await ensureGitRepo(contentRoot);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["init"]),
      expect.any(Function),
    );
  });

  test("commitPathsChange commits multiple files", async () => {
    vi.mocked(execFile).mockImplementation((_cmd, _args, callback: any) => {
      callback(null, { stdout: "hash-multi\n" }, "");
      return {} as any;
    });

    const { commitPathsChange } = await import("../src/modules/sources/wiki/content-repo.js");
    const commit = await commitPathsChange(
      contentRoot,
      ["/wiki-root/pages/a.md", "/wiki-root/pages/b.md"],
      "feat: multi",
    );
    expect(commit).toBe("hash-multi");
  });

  test("deletePage throws error if page not found", async () => {
    const error = new Error("Not found");
    (error as any).code = "ENOENT";
    vi.mocked(fs.rm).mockRejectedValue(error);
    await expect(deletePage(contentRoot, "missing")).rejects.toThrow("Page not found");
  });

  test("writePage throws error if slug doesn't match relativePath", async () => {
    await expect(
      writePage(contentRoot, "slug-a", "Title", "Body", {}, { relativePath: "slug-b.md" }),
    ).rejects.toThrow("Existing page path does not match slug");
  });

  test("throws error for invalid path escaping pages root", async () => {
    await expect(readPage(contentRoot, "../secret")).rejects.toThrow("Invalid page slug");
  });

  test("createFolder throws for empty path", async () => {
    await expect(createFolder(contentRoot, "")).rejects.toThrow("Invalid folder path");
  });
});
