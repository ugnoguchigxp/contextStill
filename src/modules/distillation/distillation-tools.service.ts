import net from "node:net";
import sanitizeHtml from "sanitize-html";
import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";

export const distillationToolNames = ["search_web", "fetch_content"] as const;
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
  return isDistillationToolName(toolName) ? distillationToolAuditEventTypes[toolName] : null;
}

function isDistillationToolName(value: string): value is DistillationToolName {
  return distillationToolNames.includes(value as DistillationToolName);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

async function searchWithBrave(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return [];

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(groupedConfig.distillationTools.searchResultCount));
  const response = await fetchWithTimeout(url, {
    headers: {
      accept: "application/json",
      "x-subscription-token": apiKey,
    },
  });
  if (!response.ok) {
    throw new Error(`Brave search HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> };
  };
  return (payload.web?.results ?? [])
    .map((result) => ({
      title: typeof result.title === "string" ? stripMarkup(result.title) : "",
      url: typeof result.url === "string" ? result.url : "",
      snippet: typeof result.description === "string" ? stripMarkup(result.description) : undefined,
    }))
    .filter((result) => result.title && result.url)
    .slice(0, groupedConfig.distillationTools.searchResultCount);
}

async function searchWithDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = new URL("https://duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetchWithTimeout(url, { headers: defaultHeaders });
  if (!response.ok) {
    throw new Error(`DuckDuckGo search HTTP ${response.status}`);
  }
  return parseDuckDuckGoResults(await response.text());
}

async function searchWeb(query: unknown): Promise<DistillationToolResult> {
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string");
  }

  const normalizedQuery = query.trim();
  let braveError: string | undefined;
  let braveResults: SearchResult[] = [];
  try {
    braveResults = await searchWithBrave(normalizedQuery);
  } catch (error) {
    braveError = error instanceof Error ? error.message : String(error);
  }
  const results =
    braveResults.length > 0 ? braveResults : await searchWithDuckDuckGo(normalizedQuery);
  return {
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
    metadata: { query: normalizedQuery, resultCount: results.length, braveError },
  };
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

  return {
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
}

const distillationToolHandlers: Record<
  DistillationToolName,
  (args: Record<string, unknown>) => Promise<DistillationToolResult>
> = {
  search_web: (args) => searchWeb(args.query),
  fetch_content: (args) => fetchContent(args.url),
};

const distillationToolAuditEventTypes: Record<DistillationToolName, string> = {
  search_web: auditEventTypes.distillationWebSearch,
  fetch_content: auditEventTypes.distillationFetchContent,
};

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
    const result = await distillationToolHandlers[toolCall.function.name](args);

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
