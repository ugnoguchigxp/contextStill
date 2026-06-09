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
});
