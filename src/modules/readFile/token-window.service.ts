export type TokenWindowSlice = {
  content: string;
  tokenRange: {
    from: number;
    toExclusive: number;
  };
  totalTokens: number;
  returnedTokens: number;
  hasMore: boolean;
  nextFromToken?: number;
};

type TokenSpan = {
  start: number;
  end: number;
};

function tokenizeSpans(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const value = match[0];
    if (!value) continue;
    const index = match.index ?? 0;
    spans.push({
      start: index,
      end: index + value.length,
    });
  }
  return spans;
}

export function sliceTextByTokenWindow(params: {
  text: string;
  fromToken: number;
  readTokens: number;
}): TokenWindowSlice {
  const spans = tokenizeSpans(params.text);
  const totalTokens = spans.length;
  const from = Math.max(0, Math.floor(params.fromToken));
  const requested = Math.max(1, Math.floor(params.readTokens));

  if (totalTokens === 0 || from >= totalTokens) {
    return {
      content: "",
      tokenRange: {
        from,
        toExclusive: from,
      },
      totalTokens,
      returnedTokens: 0,
      hasMore: false,
    };
  }

  const toExclusive = Math.min(totalTokens, from + requested);
  const start = spans[from]?.start ?? 0;
  const end = spans[toExclusive - 1]?.end ?? start;
  const content = params.text.slice(start, end);
  const returnedTokens = toExclusive - from;
  const hasMore = toExclusive < totalTokens;

  return {
    content,
    tokenRange: {
      from,
      toExclusive,
    },
    totalTokens,
    returnedTokens,
    hasMore,
    nextFromToken: hasMore ? toExclusive : undefined,
  };
}
