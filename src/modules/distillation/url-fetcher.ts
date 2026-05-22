import net from "node:net";
import sanitizeHtml from "sanitize-html";
import { groupedConfig } from "../../config.js";
import {
  evidenceCacheFreshAfter,
  findDistillationEvidenceCache,
  upsertDistillationEvidenceCache,
} from "./distillation-evidence-cache.repository.js";

export type UrlSafetyResult = { safe: true } | { safe: false; reason: string };

export type DistillationToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

const defaultHeaders = {
  "user-agent":
    "memory-router-distillation/0.1 (+https://localhost; compile-ready knowledge verifier)",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
};

const maxRedirectHops = 5;

export function truncate(
  value: string,
  maxChars = groupedConfig.distillationTools.resultMaxChars,
): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24))}\n...[truncated]`;
}

export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function decodeHtmlEntities(value: string): string {
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

export function stripMarkup(html: string): string {
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

  let cleanHostname = hostname;
  if (cleanHostname.startsWith("[") && cleanHostname.endsWith("]")) {
    cleanHostname = cleanHostname.slice(1, -1);
  }

  const ipVersion = net.isIP(cleanHostname);
  if (ipVersion === 4 && isPrivateIpv4(cleanHostname)) {
    return { safe: false, reason: "private or loopback IPv4 is blocked" };
  }
  if (ipVersion === 6 && isBlockedIpv6(cleanHostname)) {
    return { safe: false, reason: "private, loopback, or link-local IPv6 is blocked" };
  }

  return { safe: true };
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

export async function fetchContent(
  rawUrl: unknown,
  options: { forceRefreshEvidence?: boolean } = {},
): Promise<DistillationToolResult> {
  const url = normalizeUrl(rawUrl);
  const cached = options.forceRefreshEvidence
    ? null
    : await findDistillationEvidenceCache({
        toolName: "fetch_content",
        queryText: url.href,
        url: url.href,
        freshAfter: evidenceCacheFreshAfter(
          groupedConfig.distillationTools.evidenceCacheTtlSeconds,
        ),
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
      forceRefreshEvidence: options.forceRefreshEvidence || undefined,
    },
  };
  await upsertDistillationEvidenceCache({
    toolName: "fetch_content",
    queryText: url.href,
    url: url.href,
    ok: true,
    excerpt: result.content,
    metadata: result.metadata,
  }).catch(() => undefined);
  return result;
}
