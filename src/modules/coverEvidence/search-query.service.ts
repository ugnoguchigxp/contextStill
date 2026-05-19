export type CoverEvidenceSearchQuery = {
  rawQuery: string;
  query: string;
  searchTerms: string[];
};

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
]);

export function normalizeCoverEvidenceSearchTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLowerCase();
  const tokens =
    normalized.match(
      /(?:--?)?[a-z0-9][a-z0-9._:/@+-]*|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/giu,
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
  return terms.slice(0, 12);
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
