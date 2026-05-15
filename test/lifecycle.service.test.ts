import { describe, expect, test } from "vitest";
import {
  canTransitionKnowledgeStatus,
  resolveKnowledgeSearchStatuses,
} from "../src/modules/lifecycle/lifecycle.service.js";

describe("Lifecycle Service", () => {
  describe("canTransitionKnowledgeStatus", () => {
    test("draft can transition to active or deprecated", () => {
      expect(canTransitionKnowledgeStatus("draft", "active")).toBe(true);
      expect(canTransitionKnowledgeStatus("draft", "deprecated")).toBe(true);
    });

    test("active can transition to deprecated", () => {
      expect(canTransitionKnowledgeStatus("active", "deprecated")).toBe(true);
      expect(canTransitionKnowledgeStatus("active", "draft")).toBe(false);
    });

    test("deprecated can transition to active (restore)", () => {
      expect(canTransitionKnowledgeStatus("deprecated", "active")).toBe(true);
      expect(canTransitionKnowledgeStatus("deprecated", "draft")).toBe(false);
    });
  });

  describe("resolveKnowledgeSearchStatuses", () => {
    test("returns active and draft for learning_context", () => {
      expect(
        resolveKnowledgeSearchStatuses({ retrievalMode: "learning_context", includeDraft: false }),
      ).toEqual(["active", "draft"]);
    });

    test("returns active and draft when includeDraft is true", () => {
      expect(
        resolveKnowledgeSearchStatuses({ retrievalMode: "task_context", includeDraft: true }),
      ).toEqual(["active", "draft"]);
    });

    test("returns only active by default", () => {
      expect(
        resolveKnowledgeSearchStatuses({ retrievalMode: "task_context", includeDraft: false }),
      ).toEqual(["active"]);
    });
  });
});
