import * as ts from "typescript";
import type {
  AgentDiffEntryInput,
  AgentDiffSymbolInput,
} from "../../shared/schemas/vibe-memory.schema.js";

export type NormalizedAgentDiffEntry = {
  filePath: string;
  diffHunk: string;
  changeType?: string | null;
  language?: string | null;
  symbolName?: string | null;
  symbolKind?: string | null;
  signature?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  metadata: Record<string, unknown>;
};

type ParsedFileDiff = {
  filePath: string;
  diffHunk: string;
  changeType: "add" | "modify" | "delete";
  language?: string;
  metadata: Record<string, unknown>;
  newContent: string;
};

type DiffAccumulator = {
  filePath?: string;
  diffLines: string[];
  hunkLines: string[];
  sawNewFile: boolean;
  sawDelete: boolean;
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

export function inferAgentDiffLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return undefined;
  return languageByExtension.get(filePath.slice(dotIndex).toLowerCase());
}

export function parseUnifiedAgentDiffs(diff: string): ParsedFileDiff[] {
  const parsed: ParsedFileDiff[] = [];
  let current: DiffAccumulator | null = null;

  const flush = () => {
    if (!current?.filePath) return;
    const diffHunk = current.diffLines.join("\n").trimEnd();
    if (!diffHunk) return;
    parsed.push({
      filePath: current.filePath,
      diffHunk,
      changeType: current.sawDelete ? "delete" : current.sawNewFile ? "add" : "modify",
      language: inferAgentDiffLanguage(current.filePath),
      metadata: { source: "unified_diff" },
      newContent: reconstructNewFileContent(current.hunkLines),
    });
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = { diffLines: [line], hunkLines: [], sawNewFile: false, sawDelete: false };
      const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/);
      current.filePath = normalizeDiffPath(match?.[2]) ?? normalizeDiffPath(match?.[1]);
      continue;
    }

    if (
      !current &&
      (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ "))
    ) {
      current = { diffLines: [], hunkLines: [], sawNewFile: false, sawDelete: false };
    }

    if (!current) continue;

    current.diffLines.push(line);

    if (line.startsWith("new file mode ")) {
      current.sawNewFile = true;
    } else if (line.startsWith("deleted file mode ")) {
      current.sawDelete = true;
    } else if (line.startsWith("--- /dev/null")) {
      current.sawNewFile = true;
    } else if (line.startsWith("+++ /dev/null")) {
      current.sawDelete = true;
    }

    if (line.startsWith("+++ ")) {
      current.filePath = normalizeDiffPath(line.slice(4)) ?? current.filePath;
      continue;
    }

    if (line.startsWith("@@ ") || current.hunkLines.length > 0) {
      current.hunkLines.push(line);
    }
  }

  flush();
  return parsed;
}

export function normalizeAgentDiffEntries(params: {
  diff?: string;
  agentDiffs?: AgentDiffEntryInput[];
}): NormalizedAgentDiffEntry[] {
  const entries: NormalizedAgentDiffEntry[] = [];

  for (const fileDiff of params.diff?.trim() ? parseUnifiedAgentDiffs(params.diff) : []) {
    const symbols = extractAgentDiffSymbols({
      filePath: fileDiff.filePath,
      content: fileDiff.newContent,
    });

    if (symbols.length === 0) {
      entries.push({
        filePath: fileDiff.filePath,
        diffHunk: fileDiff.diffHunk,
        changeType: fileDiff.changeType,
        language: fileDiff.language,
        metadata: fileDiff.metadata,
      });
      continue;
    }

    for (const symbol of symbols) {
      entries.push({
        filePath: fileDiff.filePath,
        diffHunk: fileDiff.diffHunk,
        changeType: fileDiff.changeType,
        language: fileDiff.language,
        symbolName: symbol.symbolName,
        symbolKind: symbol.symbolKind,
        signature: symbol.signature ?? null,
        startLine: symbol.startLine ?? null,
        endLine: symbol.endLine ?? null,
        metadata: { ...fileDiff.metadata, ...(symbol.metadata ?? {}) },
      });
    }
  }

  for (const entry of params.agentDiffs ?? []) {
    if (!entry.diffHunk?.trim()) continue;
    entries.push({
      filePath: entry.filePath,
      diffHunk: entry.diffHunk,
      changeType: entry.changeType ?? null,
      language: entry.language ?? inferAgentDiffLanguage(entry.filePath),
      symbolName: entry.symbolName ?? null,
      symbolKind: entry.symbolKind ?? null,
      signature: entry.signature ?? null,
      startLine: entry.startLine ?? null,
      endLine: entry.endLine ?? null,
      metadata: entry.metadata ?? {},
    });
  }

  return dedupeAgentDiffEntries(entries);
}

export function extractAgentDiffSymbols(params: {
  filePath: string;
  content: string;
}): AgentDiffSymbolInput[] {
  const scriptKind = getScriptKind(params.filePath);
  if (!scriptKind || !params.content.trim()) return [];

  const sourceFile = ts.createSourceFile(
    params.filePath,
    params.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const symbols: AgentDiffSymbolInput[] = [];

  const pushSymbol = (node: ts.Node, symbolName: string, symbolKind: string) => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
    const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
    const symbolText = sourceFile.text.slice(start, end).trimEnd();
    symbols.push({
      symbolName,
      symbolKind,
      signature:
        symbolText
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

function reconstructNewFileContent(diffLines: string[]): string {
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

function dedupeAgentDiffEntries(entries: NormalizedAgentDiffEntry[]): NormalizedAgentDiffEntry[] {
  const deduped = new Map<string, NormalizedAgentDiffEntry>();

  for (const entry of entries) {
    const key = [
      entry.filePath,
      entry.symbolName ?? "",
      entry.symbolKind ?? "",
      entry.startLine ?? "",
      entry.endLine ?? "",
      entry.diffHunk,
    ].join("\0");
    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, entry);
      continue;
    }

    deduped.set(key, {
      ...current,
      ...entry,
      metadata: { ...current.metadata, ...entry.metadata },
    });
  }

  return [...deduped.values()];
}

function dedupeSymbols(symbols: AgentDiffSymbolInput[]): AgentDiffSymbolInput[] {
  const deduped = new Map<string, AgentDiffSymbolInput>();

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
      signature: symbol.signature ?? current.signature,
      metadata: { ...(current.metadata ?? {}), ...(symbol.metadata ?? {}) },
    });
  }

  return [...deduped.values()];
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
