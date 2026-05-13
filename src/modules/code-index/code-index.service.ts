import path from "node:path";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import {
  type CodeSymbolSearchResult,
  type CodeSymbolSeed,
  searchCodeSymbols,
  upsertCodeSymbols,
} from "./code-index.repository.js";

export async function ingestCodeSymbols(symbols: CodeSymbolSeed[]): Promise<number> {
  return upsertCodeSymbols(symbols);
}

type CodeContextItem = {
  id: string;
  itemKind: string;
  itemId: string;
  section: "code_context";
  title: string;
  content: string;
  score: number;
  rankingReason: string;
  evidenceRefs: string[];
};

export type CodeContextRetrievalResult = {
  items: CodeContextItem[];
  degradedReasons: string[];
  stats: {
    symbolHitCount: number;
    fileHintCount: number;
  };
};

function getCodeContextLimit(retrievalMode: RetrievalMode): number {
  switch (retrievalMode) {
    case "debug_context":
      return 8;
    case "architecture_context":
      return 8;
    case "review_context":
      return 6;
    case "learning_context":
      return 6;
    case "skill_context":
      return 5;
    default:
      return 6;
  }
}

function toCodeContextItem(symbol: CodeSymbolSearchResult): CodeContextItem {
  const lineRange =
    symbol.startLine && symbol.endLine
      ? `${symbol.filePath}:${symbol.startLine}-${symbol.endLine}`
      : symbol.startLine
        ? `${symbol.filePath}:${symbol.startLine}`
        : symbol.filePath;
  return {
    id: `code-symbol:${symbol.id}`,
    itemKind: "code_symbol",
    itemId: symbol.id,
    section: "code_context",
    title: `${symbol.symbolKind} ${symbol.symbolName}`,
    content: symbol.signature ? `${lineRange}\n${symbol.signature}` : lineRange,
    score: symbol.score,
    rankingReason: "matched code symbol/file index for current goal",
    evidenceRefs: [],
  };
}

function fallbackFileItems(files: string[]): CodeContextItem[] {
  return files.map((filePath) => ({
    id: `file-hint:${filePath}`,
    itemKind: "file_hint",
    itemId: filePath,
    section: "code_context",
    title: path.basename(filePath),
    content: filePath,
    score: 0.2,
    rankingReason: "provided as task input file path",
    evidenceRefs: [],
  }));
}

export async function retrieveCodeContext(
  input: CompileInput,
  options: { retrievalMode: RetrievalMode },
): Promise<CodeContextRetrievalResult> {
  const limit = getCodeContextLimit(options.retrievalMode);
  const files = input.files?.slice(0, 10);
  const query = input.goal.trim();
  const degradedReasons: string[] = [];

  let symbols: CodeSymbolSearchResult[] = [];
  try {
    symbols = await searchCodeSymbols({
      query,
      limit,
      repoPath: input.repoPath,
      files,
    });
  } catch {
    degradedReasons.push("CODE_SYMBOL_SEARCH_FAILED");
  }

  const items = symbols.map(toCodeContextItem);
  if (items.length === 0 && files && files.length > 0) {
    items.push(...fallbackFileItems(files).slice(0, limit));
  }
  if (items.length === 0) {
    degradedReasons.push("NO_CODE_CONTEXT_MATCH");
  }

  return {
    items: items.slice(0, limit),
    degradedReasons,
    stats: {
      symbolHitCount: symbols.length,
      fileHintCount: files?.length ?? 0,
    },
  };
}
