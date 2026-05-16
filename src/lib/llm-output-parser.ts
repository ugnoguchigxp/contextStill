export type LlmJsonParseStrategy = "json" | "json_repaired" | "json5" | "json5_repaired";

export type LlmJsonParseResult = {
  value: unknown;
  strategy: LlmJsonParseStrategy;
  repaired: boolean;
};

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json|json5)?\s*([\s\S]*?)```\s*$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizeJsonp(text: string): string {
  const match = text.trim().match(/^[\w$.]+\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/);
  return match?.[1]?.trim() ?? text;
}

function replaceBareLiterals(text: string): string {
  let result = "";
  let index = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  while (index < text.length) {
    const char = text[index] ?? "";

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      result += char;
      index += 1;
      continue;
    }

    const rest = text.slice(index);
    const literal = rest.match(/^(None|True|False)\b/);
    if (literal) {
      result += literal[1] === "None" ? "null" : literal[1] === "True" ? "true" : "false";
      index += literal[1].length;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function normalizeLooseJsonText(text: string): string {
  const normalizedQuotes = normalizeJsonp(stripMarkdownFence(text))
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
  return replaceBareLiterals(normalizedQuotes).trim();
}

function stripComments(text: string): string {
  let result = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        result += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function removeTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      result += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] ?? "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }

    result += char;
  }

  return result;
}

function convertSingleQuotedStrings(text: string): string {
  let result = "";
  let index = 0;
  let inDoubleString = false;
  let escaped = false;

  while (index < text.length) {
    const char = text[index] ?? "";

    if (inDoubleString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inDoubleString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inDoubleString = true;
      result += char;
      index += 1;
      continue;
    }

    if (char === "'") {
      let value = "";
      index += 1;
      while (index < text.length) {
        const current = text[index] ?? "";
        const next = text[index + 1] ?? "";
        if (current === "\\") {
          value += next || current;
          index += next ? 2 : 1;
          continue;
        }
        if (current === "'") {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      result += JSON.stringify(value);
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function quoteBareKeys(text: string): string {
  let result = "";
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const char = text[index] ?? "";

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      index += 1;
      continue;
    }

    const beforeKey = char === "{" || char === ",";
    if (beforeKey) {
      result += char;
      index += 1;
      const whitespace = text.slice(index).match(/^\s*/)?.[0] ?? "";
      result += whitespace;
      index += whitespace.length;
      const keyMatch = text.slice(index).match(/^([A-Za-z_$][\w$-]*)\s*:/);
      if (keyMatch?.[1]) {
        result += JSON.stringify(keyMatch[1]);
        index += keyMatch[1].length;
        const afterKeyWhitespace = text.slice(index).match(/^\s*/)?.[0] ?? "";
        result += afterKeyWhitespace;
        index += afterKeyWhitespace.length;
        result += ":";
        index += 1;
      }
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function stripEllipsis(text: string): string {
  return text.replace(/,\s*\.\.\.\s*(?=[}\]])/g, "").replace(/\[\s*\.\.\.\s*\]/g, "[]");
}

function completeContainers(text: string): string {
  const stack: string[] = [];
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") stack.push("}");
    if (char === "[") stack.push("]");
    if ((char === "}" || char === "]") && stack.at(-1) === char) stack.pop();
  }

  let completed = text.trimEnd();
  if (inString && quote) completed += quote;
  completed = removeTrailingCommas(completed);
  while (stack.length > 0) {
    completed += stack.pop();
    completed = removeTrailingCommas(completed);
  }
  return completed;
}

function repairJsonLikeText(text: string): string {
  return completeContainers(
    removeTrailingCommas(
      quoteBareKeys(
        convertSingleQuotedStrings(stripEllipsis(stripComments(normalizeLooseJsonText(text)))),
      ),
    ),
  );
}

function parseJson5(text: string): unknown {
  const parse = (globalThis as typeof globalThis & { Bun?: { JSON5?: { parse?: unknown } } }).Bun
    ?.JSON5?.parse;
  if (typeof parse !== "function") {
    throw new Error("Bun.JSON5.parse is unavailable");
  }
  return (parse as (value: string) => unknown)(text);
}

function tryParse(text: string, parser: (value: string) => unknown): unknown | undefined {
  try {
    return parser(text);
  } catch {
    return undefined;
  }
}

function pushUnique(candidates: string[], value: string): void {
  const normalized = value.trim();
  if (!normalized || candidates.includes(normalized)) return;
  candidates.push(normalized);
}

function extractFencedBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:json|json5)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

export function extractCompleteJsonValues(text: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{" || char === "[") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      if (depth <= 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return values;
}

function extractJsonLikeCandidates(raw: string): string[] {
  const candidates: string[] = [];
  pushUnique(candidates, raw);
  for (const block of extractFencedBlocks(raw)) pushUnique(candidates, block);

  const normalized = normalizeLooseJsonText(raw);
  if (!/^\s*[{[]/.test(normalized) && normalized.includes(":")) {
    pushUnique(candidates, `{${normalized}}`);
  }

  for (const block of extractFencedBlocks(raw)) {
    const normalizedBlock = normalizeLooseJsonText(block);
    if (!/^\s*[{[]/.test(normalizedBlock) && normalizedBlock.includes(":")) {
      pushUnique(candidates, `{${normalizedBlock}}`);
    }
  }

  for (const value of extractCompleteJsonValues(raw)) pushUnique(candidates, value);

  return candidates;
}

export function parseLlmJsonLike(raw: string): LlmJsonParseResult | null {
  for (const candidate of extractJsonLikeCandidates(raw)) {
    const normalized = normalizeLooseJsonText(candidate);
    const strict = tryParse(normalized, JSON.parse);
    if (strict !== undefined) return { value: strict, strategy: "json", repaired: false };

    const repaired = repairJsonLikeText(candidate);
    const repairedStrict = tryParse(repaired, JSON.parse);
    if (repairedStrict !== undefined) {
      return { value: repairedStrict, strategy: "json_repaired", repaired: true };
    }

    const json5 = tryParse(normalized, parseJson5);
    if (json5 !== undefined) return { value: json5, strategy: "json5", repaired: false };

    const repairedJson5 = tryParse(repaired, parseJson5);
    if (repairedJson5 !== undefined) {
      return { value: repairedJson5, strategy: "json5_repaired", repaired: true };
    }
  }

  return null;
}
