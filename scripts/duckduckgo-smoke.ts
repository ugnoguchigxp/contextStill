#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type EndpointName = "html" | "lite";
type HeaderProfileName = "current" | "browser" | "none";

type CliOptions = {
  query: string;
  endpoints: EndpointName[];
  profiles: HeaderProfileName[];
  timeoutMs: number;
  json: boolean;
  saveHtmlDir?: string;
};

type RedirectHop = {
  status: number;
  url: string;
  location?: string;
};

type SmokeResult = {
  endpoint: EndpointName;
  profile: HeaderProfileName;
  query: string;
  ok: boolean;
  botLikely: boolean;
  status: number | null;
  finalUrl: string;
  redirects: RedirectHop[];
  contentType: string | null;
  bodyChars: number;
  title: string | null;
  markers: string[];
  resultCount: number;
  results: SearchResult[];
  htmlPath?: string;
  error?: string;
};

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

const currentHeaders = {
  "user-agent":
    "context-still-distillation/0.1 (+https://localhost; compile-ready knowledge verifier)",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
};

const browserHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,ja;q=0.8",
};

function usage(): string {
  return [
    "Usage: bun run scripts/duckduckgo-smoke.ts [options]",
    "",
    "Options:",
    "  --query <text>          Search query. Default: memory router context compile",
    "  --endpoint <name>       html, lite, or both. Default: both",
    "  --profile <name>        current, browser, none, or all. Default: current",
    "  --timeout-ms <number>   Request timeout per HTTP hop. Default: 15000",
    "  --save-html [dir]       Save returned HTML for inspection. Default dir: logs/duckduckgo-smoke",
    "  --json                  Print JSON only",
    "  --help                  Show this help",
  ].join("\n");
}

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseEndpoint(value: string): EndpointName[] {
  if (value === "both") return ["html", "lite"];
  if (value === "html" || value === "lite") return [value];
  throw new Error("--endpoint must be html, lite, or both");
}

function parseProfile(value: string): HeaderProfileName[] {
  if (value === "all") return ["current", "browser", "none"];
  if (value === "current" || value === "browser" || value === "none") return [value];
  throw new Error("--profile must be current, browser, none, or all");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    query: "memory router context compile",
    endpoints: ["html", "lite"],
    profiles: ["current"],
    timeoutMs: 15_000,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--query" || arg.startsWith("--query=")) {
      options.query = readArgValue(args, index, "--query").trim();
      if (arg === "--query") index += 1;
    } else if (arg === "--endpoint" || arg.startsWith("--endpoint=")) {
      options.endpoints = parseEndpoint(readArgValue(args, index, "--endpoint").trim());
      if (arg === "--endpoint") index += 1;
    } else if (arg === "--profile" || arg.startsWith("--profile=")) {
      options.profiles = parseProfile(readArgValue(args, index, "--profile").trim());
      if (arg === "--profile") index += 1;
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      const value = Number(readArgValue(args, index, "--timeout-ms"));
      if (!Number.isInteger(value) || value < 1000) {
        throw new Error("--timeout-ms must be an integer >= 1000");
      }
      options.timeoutMs = value;
      if (arg === "--timeout-ms") index += 1;
    } else if (arg === "--save-html" || arg.startsWith("--save-html=")) {
      const inline = arg.match(/^--save-html=(.*)$/)?.[1];
      if (inline !== undefined) {
        options.saveHtmlDir = inline.trim() || "logs/duckduckgo-smoke";
      } else {
        const next = args[index + 1];
        if (next && !next.startsWith("--")) {
          options.saveHtmlDir = next.trim() || "logs/duckduckgo-smoke";
          index += 1;
        } else {
          options.saveHtmlDir = "logs/duckduckgo-smoke";
        }
      }
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.query) throw new Error("--query must not be empty");
  return options;
}

function endpointUrl(endpoint: EndpointName, query: string): URL {
  const url =
    endpoint === "html"
      ? new URL("https://duckduckgo.com/html/")
      : new URL("https://lite.duckduckgo.com/lite/");
  url.searchParams.set("q", query);
  return url;
}

function headersForProfile(profile: HeaderProfileName): HeadersInit | undefined {
  if (profile === "current") return currentHeaders;
  if (profile === "browser") return browserHeaders;
  return undefined;
}

async function fetchWithTimeout(
  url: URL,
  options: { headers?: HeadersInit; timeoutMs: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, {
      headers: options.headers,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFollowingRedirects(params: {
  url: URL;
  headers?: HeadersInit;
  timeoutMs: number;
}): Promise<{ response: Response; redirects: RedirectHop[] }> {
  let currentUrl = params.url;
  const redirects: RedirectHop[] = [];
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await fetchWithTimeout(currentUrl, {
      headers: params.headers,
      timeoutMs: params.timeoutMs,
    });
    const location = response.headers.get("location") ?? undefined;
    if (!location || response.status < 300 || response.status >= 400) {
      return { response, redirects };
    }
    redirects.push({
      status: response.status,
      url: currentUrl.href,
      location,
    });
    currentUrl = new URL(location, currentUrl);
  }
  throw new Error("redirect limit exceeded");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function stripMarkup(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function cleanDuckDuckGoUrl(rawUrl: string): string {
  const decoded = decodeHtmlEntities(decodeURIComponent(rawUrl));
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return decoded;
  }
}

function parseHtmlResults(html: string): SearchResult[] {
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
    if (results.length >= 10) break;
  }
  return results;
}

function parseLiteResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorPattern = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const href = match[1] ?? "";
    const title = stripMarkup(match[2] ?? "");
    const url = cleanDuckDuckGoUrl(href);
    if (!title || !url) continue;
    if (url.includes("duckduckgo.com") && !href.includes("uddg=")) continue;
    if (/^(next|previous|feedback|settings)$/i.test(title)) continue;
    results.push({ title, url });
    if (results.length >= 10) break;
  }
  return results;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? stripMarkup(match[1] ?? "") : "";
  return title || null;
}

function detectMarkers(html: string): string[] {
  const checks: Array<[string, RegExp]> = [
    ["captcha", /captcha/i],
    ["bot-message", /bots use duckduckgo|made by a human|not a robot/i],
    ["anomaly", /anomaly-modal|anomaly detected|unusual traffic|automated queries/i],
    ["challenge", /challenge-form|complete the following challenge|verify you are human/i],
    ["no-results", /no results|not many results/i],
    ["result-link", /result__a|result-link|result-snippet/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(html)).map(([name]) => name);
}

function looksBotBlocked(status: number | null, markers: string[], resultCount: number): boolean {
  if (status === 403 || status === 429 || status === 202) return true;
  if (markers.some((marker) => ["captcha", "bot-message"].includes(marker))) {
    return true;
  }
  if (resultCount === 0 && markers.some((marker) => ["anomaly", "challenge"].includes(marker))) {
    return true;
  }
  return resultCount === 0 && status !== 200;
}

async function maybeSaveHtml(params: {
  dir?: string;
  endpoint: EndpointName;
  profile: HeaderProfileName;
  html: string;
}): Promise<string | undefined> {
  if (!params.dir) return undefined;
  await mkdir(params.dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${params.endpoint}-${params.profile}.html`;
  const fullPath = path.resolve(params.dir, filename);
  await writeFile(fullPath, params.html, "utf8");
  return fullPath;
}

async function runOne(params: {
  endpoint: EndpointName;
  profile: HeaderProfileName;
  query: string;
  timeoutMs: number;
  saveHtmlDir?: string;
}): Promise<SmokeResult> {
  const url = endpointUrl(params.endpoint, params.query);
  try {
    const { response, redirects } = await fetchFollowingRedirects({
      url,
      headers: headersForProfile(params.profile),
      timeoutMs: params.timeoutMs,
    });
    const html = await response.text();
    const results = params.endpoint === "html" ? parseHtmlResults(html) : parseLiteResults(html);
    const markers = detectMarkers(html);
    const htmlPath = await maybeSaveHtml({
      dir: params.saveHtmlDir,
      endpoint: params.endpoint,
      profile: params.profile,
      html,
    });
    const status = response.status;
    return {
      endpoint: params.endpoint,
      profile: params.profile,
      query: params.query,
      ok: response.ok && results.length > 0,
      botLikely: looksBotBlocked(status, markers, results.length),
      status,
      finalUrl: response.url || url.href,
      redirects,
      contentType: response.headers.get("content-type"),
      bodyChars: html.length,
      title: extractTitle(html),
      markers,
      resultCount: results.length,
      results,
      ...(htmlPath ? { htmlPath } : {}),
    };
  } catch (error) {
    return {
      endpoint: params.endpoint,
      profile: params.profile,
      query: params.query,
      ok: false,
      botLikely: false,
      status: null,
      finalUrl: url.href,
      redirects: [],
      contentType: null,
      bodyChars: 0,
      title: null,
      markers: [],
      resultCount: 0,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function printText(results: SmokeResult[]): void {
  for (const result of results) {
    process.stdout.write(
      `${[
        `[${result.endpoint}/${result.profile}] ok=${result.ok} botLikely=${result.botLikely}`,
        `  status=${result.status ?? "-"} contentType=${result.contentType ?? "-"}`,
        `  finalUrl=${result.finalUrl}`,
        `  redirects=${result.redirects.length} bodyChars=${result.bodyChars} title=${result.title ?? "-"}`,
        `  markers=${result.markers.length ? result.markers.join(",") : "-"}`,
        `  resultCount=${result.resultCount}`,
        ...result.results
          .slice(0, 3)
          .map((item, index) => `  ${index + 1}. ${item.title} <${item.url}>`),
        result.htmlPath ? `  htmlPath=${result.htmlPath}` : "",
        result.error ? `  error=${result.error}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n")}\n\n`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results: SmokeResult[] = [];
  for (const endpoint of options.endpoints) {
    for (const profile of options.profiles) {
      results.push(
        await runOne({
          endpoint,
          profile,
          query: options.query,
          timeoutMs: options.timeoutMs,
          saveHtmlDir: options.saveHtmlDir,
        }),
      );
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  } else {
    printText(results);
  }

  if (results.some((result) => result.ok)) return;
  process.exitCode = results.some((result) => result.botLikely) ? 2 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
