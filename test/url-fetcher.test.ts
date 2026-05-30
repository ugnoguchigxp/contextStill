import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findDistillationEvidenceCache,
  upsertDistillationEvidenceCache,
} from "../src/modules/distillation/distillation-evidence-cache.repository.js";
import {
  compactWhitespace,
  decodeHtmlEntities,
  fetchContent,
  stripMarkup,
  validateFetchContentUrl,
} from "../src/modules/distillation/url-fetcher.js";

vi.mock("../src/modules/distillation/distillation-evidence-cache.repository.js", () => ({
  evidenceCacheFreshAfter: vi.fn().mockReturnValue(new Date()),
  findDistillationEvidenceCache: vi.fn(),
  upsertDistillationEvidenceCache: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("url-fetcher validateFetchContentUrl", () => {
  it("allows safe public HTTP and HTTPS URLs", () => {
    expect(validateFetchContentUrl("https://example.com")).toEqual({ safe: true });
    expect(validateFetchContentUrl("http://google.com/search?q=test")).toEqual({ safe: true });
  });

  it("blocks invalid URLs", () => {
    expect(validateFetchContentUrl("not-a-url")).toEqual({ safe: false, reason: "invalid URL" });
    expect(validateFetchContentUrl("ftp://example.com")).toEqual({
      safe: false,
      reason: "protocol must be http or https",
    });
  });

  it("blocks empty or localhost hostnames", () => {
    expect(validateFetchContentUrl("https://localhost")).toEqual({
      safe: false,
      reason: "localhost is not allowed",
    });
    expect(validateFetchContentUrl("https://test.localhost")).toEqual({
      safe: false,
      reason: "localhost is not allowed",
    });
  });

  it("blocks cloud metadata endpoint", () => {
    expect(validateFetchContentUrl("http://169.254.169.254")).toEqual({
      safe: false,
      reason: "cloud metadata endpoint is blocked",
    });
  });

  it("blocks private IPv4 addresses", () => {
    expect(validateFetchContentUrl("http://127.0.0.1")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
    expect(validateFetchContentUrl("http://192.168.0.1")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
    expect(validateFetchContentUrl("http://10.255.255.254")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
    expect(validateFetchContentUrl("http://172.16.0.1")).toEqual({
      safe: false,
      reason: "private or loopback IPv4 is blocked",
    });
  });

  it("blocks loopback and link-local IPv6 addresses", () => {
    expect(validateFetchContentUrl("http://[::1]")).toEqual({
      safe: false,
      reason: "private, loopback, or link-local IPv6 is blocked",
    });
    expect(validateFetchContentUrl("http://[fe80::1]")).toEqual({
      safe: false,
      reason: "private, loopback, or link-local IPv6 is blocked",
    });
    expect(validateFetchContentUrl("http://[fc00::]")).toEqual({
      safe: false,
      reason: "private, loopback, or link-local IPv6 is blocked",
    });
  });
});

describe("url-fetcher text processing utilities", () => {
  it("compacts redundant whitespace", () => {
    expect(compactWhitespace("  hello   world  \n new line  ")).toBe("hello world new line");
  });

  it("decodes HTML entities correctly", () => {
    expect(decodeHtmlEntities("hello &amp; world &lt;test&gt;")).toBe("hello & world <test>");
    expect(decodeHtmlEntities("&#39;test&#39;")).toBe("'test'");
    expect(decodeHtmlEntities("&#x22;hex&#x22;")).toBe('"hex"');
  });

  it("strips HTML markup and noisy elements", () => {
    const rawHtml = `
      <header>Navigation Header</header>
      <main>
        <h1>Main Title</h1>
        <script>console.log("noisy script");</script>
        <style>body { color: red; }</style>
        <p>This is <strong>important</strong> content.</p>
      </main>
      <footer>Footer Info</footer>
    `;
    const stripped = stripMarkup(rawHtml);
    expect(stripped).toContain("Main Title");
    expect(stripped).toContain("This is important content.");
    expect(stripped).not.toContain("Navigation Header");
    expect(stripped).not.toContain("noisy script");
    expect(stripped).not.toContain("Footer Info");
  });
});

describe("url-fetcher fetchContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cache hit results directly if present", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue({
      id: "cached-1",
      toolName: "fetch_content",
      queryText: "https://example.com",
      url: "https://example.com",
      ok: 1,
      excerpt: "Cached Text Content",
      fetchedAt: new Date(),
      metadata: { original: true },
    } as any);

    const result = await fetchContent("https://example.com");
    expect(result.ok).toBe(true);
    expect(result.content).toBe("Cached Text Content");
    expect(result.metadata?.cacheHit).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches and sanitizes HTML content on cache miss", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/html"]]),
      text: async () =>
        "<html><body><h1>Hello World</h1><script>console.log('noisy')</script></body></html>",
    };
    mockFetch.mockResolvedValue(mockResponse);

    const result = await fetchContent("https://example.com");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Hello World");
    expect(result.content).not.toContain("noisy");
    expect(upsertDistillationEvidenceCache).toHaveBeenCalled();
  });

  it("throws validation errors for unsafe URLs", async () => {
    await expect(fetchContent("http://127.0.0.1")).rejects.toThrow("fetch_content blocked");
    await expect(fetchContent("")).rejects.toThrow("url must be a non-empty string");
  });

  it("handles HTTP errors by trying jina reader fallback and throwing original error if both fail", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    // First call to example.com fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Map(),
      text: async () => "Server Error",
    });

    // Fallback call to jina.ai reader also fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Map(),
      text: async () => "Gateway Timeout",
    });

    await expect(fetchContent("https://example.com")).rejects.toThrow("fetch_content HTTP 500");
  });

  it("falls back to jina reader and succeeds when direct fetch fails", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    // First call direct fails
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Map(),
      text: async () => "Forbidden",
    });

    // Second call to r.jina.ai succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "Fallback Successful Plain Content",
    });

    const result = await fetchContent("https://example.com");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Fallback Successful Plain Content");
  });

  it("handles redirect chains up to the redirect limit", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    // Mock 6 successive redirects (Limit is 5 hops)
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Map([["location", `https://example.com/redirect-${i}`]]),
      });
    }

    await expect(fetchContent("https://example.com")).rejects.toThrow("redirect limit exceeded");
  });

  it("follows valid redirects and retrieves final content", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    // First hop redirects
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Map([["location", "https://example.com/target"]]),
    });

    // Second hop succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "Redirect Target Content",
    });

    const result = await fetchContent("https://example.com");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Redirect Target Content");
    expect(result.metadata?.redirectCount).toBe(1);
    expect(result.metadata?.finalUrl).toBe("https://example.com/target");
  });

  it("throws error if redirect location header is missing", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Map(), // no location
    });

    await expect(fetchContent("https://example.com")).rejects.toThrow("redirect location missing");
  });

  it("blocks redirect to an unsafe target URL", async () => {
    vi.mocked(findDistillationEvidenceCache).mockResolvedValue(null);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Map([["location", "http://127.0.0.1/unsafe"]]),
    });

    await expect(fetchContent("https://example.com")).rejects.toThrow(
      "fetch_content blocked: redirect target private or loopback IPv4 is blocked",
    );
  });
});
