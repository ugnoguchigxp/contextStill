import { describe, expect, test } from "vitest";
import { applyLandscapeCompileIntervention } from "../src/modules/landscape/landscape-compile-intervention.service.js";

function item(id: string, vectorMatched = false, facetMatched = false) {
  return {
    id,
    title: id,
    content: id,
    score: 1,
    candidateEvidence: {
      textMatched: true,
      vectorMatched,
      facetMatched,
    },
  };
}

describe("landscape compile intervention", () => {
  test("keeps normal ranking when disabled", () => {
    const result = applyLandscapeCompileIntervention(
      [item("a"), item("b"), item("c", true, true)],
      { limit: 2, enabled: false },
    );

    expect(result.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result.diagnostics).toEqual({
      enabled: false,
      strategy: "observe_only",
      applied: false,
      reason: "Landscape compile intervention is disabled.",
    });
  });

  test("inserts one vector-and-facet matched diversity candidate when enabled", () => {
    const result = applyLandscapeCompileIntervention(
      [item("a"), item("b"), item("c", true, false), item("d", true, true)],
      { limit: 2, enabled: true },
    );

    expect(result.items.map((entry) => entry.id)).toEqual(["a", "d"]);
    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        enabled: true,
        strategy: "diversity_exploration",
        applied: true,
        candidateKnowledgeId: "d",
      }),
    );
  });
});
