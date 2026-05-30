import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { retrieveKnowledgeMock } = vi.hoisted(() => ({
  retrieveKnowledgeMock: vi.fn(),
}));

vi.mock("../src/modules/knowledge/knowledge.service.js", () => ({
  retrieveKnowledge: retrieveKnowledgeMock,
}));

import {
  buildContextEvalCaseReport,
  loadContextEvalCases,
} from "../src/modules/landscape/context-eval-case.service.js";

describe("context eval case service", () => {
  const tempFilePath = path.join(__dirname, "temp-eval-cases.jsonl");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await fs.unlink(tempFilePath);
    } catch {}
  });

  test("loadContextEvalCases loads and validates cases from JSONL, ignoring comments and empty lines", async () => {
    const jsonlContent = `
# Comment line
{"id":"case-1","goal":"Fix basic bug","changeTypes":["debug"],"technologies":["TypeScript"],"domains":["test"],"expectedKnowledgeIds":["k-1"],"forbiddenKnowledgeIds":["k-2"]}

{"id":"case-2","goal":"Implement a feature","expectedKnowledgeIds":[],"forbiddenKnowledgeIds":[]}
    `;
    await fs.writeFile(tempFilePath, jsonlContent, "utf-8");

    const cases = await loadContextEvalCases(tempFilePath);
    expect(cases).toHaveLength(2);
    expect(cases[0].id).toBe("case-1");
    expect(cases[0].goal).toBe("Fix basic bug");
    expect(cases[0].expectedKnowledgeIds).toEqual(["k-1"]);
    expect(cases[0].forbiddenKnowledgeIds).toEqual(["k-2"]);
    expect(cases[1].id).toBe("case-2");
    expect(cases[1].goal).toBe("Implement a feature");
  });

  test("loadContextEvalCases throws an error on invalid JSON", async () => {
    const jsonlContent = `{"id":"case-1","goal":"Fix basic bug",invalid}`;
    await fs.writeFile(tempFilePath, jsonlContent, "utf-8");

    await expect(loadContextEvalCases(tempFilePath)).rejects.toThrow("Invalid JSON on line 1");
  });

  test("loadContextEvalCases throws an error on invalid schema (missing goal)", async () => {
    const jsonlContent = `{"id":"case-1","changeTypes":["debug"]}`;
    await fs.writeFile(tempFilePath, jsonlContent, "utf-8");

    await expect(loadContextEvalCases(tempFilePath)).rejects.toThrow(
      "Validation failed on line 1: goal",
    );
  });

  test("loadContextEvalCases throws an error on expected-forbidden overlap", async () => {
    const jsonlContent = `{"id":"case-1","goal":"Fix basic bug","expectedKnowledgeIds":["k-1"],"forbiddenKnowledgeIds":["k-1"]}`;
    await fs.writeFile(tempFilePath, jsonlContent, "utf-8");

    await expect(loadContextEvalCases(tempFilePath)).rejects.toThrow(
      "Validation failed on line 1: forbiddenKnowledgeIds: expectedKnowledgeIds and forbiddenKnowledgeIds must not overlap",
    );
  });

  test("buildContextEvalCaseReport returns no_data for empty cases file", async () => {
    const jsonlContent = "";
    await fs.writeFile(tempFilePath, jsonlContent, "utf-8");

    const report = await buildContextEvalCaseReport({
      casesPath: tempFilePath,
      currentLimit: 5,
    });

    expect(report.summary.status).toBe("no_data");
    expect(report.summary.caseCount).toBe(0);
    expect(report.cases).toHaveLength(0);
  });

  test("buildContextEvalCaseReport executes cases and aggregates metrics correctly", async () => {
    const jsonlContent = `
{"id":"case-success","goal":"Succeed","expectedKnowledgeIds":["k-expect-hit"],"forbiddenKnowledgeIds":["k-forbid-miss"]}
{"id":"case-fail-missing","goal":"Fail missing","expectedKnowledgeIds":["k-expect-miss"]}
{"id":"case-fail-forbidden","goal":"Fail forbidden","expectedKnowledgeIds":[],"forbiddenKnowledgeIds":["k-forbid-hit"]}
    `;
    await fs.writeFile(tempFilePath, jsonlContent, "utf-8");

    retrieveKnowledgeMock.mockImplementation(async (input) => {
      if (input.goal === "Succeed") {
        return {
          items: [{ id: "k-expect-hit" }],
          degradedReasons: [],
        };
      }
      if (input.goal === "Fail missing") {
        return {
          items: [{ id: "k-other" }],
          degradedReasons: ["SOME_DEGRADED_REASON"],
        };
      }
      if (input.goal === "Fail forbidden") {
        return {
          items: [{ id: "k-forbid-hit" }],
          degradedReasons: ["NO_CONTENT_FOUND"],
        };
      }
      return { items: [], degradedReasons: [] };
    });

    const report = await buildContextEvalCaseReport({
      casesPath: tempFilePath,
      currentLimit: 5,
    });

    expect(report.summary.status).toBe("failed");
    expect(report.summary.caseCount).toBe(3);
    expect(report.summary.passedCount).toBe(1);
    expect(report.summary.failedCount).toBe(2);
    expect(report.summary.passRate).toBe(1 / 3);

    // Verify Case 1 (Success)
    const cSuccess = report.cases.find((c) => c.id === "case-success");
    expect(cSuccess?.status).toBe("passed");
    expect(cSuccess?.expectedHitIds).toEqual(["k-expect-hit"]);
    expect(cSuccess?.missingExpectedIds).toEqual([]);
    expect(cSuccess?.forbiddenHitIds).toEqual([]);

    // Verify Case 2 (Fail missing)
    const cFailMissing = report.cases.find((c) => c.id === "case-fail-missing");
    expect(cFailMissing?.status).toBe("failed");
    expect(cFailMissing?.expectedHitIds).toEqual([]);
    expect(cFailMissing?.missingExpectedIds).toEqual(["k-expect-miss"]);
    expect(cFailMissing?.forbiddenHitIds).toEqual([]);
    expect(cFailMissing?.degradedReasons).toEqual(["SOME_DEGRADED_REASON"]);

    // Verify Case 3 (Fail forbidden)
    const cFailForbidden = report.cases.find((c) => c.id === "case-fail-forbidden");
    expect(cFailForbidden?.status).toBe("failed");
    expect(cFailForbidden?.expectedHitIds).toEqual([]);
    expect(cFailForbidden?.missingExpectedIds).toEqual([]);
    expect(cFailForbidden?.forbiddenHitIds).toEqual(["k-forbid-hit"]);
    expect(cFailForbidden?.degradedReasons).toEqual(["NO_CONTENT_FOUND"]);

    // Aggregate metrics
    expect(report.metrics.expectedTotalCount).toBe(2); // case-success + case-fail-missing
    expect(report.metrics.expectedHitCount).toBe(1); // case-success
    expect(report.metrics.missingExpectedCount).toBe(1); // case-fail-missing
    expect(report.metrics.forbiddenTotalCount).toBe(2); // case-success + case-fail-forbidden
    expect(report.metrics.forbiddenHitCount).toBe(1); // case-fail-forbidden
    expect(report.metrics.retrievedTotalCount).toBe(3); // 1 + 1 + 1 retrieved

    expect(report.metrics.expectedRecall).toBe(0.5);
    expect(report.metrics.strictPrecision).toBe(1 / 3);
    expect(report.metrics.strictF1).toBe(0.4);
    expect(report.metrics.degradedCaseCount).toBe(2); // case-fail-missing + case-fail-forbidden
    expect(report.metrics.noContentCaseCount).toBe(1); // case-fail-forbidden
  });
});
