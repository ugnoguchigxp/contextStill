import * as ts from "typescript";
import type { AiArtifactInput, ArtifactSymbolInput } from "../../shared/schemas/activity.schema.js";

export type NormalizedArtifact = {
  filePath: string;
  content: string;
  diff?: string;
  language?: string;
  metadata: Record<string, unknown>;
  symbols: ArtifactSymbolInput[];
};

type DiffArtifactAccumulator = {
  filePath?: string;
  diffLines: string[];
  hunkLines: string[];
};

const languageByExtension = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "tsx"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "jsx"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".json", "json"],
  [".md", "markdown"],
  [".mdx", "mdx"],
  [".css", "css"],
  [".html", "html"],
  [".sql", "sql"],
]);

export function inferArtifactLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return undefined;
  return languageByExtension.get(filePath.slice(dotIndex).toLowerCase());
}

export function parseUnifiedDiffArtifacts(diff: string): AiArtifactInput[] {
  const artifacts: AiArtifactInput[] = [];
  let current: DiffArtifactAccumulator | null = null;

  const flush = () => {
    if (!current?.filePath) return;
    const artifactDiff = current.diffLines.join("\n").trimEnd();
    if (!artifactDiff) return;
    artifacts.push({
      filePath: current.filePath,
      content: reconstructNewFileContent(current.hunkLines),
      diff: artifactDiff,
      language: inferArtifactLanguage(current.filePath),
      metadata: { source: "unified_diff" },
      symbols: [],
    });
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { diffLines: [line], hunkLines: [] };
      const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
      current.filePath = normalizeDiffPath(match?.[2]) ?? normalizeDiffPath(match?.[1]);
      continue;
    }

    if (
      !current &&
      (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ "))
    ) {
      current = { diffLines: [], hunkLines: [] };
    }

    if (!current) continue;

    current.diffLines.push(line);

    if (line.startsWith("+++ ")) {
      current.filePath = normalizeDiffPath(line.slice(4)) ?? current.filePath;
      continue;
    }

    if (line.startsWith("@@ ") || current.hunkLines.length > 0) {
      current.hunkLines.push(line);
    }
  }

  flush();
  return artifacts;
}

export function reconstructNewFileContent(diffLines: string[]): string {
  const newLines: string[] = [];
  let currentLineNumber = 1;

  for (const line of diffLines) {
    if (line.startsWith("@@ ")) {
      const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      currentLineNumber = Number(match?.[1] ?? 1);
      while (newLines.length < currentLineNumber - 1) {
        newLines.push("");
      }
      continue;
    }

    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    if (line.startsWith("+") || line.startsWith(" ")) {
      while (newLines.length < currentLineNumber - 1) {
        newLines.push("");
      }
      newLines[currentLineNumber - 1] = line.slice(1);
      currentLineNumber += 1;
    }
  }

  return newLines.join("\n").trimEnd();
}

export function extractArtifactSymbols(params: {
  filePath: string;
  content: string;
}): ArtifactSymbolInput[] {
  const scriptKind = getScriptKind(params.filePath);
  if (!scriptKind || !params.content.trim()) return [];

  const sourceFile = ts.createSourceFile(
    params.filePath,
    params.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const symbols: ArtifactSymbolInput[] = [];

  const pushSymbol = (node: ts.Node, symbolName: string, symbolKind: string) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
    const content = sourceFile.text.slice(start, end).trimEnd();
    symbols.push({
      symbolName,
      symbolKind,
      content,
      signature:
        content
          .split("\n")
          .find((line) => line.trim())
          ?.trim() ?? null,
      startLine,
      endLine,
      metadata: { extractedBy: "typescript_ast" },
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "function");
    } else if (ts.isClassDeclaration(node) && node.name) {
      pushSymbol(node, node.name.text, "class");
    } else if (ts.isInterfaceDeclaration(node)) {
      pushSymbol(node, node.name.text, "interface");
    } else if (ts.isTypeAliasDeclaration(node)) {
      pushSymbol(node, node.name.text, "type_alias");
    } else if (ts.isEnumDeclaration(node)) {
      pushSymbol(node, node.name.text, "enum");
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      pushSymbol(node, node.name.text, "method");
    } else if (ts.isVariableStatement(node) && node.parent === sourceFile) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          pushSymbol(node, declaration.name.text, "variable");
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return dedupeSymbols(symbols);
}

export function normalizeActivityArtifacts(params: {
  diff?: string;
  artifacts?: AiArtifactInput[];
}): NormalizedArtifact[] {
  const artifactByPath = new Map<string, NormalizedArtifact>();
  const diffArtifacts = params.diff?.trim() ? parseUnifiedDiffArtifacts(params.diff) : [];

  for (const artifact of diffArtifacts) {
    mergeArtifact(artifactByPath, artifact);
  }

  for (const artifact of params.artifacts ?? []) {
    mergeArtifact(artifactByPath, artifact);
  }

  return Array.from(artifactByPath.values()).map((artifact) => {
    const autoSymbols = extractArtifactSymbols({
      filePath: artifact.filePath,
      content: artifact.content,
    });

    return {
      ...artifact,
      symbols: dedupeSymbols([...artifact.symbols, ...autoSymbols]),
    };
  });
}

function mergeArtifact(map: Map<string, NormalizedArtifact>, artifact: AiArtifactInput) {
  const normalized = toNormalizedArtifact(artifact);
  const current = map.get(normalized.filePath);
  if (!current) {
    map.set(normalized.filePath, normalized);
    return;
  }

  if (normalized.content.trim()) current.content = normalized.content;
  if (normalized.diff?.trim()) current.diff = normalized.diff;
  current.language = normalized.language ?? current.language;
  current.metadata = { ...current.metadata, ...normalized.metadata };
  current.symbols = dedupeSymbols([...current.symbols, ...normalized.symbols]);
}

function toNormalizedArtifact(artifact: AiArtifactInput): NormalizedArtifact {
  const content = artifact.content ?? reconstructNewFileContent(artifact.diff?.split("\n") ?? []);
  return {
    filePath: artifact.filePath,
    content,
    diff: artifact.diff,
    language: artifact.language ?? inferArtifactLanguage(artifact.filePath),
    metadata: artifact.metadata ?? {},
    symbols: dedupeSymbols(artifact.symbols ?? []),
  };
}

function dedupeSymbols(symbols: ArtifactSymbolInput[]): ArtifactSymbolInput[] {
  const deduped = new Map<string, ArtifactSymbolInput>();

  for (const symbol of symbols) {
    const key = [
      symbol.symbolName,
      symbol.symbolKind,
      symbol.startLine ?? "",
      symbol.endLine ?? "",
    ].join("\0");
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, symbol);
      continue;
    }

    deduped.set(key, {
      ...current,
      ...symbol,
      content: symbol.content ?? current.content,
      signature: symbol.signature ?? current.signature,
      metadata: { ...(current.metadata ?? {}), ...(symbol.metadata ?? {}) },
    });
  }

  return Array.from(deduped.values());
}

function getScriptKind(filePath: string): ts.ScriptKind | undefined {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return undefined;
}

function normalizeDiffPath(rawPath?: string): string | undefined {
  if (!rawPath) return undefined;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "/dev/null") return undefined;
  const path = trimmed.startsWith('"') ? trimmed.slice(1, trimmed.lastIndexOf('"')) : trimmed;
  return path.replace(/^[ab]\//, "").trim() || undefined;
}
