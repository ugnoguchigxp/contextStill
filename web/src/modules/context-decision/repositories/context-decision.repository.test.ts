import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createContextDecision,
  fetchContextDecisionDetail,
  fetchContextDecisionRuns,
  submitContextDecisionHumanFeedback,
} from "./context-decision.repository.js";

const mockFetch = vi.fn();

describe("context-decision.repository", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("createContextDecision", () => {
    test("sends a POST request and returns the decision result", async () => {
      const mockResult = { decisionId: "dec-1", decision: "execute" };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockResult,
      });

      const input = { decisionPoint: "point-A", retrievalHints: { technologies: ["node"] } };
      const result = await createContextDecision(input);

      expect(mockFetch).toHaveBeenCalledWith("/api/context-decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(result).toEqual(mockResult);
    });

    test("throws an error if the response is not OK", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(createContextDecision({ decisionPoint: "point-A" })).rejects.toThrow(
        "Create context decision failed: 500",
      );
    });
  });

  describe("fetchContextDecisionRuns", () => {
    test("sends a GET request with limit and returns run summaries", async () => {
      const mockSummaries = [{ id: "dec-1", decisionPoint: "point-A" }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ decisions: mockSummaries }),
      });

      const result = await fetchContextDecisionRuns(15);

      expect(mockFetch).toHaveBeenCalledWith("/api/context-decisions?limit=15");
      expect(result).toEqual(mockSummaries);
    });

    test("uses default limit of 30 if none is provided", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ decisions: [] }),
      });

      await fetchContextDecisionRuns();

      expect(mockFetch).toHaveBeenCalledWith("/api/context-decisions?limit=30");
    });

    test("throws an error if the response is not OK", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
      });

      await expect(fetchContextDecisionRuns()).rejects.toThrow(
        "Fetch context decisions failed: 400",
      );
    });
  });

  describe("fetchContextDecisionDetail", () => {
    test("sends a GET request with encoded decision ID and returns detail", async () => {
      const mockDetail = { run: { id: "dec-1" }, evidence: [] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ detail: mockDetail }),
      });

      const result = await fetchContextDecisionDetail("dec/123");

      expect(mockFetch).toHaveBeenCalledWith("/api/context-decisions/dec%2F123");
      expect(result).toEqual(mockDetail);
    });

    test("throws an error if the response is not OK", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(fetchContextDecisionDetail("dec-1")).rejects.toThrow(
        "Fetch context decision detail failed: 404",
      );
    });
  });

  describe("submitContextDecisionHumanFeedback", () => {
    test("sends a POST request and returns updated detail", async () => {
      const mockDetail = { run: { id: "dec-1", humanFeedback: "good" } };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ detail: mockDetail }),
      });

      const result = await submitContextDecisionHumanFeedback("dec/123", "good");

      expect(mockFetch).toHaveBeenCalledWith("/api/context-decisions/dec%2F123/human-feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "good" }),
      });
      expect(result).toEqual(mockDetail);
    });

    test("throws an error if the response is not OK", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(submitContextDecisionHumanFeedback("dec-1", "bad")).rejects.toThrow(
        "Save context decision feedback failed: 500",
      );
    });
  });
});
