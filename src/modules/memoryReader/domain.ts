import { normalizeReadFileText, stripMarkdownFormatting } from "../readFile/normalize.service.js";

export type MemoryReaderMode = "compressed" | "original";
export type MemoryReaderContentKind = "memory" | "diff";

const sentenceSplitPattern = /[\n。！？!?]+/u;

function isDedupeTarget(phrase: string): boolean {
  if (!phrase) return false;
  const tokenCount = phrase.split(/\s+/u).filter(Boolean).length;
  return phrase.length >= 8 || tokenCount >= 2;
}

function canonicalizePhrase(phrase: string): string {
  return phrase.replace(/\s+/gu, " ").trim().toLowerCase();
}

export function removeDuplicatePhrases(text: string): string {
  const phrases = text
    .split(sentenceSplitPattern)
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length > 0);

  if (phrases.length <= 1) return text;

  const seen = new Set<string>();
  const kept: string[] = [];

  for (const phrase of phrases) {
    const key = canonicalizePhrase(phrase);
    if (isDedupeTarget(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(phrase);
  }

  return kept.join("\n");
}

function removeDuplicateLines(text: string): string {
  const lines = text
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) return text;

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = canonicalizePhrase(line);
    if (isDedupeTarget(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function compressContent(text: string, contentKind: MemoryReaderContentKind): string {
  const readableText = contentKind === "diff" ? text : stripMarkdownFormatting(text);
  const deduped =
    contentKind === "diff"
      ? removeDuplicateLines(readableText)
      : removeDuplicatePhrases(readableText);
  return normalizeReadFileText({ text: deduped, minify: true });
}

export function prepareMemoryReaderContent(params: {
  text: string;
  mode: MemoryReaderMode;
  contentKind?: MemoryReaderContentKind;
}): string {
  if (params.mode === "original") return params.text;
  return compressContent(params.text, params.contentKind ?? "memory");
}
