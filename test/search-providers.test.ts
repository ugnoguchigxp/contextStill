import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeDistillationSearchQuery,
  searchWeb,
  SearchProviderException,
} from "../src/modules/distillation/search-providers.js";
import { db } from "../src/db/client.js";
import {
  findDistillationEvidenceCache,
  upsertDistillationEvidenceCache,
} from "../src/modules/distillation/distillation-evidence-cache.repository.js";
import { groupedConfig } from "../src/config.js";

// モック定義
vi.mock("../src/db/client.js", () => {
  const mockSelectResult = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]), // デフォルトは状態なし
  };

  const mockInsertResult = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue({}),
  };

  return {
    db: {
      select: vi.fn(() => mockSelectResult),
      insert: vi.fn(() => mockInsertResult),
    },
  };
});

vi.mock("../src/modules/distillation/distillation-evidence-cache.repository.js", () => {
  return {
    evidenceCacheFreshAfter: vi.fn(() => new Date()),
    findDistillationEvidenceCache: vi.fn(),
    upsertDistillationEvidenceCache: vi.fn().mockResolvedValue({}),
  };
});

describe("SearchProviderException", () => {
  it("constructs correct error instance", () => {
    const exc = new SearchProviderException({
      provider: "brave",
      message: "Rate limited",
      status: 429,
      rateLimited: true,
      retryAfterSeconds: 120,
      rateLimit: { status: 429, retryAfter: "120" },
    });

    expect(exc.name).toBe("SearchProviderException");
    expect(exc.provider).toBe("brave");
    expect(exc.status).toBe(429);
    expect(exc.rateLimited).toBe(true);
    expect(exc.retryAfterSeconds).toBe(120);
    expect(exc.rateLimit).toEqual({ status: 429, retryAfter: "120" });
  });
});

describe("search-providers normalizeDistillationSearchQuery", () => {
  it("normalizes queries using NFKC format", () => {
    const input = "Ｍｅｍｏｒｙ　Ｒｏｕｔｅｒ　　Ｔｅｓｔ";
    const expected = "memory router test";
    expect(normalizeDistillationSearchQuery(input)).toBe(expected);
  });

  it("trims external whitespace and compacts inner spaces", () => {
    expect(normalizeDistillationSearchQuery("   multiple     spaces   ")).toBe("multiple spaces");
    expect(normalizeDistillationSearchQuery("\tnew\nline\t")).toBe("new line");
  });

  it("converts all characters to lowercase", () => {
    expect(normalizeDistillationSearchQuery("TypeScript AND Vitest")).toBe("typescript and vitest");
  });

  it("returns empty string if query is just empty or whitespace", () => {
    expect(normalizeDistillationSearchQuery("   ")).toBe("");
    expect(normalizeDistillationSearchQuery("")).toBe("");
  });
});

describe("searchWeb integration logic", () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  let originalSearchProviders: any;
  let originalMaxAttempts: any;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    originalSearchProviders = [...groupedConfig.distillationTools.searchProviders];
    originalMaxAttempts = groupedConfig.distillationTools.searchMaxProviderAttempts;
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    groupedConfig.distillationTools.searchProviders = originalSearchProviders;
    groupedConfig.distillationTools.searchMaxProviderAttempts = originalMaxAttempts;
  });

  it("throws error for empty or non-string query", async () => {
    await expect(searchWeb("")).rejects.toThrow("query must be a non-empty string");
    await expect(searchWeb("   ")).rejects.toThrow("query must be a non-empty string");
    await expect(searchWeb(null as any)).rejects.toThrow("query must be a non-empty string");
  });

  it("returns cached result if cache hit occurs", async () => {
    const mockCached = {
      ok: 1,
      excerpt: "cached excerpt content",
      fetchedAt: new Date(),
      metadata: { query: "test query" },
    };
    vi.mocked(findDistillationEvidenceCache).mockResolvedValueOnce(mockCached as any);

    const result = await searchWeb("test query");

    expect(findDistillationEvidenceCache).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.content).toBe("cached excerpt content");
    expect(result.metadata?.cacheHit).toBe(true);
  });

  it("calls Brave search and returns results when API key is set and fetch succeeds", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "mocked-brave-key";
    groupedConfig.distillationTools.searchProviders = ["brave"];
    vi.mocked(findDistillationEvidenceCache).mockResolvedValueOnce(null);

    const mockResponsePayload = {
      web: {
        results: [
          {
            title: "Test Page Title",
            url: "https://example.com/test",
            description: "This is a test description from Brave.",
          },
        ],
      },
    };

    const mockHeaders = new Headers({
      "x-ratelimit-limit": "1000",
      "x-ratelimit-remaining": "999",
      "x-ratelimit-reset": "1710000000",
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: mockHeaders,
      json: async () => mockResponsePayload,
    } as Response) as any;

    const result = await searchWeb("my search query");

    expect(result.ok).toBe(true);
    expect(result.metadata?.provider).toBe("brave");
    expect(result.metadata?.resultCount).toBe(1);
    expect(result.content).toContain("Test Page Title");
    expect(result.content).toContain("https://example.com/test");

    expect(upsertDistillationEvidenceCache).toHaveBeenCalled();
  });

  it("falls back to DuckDuckGo if Brave search rate-limits (HTTP 429)", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "mocked-brave-key";
    groupedConfig.distillationTools.searchProviders = ["brave", "duckduckgo"];
    groupedConfig.distillationTools.searchMaxProviderAttempts = 2;
    vi.mocked(findDistillationEvidenceCache).mockResolvedValueOnce(null);

    const mockBraveHeaders = new Headers({
      "retry-after": "60",
    });

    const mockDdgHtml = `
      <div class="result">
        <a class="result__a" href="https://duckduckgo.com/y.js?uddg=https%3A%2F%2Fexample.com%2Fddg">DuckDuckGo Title</a>
        <div class="result__snippet">DuckDuckGo Snippet Text</div>
      </div>
    `;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: mockBraveHeaders,
        json: async () => ({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => mockDdgHtml,
      } as Response) as any;

    const result = await searchWeb("fallback query");

    expect(result.ok).toBe(true);
    expect(result.metadata?.provider).toBe("duckduckgo");
    expect(result.metadata?.resultCount).toBe(1);
    expect(result.content).toContain("DuckDuckGo Title");
    expect(result.content).toContain("https://example.com/ddg");
  });

  it("calls Exa search successfully when key is set and Brave is not configured", async () => {
    process.env.BRAVE_SEARCH_API_KEY = undefined;
    process.env.EXA_API_KEY = "mocked-exa-key";
    groupedConfig.distillationTools.searchProviders = ["exa"];
    vi.mocked(findDistillationEvidenceCache).mockResolvedValueOnce(null);

    const mockExaPayload = {
      results: [
        {
          title: "Exa Title",
          url: "https://example.com/exa",
          snippet: "Exa snippet content",
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => mockExaPayload,
    } as Response) as any;

    const result = await searchWeb("exa query");

    expect(result.ok).toBe(true);
    expect(result.metadata?.provider).toBe("exa");
    expect(result.metadata?.resultCount).toBe(1);
    expect(result.content).toContain("Exa Title");
  });

  it("throws aggregate errors when all attempted providers fail", async () => {
    process.env.BRAVE_SEARCH_API_KEY = undefined;
    process.env.EXA_API_KEY = undefined;
    process.env.MEMORY_ROUTER_EXA_API_KEY = undefined;
    groupedConfig.distillationTools.searchProviders = ["brave", "exa", "duckduckgo"];
    groupedConfig.distillationTools.searchMaxProviderAttempts = 3;
    vi.mocked(findDistillationEvidenceCache).mockResolvedValueOnce(null);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => "Internal Server Error",
    } as Response) as any;

    await expect(searchWeb("fail query")).rejects.toThrow(
      "search providers failed: brave: Brave API key is not configured; exa: Exa API key is not configured; duckduckgo: DuckDuckGo search HTTP 500",
    );
  });
});
