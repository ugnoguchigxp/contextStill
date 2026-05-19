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
  content: string;
  totalTokens: number;
  from: number;
  toExclusive: number;
  returnedTokens: number;
};

function resolveMinify(input: ReadFileDomainInput): boolean {
  if (typeof input.minify === "boolean") return input.minify;
  if (typeof input.minifiy === "boolean") return input.minifiy;
  return true;
}

function resolveSafePath(userPath: string): {
  rootPath: string;
  absolutePath: string;
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

  return {
    rootPath,
    absolutePath,
  };
}

export async function readFileDomain(input: ReadFileDomainInput): Promise<ReadFileDomainResult> {
  const { absolutePath } = resolveSafePath(input.path);
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
  const readableText = minify ? stripMarkdownFormatting(withoutFrontmatter) : withoutFrontmatter;
  const normalized = normalizeReadFileText({
    text: readableText,
    minify,
  });
  const window = sliceTextByTokenWindow({
    text: normalized,
    fromToken,
    readTokens,
  });

  return {
    content: window.content,
    totalTokens: window.totalTokens,
    from: window.tokenRange.from,
    toExclusive: window.tokenRange.toExclusive,
    returnedTokens: window.returnedTokens,
  };
}
