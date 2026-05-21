import { describe, expect, test } from "vitest";
import { fetchKnowledgeItems } from "./modules/admin/repositories/admin.repository";

describe("web smoke", () => {
  test("basic arithmetic sanity", () => {
    expect(1 + 1).toBe(2);
  });

  test("fetchKnowledgeItems sends server-side sort parameters", async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return {
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, limit: 50, totalPages: 0 }),
      } as Response;
    }) as typeof fetch;

    try {
      await fetchKnowledgeItems({
        page: 1,
        limit: 50,
        sortBy: "title",
        sortDir: "asc",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls[0]).toBe("/api/knowledge?limit=50&page=1&sortBy=title&sortDir=asc");
  });
});
