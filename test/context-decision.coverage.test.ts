import { describe, expect, test } from "vitest";
import { buildDecisionCoverageQueries } from "../src/modules/context-decision/context-decision.coverage.js";

describe("context decision coverage queries", () => {
  test("uses decision fields and retrieval hints", () => {
    const queries = buildDecisionCoverageQueries({
      decisionPoint: "Choose whether to continue UI implementation or ask the user.",
      retrievalHints: {
        technologies: ["typescript", "react"],
        changeTypes: ["frontend"],
        domains: ["context-decision"],
      },
      metadata: {},
    });

    const combined = queries.map((query) => query.query).join("\n");
    expect(combined).toContain("typescript react");
    expect(combined).toContain("frontend");
    expect(combined).toContain("context-decision");
    expect(combined).toContain("Choose whether to continue UI implementation");
  });

  test("generates all knowledge assessment query roles without extra user input", () => {
    const queries = buildDecisionCoverageQueries({
      decisionPoint: "Decide whether to implement the planned service change.",
      retrievalHints: { technologies: [], changeTypes: [], domains: [] },
      metadata: {},
    });

    expect(queries.map((query) => query.queryRole)).toEqual([
      "support",
      "counter_evidence",
      "risk",
      "user_preference",
      "verification",
      "alternative",
    ]);
    expect(queries.every((query) => query.normalizedKeywords.length > 0)).toBe(true);
    expect(queries.every((query) => query.retrievalInput.includes(query.query))).toBe(true);
  });
});
