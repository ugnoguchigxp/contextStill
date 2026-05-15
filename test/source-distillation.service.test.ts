import { describe, expect, test, vi, beforeEach } from "vitest";
import { distillSources } from "../src/modules/sources/distillation.service.js";
import {
  listSourceFragmentsForDistillation,
  upsertSourceDistillationRun,
  recordSourceDistillationState,
} from "../src/modules/sources/distillation.repository.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import { callLocalLlmCompletionForDistillation } from "../src/modules/distillation/distillation-runtime.service.js";

vi.mock("../src/modules/sources/distillation.repository.js");
vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/distillation/distillation-runtime.service.js");

describe("Source Distillation Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listSourceFragmentsForDistillation).mockResolvedValue([
      {
        id: "f1",
        sourceId: "s1",
        sourceKind: "wiki",
        sourceUri: "wiki/test",
        sourceContentHash: "hash1",
        content: "Fragment content",
        locator: "L1",
        sourceMetadata: {},
      } as any,
    ]);
    vi.mocked(upsertSourceDistillationRun).mockResolvedValue({ id: "run1" } as any);
  });

  test("runs distillation in dry run mode", async () => {
    vi.mocked(callLocalLlmCompletionForDistillation).mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Rule 1",
            body: "Body 1",
            confidence: 90,
            importance: 90,
            score: 0.9,
            sourceRefs: ["ref1"],
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const summary = await distillSources({ apply: false });

    expect(summary.processed).toBe(1);
    expect(summary.knowledgeCount).toBe(0);
    expect(summary.results[0].status).toBe("dry_run");
  });

  test("applies distillation and inserts knowledge", async () => {
    vi.mocked(callLocalLlmCompletionForDistillation).mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Rule 1",
            body: "Body 1",
            confidence: 90,
            importance: 90,
            score: 0.9,
            sourceRefs: ["ref1"],
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });
    vi.mocked(embedOne).mockResolvedValue([0.1, 0.2]);
    vi.mocked(upsertKnowledgeFromSource).mockResolvedValue("k1");

    const summary = await distillSources({ apply: true });

    expect(summary.knowledgeCount).toBe(1);
    expect(summary.results[0].status).toBe("ok");
    expect(upsertKnowledgeFromSource).toHaveBeenCalled();
  });

  test("handles error during distillation", async () => {
    vi.mocked(callLocalLlmCompletionForDistillation).mockRejectedValue(new Error("LLM Down"));

    const summary = await distillSources({ apply: true });

    expect(summary.failed).toBe(1);
    expect(summary.results[0].status).toBe("failed");
    expect(summary.results[0].error).toBe("LLM Down");
  });
});
