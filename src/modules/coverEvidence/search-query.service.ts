export type CoverEvidenceSearchQuery = {
  rawQuery: string;
  query: string;
  searchTerms: string[];
};

const maxSearchTerms = 3;

const searchStopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "when",
  "workflow",
  "verification",
  "avoid",
  "rule",
  "procedure",
  "title",
  "body",
  "candidate",
  "knowledge",
  "implementation",
  "with",
  "この",
  "その",
  "あの",
  "これ",
  "それ",
  "について",
  "とは",
  "では",
  "です",
  "ます",
  "する",
  "した",
  "して",
  "ください",
  "教えて",
  "関連ファイル",
  "既存実装パターン",
  "関連",
  "既存",
  "実装",
  "パターン",
  "固定",
  "候補",
]);

export function normalizeCoverEvidenceSearchTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const tokens =
    normalized.match(
      /(?:--?)?[a-z0-9][a-z0-9._:/@+-]*|[\p{Script=Han}\p{Script=Katakana}ー]{2,}/giu,
    ) ?? [];
  const terms: string[] = [];
  for (const token of tokens) {
    const value = token.trim();
    if (!value || searchStopWords.has(value)) continue;
    if (value.length < 2 && !value.startsWith("-")) continue;
    if (!terms.includes(value)) {
      terms.push(value);
    }
  }
  return terms.slice(0, maxSearchTerms);
}

export function buildCoverEvidenceSearchQuery(query: string): CoverEvidenceSearchQuery {
  const rawQuery = query.trim();
  if (!rawQuery) {
    throw new Error("query must be a non-empty string");
  }
  const searchTerms = normalizeCoverEvidenceSearchTerms(rawQuery);
  return {
    rawQuery,
    query: searchTerms.length > 0 ? searchTerms.join(" ") : rawQuery,
    searchTerms,
  };
}
