import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeRepoKey, normalizeRepoPath } from "../context-compiler/query-context.js";
import { deleteStaleSourcesForRoot, upsertSourceDocument } from "./source.repository.js";

type MarkdownImportResult = {
  importedFiles: number;
  importedSources: number;
  importedKnowledge: number;
  skippedFiles: number;
  removedSources: number;
  files: Array<{ path: string; sourceId: string }>;
};

type FrontmatterParseResult = {
  frontmatter: Record<string, string>;
  body: string;
};

function parseFrontmatter(markdown: string): FrontmatterParseResult {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: {}, body: markdown };
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) {
    return { frontmatter: {}, body: markdown };
  }
  const block = markdown.slice(4, end);
  const body = markdown.slice(end + 5);
  const frontmatter: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (!key || !value) continue;
    frontmatter[key] = value.replace(/^['"]|['"]$/g, "");
  }
  return { frontmatter, body };
}

function firstMarkdownHeading(body: string): string | null {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    const title = trimmed.replace(/^#+\s*/, "").trim();
    if (title) return title;
  }
  return null;
}

export async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const parentPath =
      "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : rootDir;
    files.push(path.join(parentPath, entry.name));
  }
  return files.sort();
}

export async function importMarkdownDirectory(rootDir: string): Promise<MarkdownImportResult> {
  const markdownFiles = await collectMarkdownFiles(rootDir);
  const results: MarkdownImportResult = {
    importedFiles: 0,
    importedSources: 0,
    importedKnowledge: 0,
    skippedFiles: 0,
    removedSources: 0,
    files: [],
  };
  const normalizedRootPath = normalizeRepoPath(rootDir) ?? rootDir;
  const workspaceRepoPath = normalizeRepoPath(process.cwd()) ?? normalizedRootPath;
  const workspaceRepoKey = normalizeRepoKey(process.cwd()) ?? normalizeRepoKey(rootDir);

  for (const filePath of markdownFiles) {
    const content = await readFile(filePath, "utf8");
    if (!content.trim()) {
      results.skippedFiles += 1;
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    const inferredTitle = firstMarkdownHeading(body) ?? path.basename(filePath, ".md");

    const sourceId = await upsertSourceDocument({
      sourceKind: "wiki",
      uri: filePath,
      title: frontmatter.title ?? inferredTitle,
      body: content,
      metadata: {
        importedAt: new Date().toISOString(),
        repoPath: workspaceRepoPath,
        repoKey: workspaceRepoKey,
        sourceRootPath: normalizedRootPath,
      },
    });

    results.importedFiles += 1;
    results.importedSources += 1;
    results.files.push({ path: filePath, sourceId });
  }

  results.removedSources = await deleteStaleSourcesForRoot({
    rootPath: normalizedRootPath,
    keepUris: results.files.map((item) => item.path),
  });

  return results;
}
