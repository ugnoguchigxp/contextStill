import fs from "fs/promises";
import { deriveRetrievalModeFromChangeTypes } from "../../shared/schemas/compile.schema.js";
import {
  contextEvalCaseSchema,
  type ContextEvalCase,
  type ContextEvalCaseReport,
  type ContextEvalCaseResult,
} from "../../shared/schemas/context-eval-case.schema.js";
import { retrieveKnowledge } from "../knowledge/knowledge.service.js";

/**
 * Loads and validates evaluation cases from a JSONL file.
 * Ignores empty lines and lines starting with '#'.
 */
export async function loadContextEvalCases(filePath: string): Promise<ContextEvalCase[]> {
  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const cases: ContextEvalCase[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch (err: any) {
      throw new Error(`Invalid JSON on line ${lineNum}: ${err.message}`);
    }

    const result = contextEvalCaseSchema.safeParse(parsedJson);
    if (!result.success) {
      const errorMsg = result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      throw new Error(`Validation failed on line ${lineNum}: ${errorMsg}`);
    }

    cases.push(result.data);
  }

  return cases;
}

export type BuildContextEvalCaseReportInput = {
  casesPath: string;
  currentLimit: number;
};

/**
 * Performs dry-run retrieval for each test case and builds an aggregated report.
 */
export async function buildContextEvalCaseReport(
  input: BuildContextEvalCaseReportInput,
): Promise<ContextEvalCaseReport> {
  const generatedAt = new Date().toISOString();
  const cases = await loadContextEvalCases(input.casesPath);

  if (cases.length === 0) {
    return {
      generatedAt,
      source: {
        mode: "cases",
        path: input.casesPath,
        currentLimit: input.currentLimit,
        readOnly: true,
      },
      summary: {
        status: "no_data",
        caseCount: 0,
        passedCount: 0,
        failedCount: 0,
        passRate: 0,
        reason: "No evaluation cases to run.",
      },
      metrics: {
        expectedTotalCount: 0,
        expectedHitCount: 0,
        missingExpectedCount: 0,
        forbiddenTotalCount: 0,
        forbiddenHitCount: 0,
        retrievedTotalCount: 0,
        expectedRecall: null,
        strictPrecision: null,
        strictF1: null,
        noContentCaseCount: 0,
        degradedCaseCount: 0,
      },
      cases: [],
    };
  }

  const results: ContextEvalCaseResult[] = [];

  for (let index = 0; index < cases.length; index += 1) {
    const c = cases[index];
    const id = c.id || `case-${index + 1}`;
    const compileInput = {
      goal: c.goal,
      changeTypes: c.changeTypes,
      technologies: c.technologies,
      domains: c.domains,
    };
    const retrievalMode = deriveRetrievalModeFromChangeTypes(c.changeTypes);

    const result = await retrieveKnowledge(compileInput, {
      retrievalMode,
      limit: input.currentLimit,
    });

    const retrievedKnowledgeIds = result.items.map((item) => item.id).slice(0, input.currentLimit);
    const expectedKnowledgeIds = c.expectedKnowledgeIds || [];
    const forbiddenKnowledgeIds = c.forbiddenKnowledgeIds || [];

    const expectedHitIds = expectedKnowledgeIds.filter((expectedId) =>
      retrievedKnowledgeIds.includes(expectedId),
    );
    const missingExpectedIds = expectedKnowledgeIds.filter(
      (expectedId) => !retrievedKnowledgeIds.includes(expectedId),
    );
    const forbiddenHitIds = forbiddenKnowledgeIds.filter((forbiddenId) =>
      retrievedKnowledgeIds.includes(forbiddenId),
    );

    const status = missingExpectedIds.length === 0 && forbiddenHitIds.length === 0 ? "passed" : "failed";

    results.push({
      id,
      goal: c.goal,
      status,
      retrievedKnowledgeIds,
      expectedKnowledgeIds,
      expectedHitIds,
      missingExpectedIds,
      forbiddenKnowledgeIds,
      forbiddenHitIds,
      degradedReasons: result.degradedReasons || [],
    });
  }

  const caseCount = results.length;
  const passedCount = results.filter((r) => r.status === "passed").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  const passRate = caseCount > 0 ? passedCount / caseCount : 0;

  const expectedTotalCount = results.reduce((sum, r) => sum + r.expectedKnowledgeIds.length, 0);
  const expectedHitCount = results.reduce((sum, r) => sum + r.expectedHitIds.length, 0);
  const missingExpectedCount = results.reduce((sum, r) => sum + r.missingExpectedIds.length, 0);
  const forbiddenTotalCount = results.reduce((sum, r) => sum + r.forbiddenKnowledgeIds.length, 0);
  const forbiddenHitCount = results.reduce((sum, r) => sum + r.forbiddenHitIds.length, 0);
  const retrievedTotalCount = results.reduce((sum, r) => sum + r.retrievedKnowledgeIds.length, 0);

  const expectedRecall = expectedTotalCount > 0 ? expectedHitCount / expectedTotalCount : null;
  const strictPrecision = retrievedTotalCount > 0 ? expectedHitCount / retrievedTotalCount : null;
  const strictF1 =
    strictPrecision !== null && expectedRecall !== null && strictPrecision + expectedRecall > 0
      ? (2 * strictPrecision * expectedRecall) / (strictPrecision + expectedRecall)
      : null;

  const noContentCaseCount = results.filter((r) =>
    r.degradedReasons.some((reason) => reason.toUpperCase().includes("NO_CONTENT")),
  ).length;
  const degradedCaseCount = results.filter((r) => r.degradedReasons.length > 0).length;

  const summaryStatus = failedCount > 0 ? "failed" : "passed";
  const reason =
    summaryStatus === "passed"
      ? "All evaluation cases passed."
      : `${failedCount} of ${caseCount} cases failed expected or forbidden assertions.`;

  return {
    generatedAt,
    source: {
      mode: "cases",
      path: input.casesPath,
      currentLimit: input.currentLimit,
      readOnly: true,
    },
    summary: {
      status: summaryStatus,
      caseCount,
      passedCount,
      failedCount,
      passRate,
      reason,
    },
    metrics: {
      expectedTotalCount,
      expectedHitCount,
      missingExpectedCount,
      forbiddenTotalCount,
      forbiddenHitCount,
      retrievedTotalCount,
      expectedRecall,
      strictPrecision,
      strictF1,
      noContentCaseCount,
      degradedCaseCount,
    },
    cases: results,
  };
}
