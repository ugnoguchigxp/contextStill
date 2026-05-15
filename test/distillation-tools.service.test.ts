import { describe, expect, test, vi, beforeEach } from "vitest";
import { executeDistillationToolCall } from "../src/modules/distillation/distillation-tools.service.js";

describe("Distillation Tools Service", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("search_web", () => {
    test("uses Brave search when API key is present", async () => {
      process.env.BRAVE_SEARCH_API_KEY = "test-key";
      const mockResponse = {
        ok: true,
        json: async () => ({
          web: {
            results: [{ title: "Brave Result", url: "https://brave.com", description: "Desc" }],
          },
        }),
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const result = await executeDistillationToolCall({
        id: "call1",
        function: { name: "search_web", arguments: JSON.stringify({ query: "vitest" }) },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("Brave Result");
      expect(fetch).toHaveBeenCalledWith(
        expect.objectContaining({ href: expect.stringContaining("brave.com") }),
        expect.anything(),
      );
    });

    test("falls back to DuckDuckGo when Brave fails", async () => {
      process.env.BRAVE_SEARCH_API_KEY = "test-key";
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error("Brave Down")) // Brave call fails
        .mockResolvedValueOnce({
          ok: true,
          text: async () =>
            '<div class="result"><a class="result__a" href="https://ddg.com">DDG Result</a></div></div>',
        } as any); // DDG call succeeds

      const result = await executeDistillationToolCall({
        id: "call1",
        function: { name: "search_web", arguments: JSON.stringify({ query: "vitest" }) },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("DDG Result");
    });
  });

  describe("fetch_content", () => {
    test("fetches and sanitizes HTML content", async () => {
      const mockResponse = {
        ok: true,
        headers: new Map([["content-type", "text/html"]]),
        text: async () =>
          "<html><body><h1>Title</h1><p>Content</p><script>alert(1)</script></body></html>",
        url: "https://example.com",
      };
      vi.mocked(fetch).mockResolvedValue(mockResponse as any);

      const result = await executeDistillationToolCall({
        id: "call1",
        function: {
          name: "fetch_content",
          arguments: JSON.stringify({ url: "https://example.com" }),
        },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("TitleContent");
      expect(result.content).not.toContain("alert");
    });

    test("falls back to Jina reader when direct fetch fails", async () => {
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error("Access Denied")) // Direct fetch fails
        .mockResolvedValueOnce({
          ok: true,
          headers: new Map(),
          text: async () => "Jina Result",
          url: "https://r.jina.ai/...",
        } as any); // Jina fetch succeeds

      const result = await executeDistillationToolCall({
        id: "call1",
        function: {
          name: "fetch_content",
          arguments: JSON.stringify({ url: "https://blocked.com" }),
        },
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain("Jina Result");
    });

    test("blocks localhost URLs", async () => {
      const result = await executeDistillationToolCall({
        id: "call1",
        function: {
          name: "fetch_content",
          arguments: JSON.stringify({ url: "http://localhost:3000/internal" }),
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("fetch_content blocked");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("blocks private IPv4 URLs", async () => {
      const result = await executeDistillationToolCall({
        id: "call1",
        function: {
          name: "fetch_content",
          arguments: JSON.stringify({ url: "http://192.168.1.20/secret" }),
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("private or loopback IPv4 is blocked");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("blocks redirects to private endpoints", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Map([["location", "http://127.0.0.1:8080/hidden"]]),
      } as any);

      const result = await executeDistillationToolCall({
        id: "call1",
        function: {
          name: "fetch_content",
          arguments: JSON.stringify({ url: "https://example.com/redirect" }),
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("redirect target");
    });
  });

  describe("error handling", () => {
    test("handles unknown tools", async () => {
      const result = await executeDistillationToolCall({
        id: "call1",
        function: { name: "invalid_tool", arguments: "{}" },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("unknown distillation tool");
    });

    test("handles invalid URL", async () => {
      const result = await executeDistillationToolCall({
        id: "call1",
        function: { name: "fetch_content", arguments: JSON.stringify({ url: "not-a-url" }) },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });
  });
});
