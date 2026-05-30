import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = {
  searchWeb: vi.fn(),
  fetchContent: vi.fn(),
  recordAuditLogSafe: vi.fn(),
};

vi.mock("../src/modules/distillation/search-providers.js", () => ({
  normalizeDistillationSearchQuery: (value: unknown) => String(value ?? ""),
  searchWeb: mocks.searchWeb,
}));

vi.mock("../src/modules/distillation/url-fetcher.js", () => ({
  fetchContent: mocks.fetchContent,
  validateFetchContentUrl: () => true,
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    distillationWebSearch: "DISTILLATION_WEB_SEARCH",
    distillationFetchContent: "DISTILLATION_FETCH_CONTENT",
    distillationMcpEvidence: "DISTILLATION_MCP_EVIDENCE",
  },
  recordAuditLogSafe: mocks.recordAuditLogSafe,
}));

describe("distillation tools selection flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves fetch_content numeric selection from cached search results", async () => {
    const { executeDistillationToolCall } = await import(
      "../src/modules/distillation/distillation-tools.service.js"
    );

    mocks.searchWeb.mockResolvedValue({
      callId: "",
      name: "search_web",
      ok: true,
      content: JSON.stringify({
        query: "json repair",
        results: [
          { title: "A", url: "https://example.com/a" },
          { title: "B", url: "https://example.com/b" },
          { title: "C", url: "https://example.com/c" },
        ],
      }),
      metadata: { query: "json repair", resultCount: 3 },
    });
    mocks.fetchContent.mockImplementation(async (url: unknown) => ({
      callId: "",
      name: "fetch_content",
      ok: true,
      content: `fetched:${String(url)}`,
      metadata: { finalUrl: String(url) },
    }));

    await executeDistillationToolCall(
      {
        id: "search-1",
        type: "function",
        function: { name: "search_web", arguments: '{"query":"json repair"}' },
      },
      { domain: "coverEvidence", id: "row-1", stage: "web" },
    );

    const result = await executeDistillationToolCall(
      {
        id: "fetch-1",
        type: "function",
        function: { name: "fetch_content", arguments: '{"url":"2,3"}' },
      },
      { domain: "coverEvidence", id: "row-1", stage: "web" },
    );

    expect(result.ok).toBe(true);
    expect(mocks.fetchContent).toHaveBeenCalledTimes(2);
    expect(mocks.fetchContent).toHaveBeenNthCalledWith(
      1,
      "https://example.com/b",
      expect.any(Object),
    );
    expect(mocks.fetchContent).toHaveBeenNthCalledWith(
      2,
      "https://example.com/c",
      expect.any(Object),
    );
    expect(result.content).toContain("https://example.com/b");
    expect(result.content).toContain("https://example.com/c");
  });
});
