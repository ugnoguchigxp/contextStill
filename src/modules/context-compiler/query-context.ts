import path from "node:path";
import type { CompileInput } from "../../shared/schemas/compile.schema.js";

function uniqueTrimmed(values: string[] | undefined): string[] {
  if (!values) return [];
  const deduped = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
  }
  return [...deduped];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeRepoPath(repoPath?: string): string | undefined {
  if (!repoPath?.trim()) return undefined;
  const trimmed = repoPath.trim();
  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      if (url.protocol === "file:") {
        return normalizePath(path.resolve(decodeURIComponent(url.pathname)));
      }
    } catch {
      // Fall back to plain path resolution for malformed URI input.
    }
  }
  return normalizePath(path.resolve(trimmed));
}

export function normalizeRepoKey(repoPath?: string): string | undefined {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  if (!normalizedRepoPath) return undefined;
  return normalizedRepoPath.toLowerCase();
}

export function fileHintsFromInput(input: { files?: string[] }): string[] {
  const files = uniqueTrimmed(input.files);
  const hints = new Set<string>();
  for (const filePath of files) {
    const normalizedFilePath = normalizePath(filePath);
    hints.add(normalizedFilePath);
    const basename = path.basename(normalizedFilePath);
    if (basename) hints.add(basename);
    const ext = path.extname(normalizedFilePath).replace(/^\./, "");
    if (ext) hints.add(ext);
    const directory = path.dirname(normalizedFilePath);
    if (directory && directory !== ".") hints.add(directory);
  }
  return [...hints];
}

export function buildRetrievalQueryText(
  input: Pick<CompileInput, "goal" | "changeTypes" | "technologies" | "domains">,
): string {
  const lines: string[] = [input.goal.trim()];
  const changeTypes = uniqueTrimmed(input.changeTypes);
  const technologies = uniqueTrimmed(input.technologies);
  const domains = uniqueTrimmed(input.domains);

  if (changeTypes.length > 0) {
    lines.push(`changeTypes: ${changeTypes.join(" ")}`);
  }
  if (technologies.length > 0) {
    lines.push(`technologies: ${technologies.join(" ")}`);
  }
  if (domains.length > 0) {
    lines.push(`domains: ${domains.join(" ")}`);
  }
  return lines.join("\n");
}
