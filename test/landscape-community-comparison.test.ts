import { describe, expect, test } from "vitest";
import { classifyLandscapeCommunityComparison } from "../src/modules/landscape/landscape-community-comparison.js";

describe("landscape community comparison", () => {
  test("classifies semantic reachable dead zones ahead of generic orphan/split labels", () => {
    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "dead_zone_reachability_risk",
        semanticKeyCount: 1,
        bestJaccardOverlap: 0.2,
        bestSemanticCommunitySize: 4,
        selectedNeighborCountWindow: 3,
      }),
    ).toBe("semantic_reachable_dead_zone");
  });

  test("classifies relation/semantic shape drift", () => {
    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "neutral",
        semanticKeyCount: 0,
        bestJaccardOverlap: 0,
        bestSemanticCommunitySize: 0,
        selectedNeighborCountWindow: 0,
      }),
    ).toBe("relation_orphan");

    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "neutral",
        semanticKeyCount: 2,
        bestJaccardOverlap: 0.6,
        bestSemanticCommunitySize: 2,
        selectedNeighborCountWindow: 0,
      }),
    ).toBe("semantic_split");

    expect(
      classifyLandscapeCommunityComparison({
        relationClassification: "neutral",
        semanticKeyCount: 1,
        bestJaccardOverlap: 0.5,
        bestSemanticCommunitySize: 6,
        selectedNeighborCountWindow: 0,
      }),
    ).toBe("semantic_merge");
  });
});
