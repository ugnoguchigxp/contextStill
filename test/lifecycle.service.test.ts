import { describe, expect, test } from "vitest";
import {
  canTransitionKnowledgeStatus,
  resolveKnowledgeSearchStatuses,
} from "../src/modules/lifecycle/lifecycle.service.js";

describe("Lifecycle Service", () => {
  test("canTransitionKnowledgeStatus validates allowed transitions", () => {
    expect(canTransitionKnowledgeStatus("draft", "active")).toBe(true);
    expect(canTransitionKnowledgeStatus("draft", "deprecated")).toBe(true);
    expect(canTransitionKnowledgeStatus("active", "deprecated")).toBe(true);
    expect(canTransitionKnowledgeStatus("deprecated", "active")).toBe(true);

    expect(canTransitionKnowledgeStatus("active", "draft")).toBe(false);
    expect(canTransitionKnowledgeStatus("deprecated", "deprecated")).toBe(false);
  });

  test("resolveKnowledgeSearchStatuses handles learning_context", () => {
    expect(
      resolveKnowledgeSearchStatuses({ retrievalMode: "learning_context", includeDraft: false }),
    ).toEqual(["active", "draft"]);
  });

  test("resolveKnowledgeSearchStatuses respects includeDraft", () => {
    expect(
      resolveKnowledgeSearchStatuses({ retrievalMode: "review_context", includeDraft: true }),
    ).toEqual(["active", "draft"]);
    expect(
      resolveKnowledgeSearchStatuses({ retrievalMode: "review_context", includeDraft: false }),
    ).toEqual(["active"]);
  });
});
