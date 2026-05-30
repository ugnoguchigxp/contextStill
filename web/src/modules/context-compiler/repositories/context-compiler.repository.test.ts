import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compilePack,
  fetchRecentRuns,
  fetchRunDetail,
  fetchRunRankingTrace,
  submitRunKnowledgeFeedback,
} from "./context-compiler.repository.js";

describe("context-compiler.repository", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("compilePack", () => {
    it("should compile pack successfully", async () => {
      const mockResponse = { pack: { runId: "123" }, markdown: "ok" };
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const result = await compilePack({ goal: "test goal" });
      expect(result).toEqual(mockResponse);
      expect(fetchSpy).toHaveBeenCalledWith("/api/context/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "test goal" }),
      });
    });

    it("should throw error when response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
      } as Response);

      await expect(compilePack({ goal: "test goal" })).rejects.toThrow("Compile failed: 500");
    });
  });

  describe("fetchRecentRuns", () => {
    it("should fetch recent runs successfully", async () => {
      const mockRuns = [{ id: "run-1" }];
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ runs: mockRuns }),
      } as Response);

      const result = await fetchRecentRuns(5);
      expect(result).toEqual(mockRuns);
      expect(fetchSpy).toHaveBeenCalledWith("/api/context/runs?limit=5");
    });

    it("should use default limit when limit is not specified", async () => {
      const mockRuns = [{ id: "run-1" }];
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ runs: mockRuns }),
      } as Response);

      const result = await fetchRecentRuns();
      expect(result).toEqual(mockRuns);
      expect(fetchSpy).toHaveBeenCalledWith("/api/context/runs?limit=20");
    });

    it("should throw error when response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      await expect(fetchRecentRuns()).rejects.toThrow("Fetch runs failed: 404");
    });
  });

  describe("fetchRunDetail", () => {
    it("should fetch run detail successfully", async () => {
      const mockDetail = { run: { id: "run-1" } };
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ detail: mockDetail }),
      } as Response);

      const result = await fetchRunDetail("run-1");
      expect(result).toEqual(mockDetail);
      expect(fetchSpy).toHaveBeenCalledWith("/api/context/runs/run-1");
    });

    it("should throw error when response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      await expect(fetchRunDetail("run-1")).rejects.toThrow("Fetch run detail failed: 404");
    });
  });

  describe("fetchRunRankingTrace", () => {
    it("should fetch run ranking trace successfully", async () => {
      const mockTrace = { run: { id: "run-1" }, items: [] };
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ trace: mockTrace }),
      } as Response);

      const result = await fetchRunRankingTrace("run-1");
      expect(result).toEqual(mockTrace);
      expect(fetchSpy).toHaveBeenCalledWith("/api/context/runs/run-1/ranking-trace");
    });

    it("should throw error when response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);

      await expect(fetchRunRankingTrace("run-1")).rejects.toThrow(
        "Fetch run ranking trace failed: 404",
      );
    });
  });

  describe("submitRunKnowledgeFeedback", () => {
    it("should submit knowledge feedback successfully", async () => {
      const mockResult = { savedCount: 1 };
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ feedback: mockResult }),
      } as Response);

      const items = [{ knowledgeId: "k-1", verdict: "used" as const }];
      const result = await submitRunKnowledgeFeedback("run-1", items);
      expect(result).toEqual(mockResult);
      expect(fetchSpy).toHaveBeenCalledWith("/api/context/runs/run-1/knowledge-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
    });

    it("should throw error when response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
      } as Response);

      await expect(submitRunKnowledgeFeedback("run-1", [])).rejects.toThrow(
        "Save knowledge feedback failed: 400",
      );
    });
  });
});
