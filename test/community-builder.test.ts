import { describe, expect, test } from "vitest";
import {
  buildCommunityAssignments,
  rawKnowledgeId,
} from "../src/modules/graph/community-builder.js";

describe("community-builder", () => {
  describe("rawKnowledgeId", () => {
    test("removes knowledge: prefix if exists", () => {
      expect(rawKnowledgeId("knowledge:123")).toBe("123");
      expect(rawKnowledgeId("123")).toBe("123");
    });
  });

  describe("buildCommunityAssignments", () => {
    test("returns empty community build result if nodes are empty", () => {
      const result = buildCommunityAssignments({
        nodes: [],
        edges: [],
        minEdgeWeight: 1,
      });

      expect(result.communityCount).toBe(0);
      expect(result.largestCommunitySize).toBe(0);
      expect(result.orphanNodeCount).toBe(0);
      expect(result.components).toEqual([]);
      expect(result.assignments.size).toBe(0);
    });

    test("builds assignments and components for disconnected single nodes (orphans)", () => {
      const result = buildCommunityAssignments({
        nodes: [
          { id: "knowledge:nodeA", weight: 5 },
          { id: "knowledge:nodeB", weight: 3 },
        ],
        edges: [],
        minEdgeWeight: 1,
      });

      expect(result.communityCount).toBe(2);
      expect(result.largestCommunitySize).toBe(1);
      expect(result.orphanNodeCount).toBe(2);
      // components should be sorted by size first (same, 1), then max weight (nodeA=5 > nodeB=3), so nodeA is first
      expect(result.components[0].members).toEqual(["knowledge:nodeA"]);
      expect(result.components[1].members).toEqual(["knowledge:nodeB"]);

      const assignA = result.assignments.get("knowledge:nodeA");
      expect(assignA?.communityRank).toBe(1);
      expect(assignA?.communitySize).toBe(1);

      const assignB = result.assignments.get("knowledge:nodeB");
      expect(assignB?.communityRank).toBe(2);
    });

    test("unites nodes connected by edges exceeding minEdgeWeight", () => {
      const result = buildCommunityAssignments({
        nodes: [
          { id: "knowledge:nodeA", weight: 1 },
          { id: "knowledge:nodeB", weight: 1 },
          { id: "knowledge:nodeC", weight: 1 },
        ],
        edges: [
          { source: "knowledge:nodeA", target: "knowledge:nodeB", weight: 5 },
          { source: "knowledge:nodeB", target: "knowledge:nodeC", weight: 2 },
        ],
        minEdgeWeight: 3, // edge A-B is included, B-C is ignored
      });

      expect(result.communityCount).toBe(2); // community1: [A, B], community2: [C]
      expect(result.largestCommunitySize).toBe(2);
      expect(result.orphanNodeCount).toBe(1); // C is orphan

      const comp1 = result.components.find((c) => c.communityRank === 1);
      expect(comp1?.members).toEqual(["knowledge:nodeA", "knowledge:nodeB"]);
    });

    test("ignores edges with unknown source or target", () => {
      const result = buildCommunityAssignments({
        nodes: [
          { id: "knowledge:nodeA", weight: 1 },
          { id: "knowledge:nodeB", weight: 1 },
        ],
        edges: [{ source: "knowledge:nodeA", target: "knowledge:unknown", weight: 5 }],
        minEdgeWeight: 1,
      });

      expect(result.communityCount).toBe(2); // no union happened
      expect(result.orphanNodeCount).toBe(2);
    });

    test("correctly sorts components based on size, max weight, and node ID alphabetical order", () => {
      // Components to form:
      // comp1: [A, B] (size 2, max weight 10)
      // comp2: [C, D] (size 2, max weight 20)
      // comp3: [E] (size 1, max weight 5)
      // Sorting priority: size desc, then max weight desc, then first member ID asc
      const result = buildCommunityAssignments({
        nodes: [
          { id: "knowledge:A", weight: 10 },
          { id: "knowledge:B", weight: 5 },
          { id: "knowledge:C", weight: 20 },
          { id: "knowledge:D", weight: 15 },
          { id: "knowledge:E", weight: 5 },
        ],
        edges: [
          { source: "knowledge:A", target: "knowledge:B", weight: 5 },
          { source: "knowledge:C", target: "knowledge:D", weight: 5 },
        ],
        minEdgeWeight: 1,
      });

      expect(result.components[0].members).toEqual(["knowledge:C", "knowledge:D"]); // size 2, max weight 20
      expect(result.components[1].members).toEqual(["knowledge:A", "knowledge:B"]); // size 2, max weight 10
      expect(result.components[2].members).toEqual(["knowledge:E"]); // size 1
    });
  });
});
