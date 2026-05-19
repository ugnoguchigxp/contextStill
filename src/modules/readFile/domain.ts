import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { groupedConfig } from "../../config.js";
import { markdownifyContent } from "./markdownify.service.js";
import {
  maybeStripFrontmatter,
  normalizeReadFileText,
  stripMarkdownFormatting,
} from "./normalize.service.js";
import { sliceTextByTokenWindow } from "./token-window.service.js";

export type ReadFileDomainInput = {
  path: string;
  fromToken?: number;
  readTokens?: number;
  includeFrontmatter?: boolean;
  minify?: boolean;
  minifiy?: boolean;
};

export type ReadFileDomainResult = {
  path: string;
  content: string;
  tokenRange: {
    from: number;
    toExclusive: number;
  };
  hasMore: boolean;
  nextFromToken?: number;
  stats: {
    totalTokens: number;
    returnedTokens: number;
    charCount: number;
    contentHash: string;
  };
};

function asPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveMinify(input: ReadFileDomainInput): boolean {
  if (typeof input.minify === "boolean") return input.minify;
  if (typeof input.minifiy === "boolean") return input.minifiy;
  return true;
}

function resolveSafePath(userPath: string): {
  rootPath: string;
  absolutePath: string;
  resultPath: string;
} {
  const trimmed = userPath.trim();
  if (!trimmed) {
    throw new Error("path must be a non-empty string");
  }

  const rootPath = path.resolve(groupedConfig.readFile.root);
  const absolutePath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(rootPath, trimmed.replace(/^\/+/, ""));
  const insideRoot = absolutePath === rootPath || absolutePath.startsWith(`${rootPath}${path.sep}`);
  if (!insideRoot) {
    throw new Error(`path must be inside read_file root: ${rootPath}`);
  }

  const relativePath = asPosix(path.relative(rootPath, absolutePath));
  return {
    rootPath,
    absolutePath,
    resultPath: relativePath || ".",
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readFileDomain(input: ReadFileDomainInput): Promise<ReadFileDomainResult> {
  const { absolutePath, resultPath } = resolveSafePath(input.path);
  const fromToken = Math.max(0, Math.floor(input.fromToken ?? 0));
  const maxTokens = Math.max(1, groupedConfig.readFile.maxTokens);
  const requestedTokens = Math.max(
    1,
    Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens),
  );
  const readTokens = Math.min(requestedTokens, maxTokens);
  const minify = resolveMinify(input);
  const includeFrontmatter = Boolean(input.includeFrontmatter);

  const raw = await readFile(absolutePath, "utf8");
  const markdown = markdownifyContent({
    content: raw,
    filePath: absolutePath,
  });
  const withoutFrontmatter = maybeStripFrontmatter(markdown, includeFrontmatter);
  const stripped = stripMarkdownFormatting(withoutFrontmatter);
  const normalized = normalizeReadFileText({
    text: stripped,
    minify,
  });
  const window = sliceTextByTokenWindow({
    text: normalized,
    fromToken,
    readTokens,
  });

  return {
    path: resultPath,
    content: window.content,
    tokenRange: window.tokenRange,
    hasMore: window.hasMore,
    nextFromToken: window.nextFromToken,
    stats: {
      totalTokens: window.totalTokens,
      returnedTokens: window.returnedTokens,
      charCount: window.content.length,
      contentHash: contentHash(window.content),
    },
  };
}
