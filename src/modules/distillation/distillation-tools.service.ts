import net from "node:net";
import { eq } from "drizzle-orm";
import sanitizeHtml from "sanitize-html";
import { groupedConfig } from "../../config.js";
import type { DistillationSearchProvider } from "../../config.types.js";
import { db } from "../../db/client.js";
import { syncStates } from "../../db/schema.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  contentHash,
  evidenceCacheFreshAfter,
  evidenceCacheKey,
  findDistillationEvidenceCache,
  upsertDistillationEvidenceCache,
} from "./distillation-evidence-cache.repository.js";
import {
  distillationReaderContextFromAudit,
  readDistillationSegment,
} from "./distillation-reader.service.js";

export const distillationEvidenceToolNames = ["search_web", "fetch_content"] as const;
export const distillationReadToolNames = ["read_source_segment", "read_vibe_segment"] as const;
export const distillationToolNames = [
  ...distillationEvidenceToolNames,
  ...distillationReadToolNames,
] as const;
export type DistillationToolName = (typeof distillationToolNames)[number];

export type DistillationToolDefinition = {
  type: "function";
  function: {
    name: DistillationToolName;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: false;
    };
  };
};

export type DistillationToolCall = {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type DistillationToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

type SearchProviderName = DistillationSearchProvider;

type SearchProviderRateLimit = {
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

type SearchProviderErrorState = {
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

type SearchProviderCooldownState = Partial<Record<SearchProviderName, SearchProviderCooldownEntry>>;

const distillationSearchProviderStateId = "distillation_search_providers";
const providerNames: SearchProviderName[] = ["brave", "exa", "duckduckgo"];

class SearchProviderException extends Error {
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

const maxRedirectHops = 5;

export type UrlSafetyResult = { safe: true } | { safe: false; reason: string };

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

export const distillationToolDefinitions: DistillationToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Search public web results for current documentation, specifications, APIs, packages, and URLs mentioned in evidence.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Focused search query.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_content",
      description:
        "Fetch and clean a public URL so claims can be grounded before distilling compile-ready knowledge.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "HTTP or HTTPS URL to fetch.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_source_segment",
      description:
        "Read one locally indexed source/wiki segment by locator before extracting candidates from large source material.",
      parameters: {
        type: "object",
        properties: {
          locator: {
            type: "string",
            description: "Locator exactly as listed in the source segment catalog.",
          },
          purpose: {
            type: "string",
            description: "Short reason for reading this segment.",
          },
        },
        required: ["locator"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_vibe_segment",
      description:
        "Read one locally indexed vibe memory or diff segment by locator before extracting candidates from large memory material.",
      parameters: {
        type: "object",
        properties: {
          locator: {
            type: "string",
            description: "Locator exactly as listed in the vibe segment catalog.",
          },
          purpose: {
            type: "string",
            description: "Short reason for reading this segment.",
          },
        },
        required: ["locator"],
        additionalProperties: false,
      },
    },
  },
];

function truncate(
  value: string,
  maxChars = groupedConfig.distillationTools.resultMaxChars,
): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripMarkup(html: string): string {
  const withoutNoisyBlocks = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  return compactWhitespace(
    decodeHtmlEntities(
      sanitizeHtml(withoutNoisyBlocks, {
        allowedTags: [],
        allowedAttributes: {},
      }),
    ),
  );
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function distillationToolAuditEventType(toolName: string): string | null {
  return isDistillationEvidenceToolName(toolName)
    ? distillationToolAuditEventTypes[toolName]
    : null;
}

function isDistillationToolName(value: string): value is DistillationToolName {
  return distillationToolNames.includes(value as DistillationToolName);
}

function isDistillationEvidenceToolName(
  value: string,
): value is (typeof distillationEvidenceToolNames)[number] {
  return distillationEvidenceToolNames.includes(
    value as (typeof distillationEvidenceToolNames)[number],
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    const seconds = Math.ceil((dateMs - Date.now()) / 1000);
    return seconds > 0 ? seconds : undefined;
  }
  return undefined;
}

function parseBraveResetSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  // Brave documents reset as header value; support both absolute epoch and relative seconds.
  if (parsed > 1_000_000_000) {
    const epochSeconds = parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
    const seconds = epochSeconds - Math.floor(Date.now() / 1000);
    return seconds > 0 ? seconds : undefined;
  }
  return Math.ceil(parsed);
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
    const retryAfterSeconds = parseRetryAfterSeconds(retryAfter ?? null) ?? parseBraveResetSeconds(reset);
    if (!limit && !remaining && !reset && !policy && !retryAfter && retryAfterSeconds === undefined) {
      return undefined;
    }
    return {
      status: response.status,
      limit,
      remaining,
      reset,
      policy,
      retryAfter,
      retryAfterSeconds,
    };
  }

  const limit = response.headers.get("x-ratelimit-limit") ?? undefined;
  const remaining = response.headers.get("x-ratelimit-remaining") ?? undefined;
  const reset = response.headers.get("x-ratelimit-reset") ?? undefined;
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfter ?? null);
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

async function recordDistillationToolAudit(params: {
  toolCall: DistillationToolCall;
  args: Record<string, unknown>;
  result: DistillationToolResult;
  durationMs: number;
  auditContext?: Record<string, unknown>;
}): Promise<void> {
  const eventType = distillationToolAuditEventType(params.toolCall.function.name);
  if (!eventType) return;

  const metadata = params.result.metadata ?? {};
  const payload: Record<string, unknown> = {
    ...(params.auditContext ?? {}),
    callId: params.toolCall.id,
    toolName: params.toolCall.function.name,
    ok: params.result.ok,
    durationMs: params.durationMs,
  };

  if (params.toolCall.function.name === "search_web") {
    payload.query = stringValue(params.args.query);
    payload.resultCount =
      typeof metadata.resultCount === "number" ? metadata.resultCount : undefined;
    payload.provider = stringValue(metadata.provider);
    payload.attemptedProviders = Array.isArray(metadata.attemptedProviders)
      ? metadata.attemptedProviders
      : undefined;
    payload.providerAttemptCount =
      typeof metadata.providerAttemptCount === "number" ? metadata.providerAttemptCount : undefined;
    payload.providerErrors = isRecord(metadata.providerErrors)
      ? (metadata.providerErrors as Record<string, unknown>)
      : undefined;
    payload.rateLimit = isRecord(metadata.rateLimit)
      ? (metadata.rateLimit as Record<string, unknown>)
      : undefined;
    payload.cooldownApplied =
      typeof metadata.cooldownApplied === "boolean" ? metadata.cooldownApplied : undefined;
    payload.cooldownUntil = isRecord(metadata.cooldownUntil)
      ? (metadata.cooldownUntil as Record<string, unknown>)
      : undefined;
    payload.cacheHit = typeof metadata.cacheHit === "boolean" ? metadata.cacheHit : undefined;
    payload.braveError = stringValue(metadata.braveError);
  }

  if (params.toolCall.function.name === "fetch_content") {
    payload.url = stringValue(params.args.url);
    payload.finalUrl = stringValue(metadata.finalUrl);
    payload.contentChars =
      typeof metadata.contentChars === "number" ? metadata.contentChars : undefined;
    payload.redirectCount =
      typeof metadata.redirectCount === "number" ? metadata.redirectCount : undefined;
  }

  if (!params.result.ok) {
    payload.error = params.result.error;
  }

  await recordAuditLogSafe({
    eventType,
    actor: "system",
    payload,
  });
}

function normalizeUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("url must be a non-empty string");
  }
  const url = new URL(rawUrl.trim());
  const safety = validateFetchContentUrl(url);
  if (!safety.safe) {
    throw new Error(`fetch_content blocked: ${safety.reason}`);
  }
  return url;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }
  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  return false;
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (/^fe[89ab][0-9a-f:]*$/i.test(normalized)) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f:]*$/i.test(normalized)) return true; // unique local fc00::/7

  const mappedMatch = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedMatch && isPrivateIpv4(mappedMatch[1] ?? "")) return true;
  return false;
}

export function validateFetchContentUrl(input: string | URL): UrlSafetyResult {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input.trim()) : new URL(input.href);
  } catch {
    return { safe: false, reason: "invalid URL" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: "protocol must be http or https" };
  }

  const hostname = url.hostname.trim().replace(/\.$/, "").toLowerCase();
  if (!hostname) {
    return { safe: false, reason: "hostname is empty" };
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { safe: false, reason: "localhost is not allowed" };
  }
  if (hostname === "169.254.169.254") {
    return { safe: false, reason: "cloud metadata endpoint is blocked" };
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4 && isPrivateIpv4(hostname)) {
    return { safe: false, reason: "private or loopback IPv4 is blocked" };
  }
  if (ipVersion === 6 && isBlockedIpv6(hostname)) {
    return { safe: false, reason: "private, loopback, or link-local IPv6 is blocked" };
  }

  return { safe: true };
}

function cleanDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeHtmlEntities(rawUrl);
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

async function searchWeb(query: unknown): Promise<DistillationToolResult> {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }

  const normalizedQuery = query.trim();
  const queryHash = evidenceCacheKey(normalizedQuery);
  const cached = await findDistillationEvidenceCache({
    toolName: "search_web",
    queryHash,
    freshAfter: evidenceCacheFreshAfter(groupedConfig.distillationTools.evidenceCacheTtlSeconds),
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
      : (["duckduckgo"] as SearchProviderName[]);
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
      if (
        response.results.length > 0 ||
        attemptedProviders.length >= providersToAttempt.length
      ) {
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
          lastRateLimit:
            detail.rateLimit ?? {
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
            "Use search results to choose URLs to fetch. Do not treat snippets as sufficient evidence for saved knowledge.",
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
    },
  };
  await upsertDistillationEvidenceCache({
    toolName: "search_web",
    queryHash,
    queryText: normalizedQuery,
    ok: true,
    excerpt: result.content,
    contentHash: contentHash(result.content),
    metadata: result.metadata,
  }).catch(() => undefined);
  return result;
}

function isLikelyHtml(contentType: string, body: string): boolean {
  return contentType.includes("html") || /<\/?[a-z][\s\S]*>/i.test(body);
}

async function fetchUrlText(
  url: URL,
): Promise<{ text: string; finalUrl: string; contentType: string; redirectCount: number }> {
  let current = new URL(url.href);
  for (let redirectCount = 0; redirectCount <= maxRedirectHops; redirectCount += 1) {
    const safety = validateFetchContentUrl(current);
    if (!safety.safe) {
      throw new Error(`fetch_content blocked: ${safety.reason}`);
    }

    const response = await fetchWithTimeout(current, {
      headers: defaultHeaders,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("fetch_content blocked: redirect location missing");
      }
      const redirectedUrl = new URL(location, current);
      const redirectedSafety = validateFetchContentUrl(redirectedUrl);
      if (!redirectedSafety.safe) {
        throw new Error(`fetch_content blocked: redirect target ${redirectedSafety.reason}`);
      }
      current = redirectedUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`fetch_content HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    const text = isLikelyHtml(contentType, body) ? stripMarkup(body) : compactWhitespace(body);
    return {
      text,
      finalUrl: current.href,
      contentType,
      redirectCount,
    };
  }
  throw new Error(`fetch_content blocked: redirect limit exceeded (${maxRedirectHops})`);
}

async function fetchContent(rawUrl: unknown): Promise<DistillationToolResult> {
  const url = normalizeUrl(rawUrl);
  const queryHash = evidenceCacheKey(url.href);
  const cached = await findDistillationEvidenceCache({
    toolName: "fetch_content",
    queryHash,
    url: url.href,
    freshAfter: evidenceCacheFreshAfter(groupedConfig.distillationTools.evidenceCacheTtlSeconds),
  }).catch(() => null);
  if (cached?.excerpt) {
    return {
      callId: "",
      name: "fetch_content",
      ok: cached.ok === 1,
      content: cached.excerpt,
      metadata: {
        url: url.href,
        cacheHit: true,
        cacheFetchedAt: cached.fetchedAt.toISOString(),
        ...(cached.metadata && typeof cached.metadata === "object"
          ? (cached.metadata as Record<string, unknown>)
          : {}),
      },
    };
  }

  let fetched: { text: string; finalUrl: string; contentType: string; redirectCount: number };

  try {
    fetched = await fetchUrlText(url);
  } catch (directError) {
    const directErrorMessage =
      directError instanceof Error ? directError.message : String(directError);
    if (directErrorMessage.includes("fetch_content blocked")) {
      throw directError;
    }
    const readerUrl = new URL(`https://r.jina.ai/http://${url.href.replace(/^https?:\/\//, "")}`);
    try {
      fetched = await fetchUrlText(readerUrl);
    } catch {
      throw directError;
    }
  }

  const content = truncate(
    JSON.stringify(
      {
        url: url.href,
        finalUrl: fetched.finalUrl,
        contentType: fetched.contentType,
        text: fetched.text,
        instruction:
          "Distill only compact rule/procedure guidance from this evidence. Do not copy long excerpts.",
      },
      null,
      2,
    ),
  );

  const result = {
    callId: "",
    name: "fetch_content",
    ok: true,
    content,
    metadata: {
      url: url.href,
      finalUrl: fetched.finalUrl,
      contentChars: fetched.text.length,
      redirectCount: fetched.redirectCount,
    },
  };
  await upsertDistillationEvidenceCache({
    toolName: "fetch_content",
    queryHash,
    queryText: url.href,
    url: url.href,
    ok: true,
    excerpt: result.content,
    contentHash: contentHash(fetched.text),
    metadata: result.metadata,
  }).catch(() => undefined);
  return result;
}

const distillationToolHandlers: Record<
  DistillationToolName,
  (
    args: Record<string, unknown>,
    auditContext?: Record<string, unknown>,
  ) => Promise<DistillationToolResult>
> = {
  search_web: (args) => searchWeb(args.query),
  fetch_content: (args) => fetchContent(args.url),
  read_source_segment: (args, auditContext) =>
    readSegmentTool("read_source_segment", args, auditContext),
  read_vibe_segment: (args, auditContext) =>
    readSegmentTool("read_vibe_segment", args, auditContext),
};

const distillationToolAuditEventTypes: Record<
  (typeof distillationEvidenceToolNames)[number],
  string
> = {
  search_web: auditEventTypes.distillationWebSearch,
  fetch_content: auditEventTypes.distillationFetchContent,
};

async function readSegmentTool(
  name: "read_source_segment" | "read_vibe_segment",
  args: Record<string, unknown>,
  auditContext?: Record<string, unknown>,
): Promise<DistillationToolResult> {
  const context = distillationReaderContextFromAudit(auditContext);
  if (!context?.enabled) {
    throw new Error(`${name} is not enabled for this distillation session`);
  }
  if (name === "read_source_segment" && context.source.sourceKind !== "source_fragment") {
    throw new Error("read_source_segment is only available for source/wiki distillation");
  }
  if (name === "read_vibe_segment" && context.source.sourceKind !== "vibe_memory") {
    throw new Error("read_vibe_segment is only available for vibe memory distillation");
  }
  const locator = stringValue(args.locator);
  if (!locator) {
    throw new Error("locator must be a non-empty string");
  }
  const read = await readDistillationSegment({
    context,
    locator,
    purpose: stringValue(args.purpose),
    candidateId: stringValue(auditContext?.candidateRowId),
  });
  return {
    callId: "",
    name,
    ok: read.ok,
    content: JSON.stringify(read, null, 2),
    metadata: read.ok
      ? {
          locator: read.locator,
          contentHash: read.contentHash,
          charCount: read.charCount,
          truncated: read.truncated,
          readCount: read.readCount,
          maxReads: read.maxReads,
        }
      : {
          error: read.error,
          readCount: read.readCount,
          maxReads: read.maxReads,
        },
    error: read.ok ? undefined : read.error,
  };
}

export async function executeDistillationToolCall(
  toolCall: DistillationToolCall,
  auditContext?: Record<string, unknown>,
): Promise<DistillationToolResult> {
  const startedAt = Date.now();
  const args = parseToolArguments(toolCall.function.arguments);
  try {
    if (!isDistillationToolName(toolCall.function.name)) {
      throw new Error(`unknown distillation tool: ${toolCall.function.name}`);
    }
    const result = await distillationToolHandlers[toolCall.function.name](args, auditContext);

    const auditedResult = {
      ...result,
      callId: toolCall.id,
    };
    await recordDistillationToolAudit({
      toolCall,
      args,
      result: auditedResult,
      durationMs: Date.now() - startedAt,
      auditContext,
    });
    return auditedResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureResult = {
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: false,
      content: JSON.stringify({
        error: message,
        instruction: "Treat this tool result as insufficient evidence for external claims.",
      }),
      error: message,
    };
    await recordDistillationToolAudit({
      toolCall,
      args,
      result: failureResult,
      durationMs: Date.now() - startedAt,
      auditContext,
    });
    return failureResult;
  }
}
