import { eq } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import { db } from "../../db/client.js";
import { syncStates } from "../../db/schema.js";
import {
  evidenceCacheFreshAfter,
  findDistillationEvidenceCache,
  upsertDistillationEvidenceCache,
} from "./distillation-evidence-cache.repository.js";
import {
  deriveSearchProviderCooldownSeconds,
  parseRetryAfterSeconds,
} from "./search-rate-limit.js";
import { stripMarkup, truncate } from "./url-fetcher.js";

export type DistillationToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type SearchProviderName = DistillationSearchProvider;

export type SearchProviderRateLimit = {
  status?: number;
  limit?: string;
  remaining?: string;
  reset?: string;
  policy?: string;
  retryAfter?: string;
  retryAfterSeconds?: number;
};

type SearchProviderResponse = {
  provider: SearchProviderName;
  results: SearchResult[];
  rateLimit?: SearchProviderRateLimit;
};

export type SearchProviderErrorState = {
  message: string;
  status?: number;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  rateLimit?: SearchProviderRateLimit;
};

type SearchProviderCooldownEntry = {
  cooldownUntil?: string;
  updatedAt?: string;
  lastError?: string;
  lastRateLimit?: SearchProviderRateLimit;
};

export type SearchProviderCooldownState = Partial<
  Record<SearchProviderName, SearchProviderCooldownEntry>
>;

const distillationSearchProviderStateId = "distillation_search_providers";
const providerNames: SearchProviderName[] = ["brave", "exa", "duckduckgo"];

export class SearchProviderException extends Error {
  readonly provider: SearchProviderName;
  readonly status?: number;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;
  readonly rateLimit?: SearchProviderRateLimit;

  constructor(params: {
    provider: SearchProviderName;
    message: string;
    status?: number;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
    rateLimit?: SearchProviderRateLimit;
  }) {
    super(params.message);
    this.name = "SearchProviderException";
    this.provider = params.provider;
    this.status = params.status;
    this.rateLimited = params.rateLimited ?? false;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.rateLimit = params.rateLimit;
  }
}

const defaultHeaders = {
  "user-agent":
    "memory-router-distillation/0.1 (+https://localhost; compile-ready knowledge verifier)",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
};

async function fetchWithTimeout(url: URL, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), groupedConfig.distillationTools.timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request timed out after ${groupedConfig.distillationTools.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeDistillationSearchQuery(query: string): string {
  return query.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toSearchProviderRateLimit(
  provider: SearchProviderName,
  response: Response,
): SearchProviderRateLimit | undefined {
  const retryAfter = response.headers.get("retry-after") ?? undefined;
  if (provider === "brave") {
    const limit = response.headers.get("x-ratelimit-limit") ?? undefined;
    const remaining = response.headers.get("x-ratelimit-remaining") ?? undefined;
    const reset = response.headers.get("x-ratelimit-reset") ?? undefined;
    const policy = response.headers.get("x-ratelimit-policy") ?? undefined;
    const rateLimit: SearchProviderRateLimit = {
      status: response.status,
      limit,
      remaining,
      reset,
      policy,
      retryAfter,
    };
    const retryAfterSeconds = deriveSearchProviderCooldownSeconds(provider, rateLimit);
    if (
      !limit &&
      !remaining &&
      !reset &&
      !policy &&
      !retryAfter &&
      retryAfterSeconds === undefined
    ) {
      return undefined;
    }
    return {
      ...rateLimit,
      retryAfterSeconds,
    };
  }

  const limit = response.headers.get("x-ratelimit-limit") ?? undefined;
  const remaining = response.headers.get("x-ratelimit-remaining") ?? undefined;
  const reset = response.headers.get("x-ratelimit-reset") ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfter);
  if (!limit && !remaining && !reset && !retryAfter && retryAfterSeconds === undefined) {
    return undefined;
  }
  return {
    status: response.status,
    limit,
    remaining,
    reset,
    retryAfter,
    retryAfterSeconds,
  };
}

function toSearchProviderError(
  provider: SearchProviderName,
  error: unknown,
): SearchProviderErrorState {
  if (error instanceof SearchProviderException) {
    return {
      message: error.message,
      status: error.status,
      rateLimited: error.rateLimited,
      retryAfterSeconds: error.retryAfterSeconds,
      rateLimit: error.rateLimit,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    rateLimited: message.toLowerCase().includes("429") || message.toLowerCase().includes("rate"),
  };
}

function normalizeSearchProviderState(value: unknown): SearchProviderCooldownState {
  const root = isRecord(value) ? (isRecord(value.providers) ? value.providers : value) : {};
  const normalized: SearchProviderCooldownState = {};
  for (const provider of providerNames) {
    const entry = root[provider];
    if (!isRecord(entry)) continue;
    normalized[provider] = {
      cooldownUntil: stringValue(entry.cooldownUntil),
      updatedAt: stringValue(entry.updatedAt),
      lastError: stringValue(entry.lastError),
      lastRateLimit: isRecord(entry.lastRateLimit)
        ? (entry.lastRateLimit as SearchProviderRateLimit)
        : undefined,
    };
  }
  return normalized;
}

async function loadSearchProviderState(): Promise<SearchProviderCooldownState> {
  try {
    const [row] = await db
      .select({ metadata: syncStates.metadata })
      .from(syncStates)
      .where(eq(syncStates.id, distillationSearchProviderStateId))
      .limit(1);
    return normalizeSearchProviderState(row?.metadata);
  } catch {
    return {};
  }
}

async function saveSearchProviderState(state: SearchProviderCooldownState): Promise<void> {
  const now = new Date();
  const metadata = { providers: state };
  await db
    .insert(syncStates)
    .values({
      id: distillationSearchProviderStateId,
      lastSyncedAt: now,
      cursor: {},
      metadata,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: syncStates.id,
      set: {
        lastSyncedAt: now,
        cursor: {},
        metadata,
        updatedAt: now,
      },
    });
}

function isProviderInCooldown(
  state: SearchProviderCooldownEntry | undefined,
  now: Date,
): { active: boolean; until?: string } {
  if (!state?.cooldownUntil) return { active: false };
  const untilMs = Date.parse(state.cooldownUntil);
  if (!Number.isFinite(untilMs) || untilMs <= now.getTime()) return { active: false };
  return { active: true, until: state.cooldownUntil };
}

function cleanDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeURIComponent(rawUrl);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return decoded;
  }
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  for (const blockMatch of html.matchAll(blockPattern)) {
    const block = blockMatch[1] ?? "";
    const linkMatch = block.match(
      /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;
    const snippetMatch = block.match(
      /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i,
    );
    const title = stripMarkup(linkMatch[2] ?? "");
    const url = cleanDuckDuckGoUrl(linkMatch[1] ?? "");
    const snippet = snippetMatch ? stripMarkup(snippetMatch[1] ?? "") : undefined;
    if (title && url) results.push({ title, url, snippet });
    if (results.length >= groupedConfig.distillationTools.searchResultCount) break;
  }
  return results;
}

async function searchWithBrave(query: string): Promise<SearchProviderResponse> {
  const provider: SearchProviderName = "brave";
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    throw new SearchProviderException({
      provider,
      message: "Brave API key is not configured",
    });
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(groupedConfig.distillationTools.searchResultCount));
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
    },
  });
  const rateLimit = toSearchProviderRateLimit(provider, response);
  if (!response.ok) {
    throw new SearchProviderException({
      provider,
      message: `Brave search HTTP ${response.status}`,
      status: response.status,
      rateLimited: response.status === 429,
      retryAfterSeconds: rateLimit?.retryAfterSeconds,
      rateLimit,
    });
  }
  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
  };
  const results = (payload.web?.results ?? [])
    .map((result) => ({
      title: typeof result.title === "string" ? stripMarkup(result.title) : "",
      url: typeof result.url === "string" ? result.url : "",
      snippet: typeof result.description === "string" ? stripMarkup(result.description) : undefined,
    }))
    .filter((result) => result.title && result.url)
    .slice(0, groupedConfig.distillationTools.searchResultCount);
  return {
    provider,
    results,
    rateLimit,
  };
}

async function searchWithExa(query: string): Promise<SearchProviderResponse> {
  const provider: SearchProviderName = "exa";
  const apiKey = process.env.MEMORY_ROUTER_EXA_API_KEY?.trim() || process.env.EXA_API_KEY?.trim();
  if (!apiKey) {
    throw new SearchProviderException({
      provider,
      message: "Exa API key is not configured",
    });
  }

  const url = new URL("https://api.exa.ai/search");
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: groupedConfig.distillationTools.searchResultCount,
    }),
  });
  const rateLimit = toSearchProviderRateLimit(provider, response);
  if (!response.ok) {
    throw new SearchProviderException({
      provider,
      message: `Exa search HTTP ${response.status}`,
      status: response.status,
      rateLimited: response.status === 429,
      retryAfterSeconds: rateLimit?.retryAfterSeconds,
      rateLimit,
    });
  }
  const payload = (await response.json()) as {
    results?: Array<{ title?: unknown; url?: unknown; text?: unknown; snippet?: unknown }>;
  };
  const results = (payload.results ?? [])
    .map((result) => {
      const snippetText =
        typeof result.snippet === "string"
          ? result.snippet
          : typeof result.text === "string"
            ? result.text
            : undefined;
      return {
        title: typeof result.title === "string" ? stripMarkup(result.title) : "",
        url: typeof result.url === "string" ? result.url : "",
        snippet: snippetText ? stripMarkup(snippetText) : undefined,
      };
    })
    .filter((result) => result.title && result.url)
    .slice(0, groupedConfig.distillationTools.searchResultCount);
  return {
    provider,
    results,
    rateLimit,
  };
}

async function searchWithDuckDuckGo(query: string): Promise<SearchProviderResponse> {
  const provider: SearchProviderName = "duckduckgo";
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetchWithTimeout(url, { headers: defaultHeaders });
  if (!response.ok) {
    throw new SearchProviderException({
      provider,
      message: `DuckDuckGo search HTTP ${response.status}`,
      status: response.status,
      rateLimited: response.status === 429,
      rateLimit: toSearchProviderRateLimit(provider, response),
    });
  }
  return {
    provider,
    results: parseDuckDuckGoResults(await response.text()),
    rateLimit: toSearchProviderRateLimit(provider, response),
  };
}

const searchProviderHandlers: Record<
  SearchProviderName,
  (query: string) => Promise<SearchProviderResponse>
> = {
  brave: searchWithBrave,
  exa: searchWithExa,
  duckduckgo: searchWithDuckDuckGo,
};

export async function searchWeb(
  query: unknown,
  options: { forceRefreshEvidence?: boolean } = {},
): Promise<DistillationToolResult> {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }

  const normalizedQuery = normalizeDistillationSearchQuery(query);
  if (!normalizedQuery) {
    throw new Error("query must be a non-empty string");
  }
  const cached = options.forceRefreshEvidence
    ? null
    : await findDistillationEvidenceCache({
        toolName: "search_web",
        queryText: normalizedQuery,
        freshAfter: evidenceCacheFreshAfter(
          groupedConfig.distillationTools.evidenceCacheTtlSeconds,
        ),
      }).catch(() => null);
  if (cached?.excerpt) {
    return {
      callId: "",
      name: "search_web",
      ok: cached.ok === 1,
      content: cached.excerpt,
      metadata: {
        query: normalizedQuery,
        cacheHit: true,
        cacheFetchedAt: cached.fetchedAt.toISOString(),
        ...(cached.metadata && typeof cached.metadata === "object"
          ? (cached.metadata as Record<string, unknown>)
          : {}),
      },
    };
  }

  const now = new Date();
  const configuredProviders =
    groupedConfig.distillationTools.searchProviders.length > 0
      ? groupedConfig.distillationTools.searchProviders
      : (["brave", "exa"] as SearchProviderName[]);
  const maxAttempts = Math.max(
    1,
    Math.min(groupedConfig.distillationTools.searchMaxProviderAttempts, configuredProviders.length),
  );
  const providerState = await loadSearchProviderState();
  const skippedProviders: Partial<Record<SearchProviderName, string>> = {};
  let providerCandidates = configuredProviders.filter((provider) => {
    const cooldown = isProviderInCooldown(providerState[provider], now);
    if (!cooldown.active) return true;
    if (cooldown.until) skippedProviders[provider] = cooldown.until;
    return false;
  });
  if (providerCandidates.length === 0) {
    providerCandidates = [...configuredProviders];
  }
  const providersToAttempt = providerCandidates.slice(0, maxAttempts);
  const attemptedProviders: SearchProviderName[] = [];
  const providerErrors: Partial<Record<SearchProviderName, SearchProviderErrorState>> = {};
  const rateLimit: Partial<Record<SearchProviderName, SearchProviderRateLimit>> = {};
  const cooldownUntil: Partial<Record<SearchProviderName, string>> = {};
  let providerStateDirty = false;
  let selected: SearchProviderResponse | undefined;

  for (const provider of providersToAttempt) {
    attemptedProviders.push(provider);
    try {
      const response = await searchProviderHandlers[provider](normalizedQuery);
      selected = response;
      if (response.rateLimit) {
        rateLimit[provider] = response.rateLimit;
      }
      if (providerState[provider]?.cooldownUntil) {
        delete providerState[provider];
        providerStateDirty = true;
      }
      if (response.results.length > 0 || attemptedProviders.length >= providersToAttempt.length) {
        break;
      }
    } catch (error) {
      const detail = toSearchProviderError(provider, error);
      providerErrors[provider] = detail;
      if (detail.rateLimit) {
        rateLimit[provider] = detail.rateLimit;
      }
      if (detail.rateLimited) {
        const cooldownSeconds = Math.max(
          60,
          Math.ceil(
            detail.retryAfterSeconds ??
              detail.rateLimit?.retryAfterSeconds ??
              groupedConfig.distillationTools.searchRateLimitCooldownSeconds,
          ),
        );
        const until = new Date(now.getTime() + cooldownSeconds * 1000).toISOString();
        providerState[provider] = {
          cooldownUntil: until,
          updatedAt: now.toISOString(),
          lastError: detail.message,
          lastRateLimit: detail.rateLimit ?? {
            status: detail.status,
            retryAfterSeconds: cooldownSeconds,
          },
        };
        cooldownUntil[provider] = until;
        providerStateDirty = true;
      }
    }
  }

  if (providerStateDirty) {
    await saveSearchProviderState(providerState).catch(() => undefined);
  }

  if (!selected) {
    const joinedErrors = Object.entries(providerErrors)
      .map(([provider, detail]) => `${provider}: ${detail.message}`)
      .join("; ");
    throw new Error(
      joinedErrors ? `search providers failed: ${joinedErrors}` : "search providers failed",
    );
  }

  const results = selected.results;
  const providerErrorsSummary = Object.fromEntries(
    Object.entries(providerErrors).map(([provider, detail]) => [provider, detail.message]),
  );
  const hasProviderErrors = Object.keys(providerErrorsSummary).length > 0;
  const hasRateLimit = Object.keys(rateLimit).length > 0;
  const hasCooldownUntil = Object.keys(cooldownUntil).length > 0;
  const hasSkippedProviders = Object.keys(skippedProviders).length > 0;
  const result = {
    callId: "",
    name: "search_web",
    ok: true,
    content: truncate(
      JSON.stringify(
        {
          query: normalizedQuery,
          results,
          instruction:
            "Use search results only to choose primary source URLs. Call fetch_content for 1-3 promising URLs before returning final JSON. Do not treat snippets as sufficient evidence for saved knowledge.",
        },
        null,
        2,
      ),
    ),
    metadata: {
      query: normalizedQuery,
      resultCount: results.length,
      provider: selected.provider,
      attemptedProviders,
      providerAttemptCount: attemptedProviders.length,
      skippedProviders: hasSkippedProviders ? skippedProviders : undefined,
      providerErrors: hasProviderErrors ? providerErrorsSummary : undefined,
      rateLimit: hasRateLimit ? rateLimit : undefined,
      cooldownApplied: hasCooldownUntil,
      cooldownUntil: hasCooldownUntil ? cooldownUntil : undefined,
      braveError: providerErrorsSummary.brave,
      forceRefreshEvidence: options.forceRefreshEvidence || undefined,
    },
  };
  await upsertDistillationEvidenceCache({
    toolName: "search_web",
    queryText: normalizedQuery,
    ok: true,
    excerpt: result.content,
    metadata: result.metadata,
  }).catch(() => undefined);
  return result;
}
