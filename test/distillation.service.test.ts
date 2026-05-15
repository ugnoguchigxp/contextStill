import { describe, expect, test, vi, beforeEach } from "vitest";
import { distillVibeMemories } from "../src/modules/vibe-memory/distillation.service.js";
import {
  listVibeMemoriesForDistillation,
  listAgentDiffEntriesForVibeMemories,
  upsertVibeMemoryDistillationRun,
  recordVibeMemoryDistillationState,
} from "../src/modules/vibe-memory/distillation.repository.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import { callLocalLlmCompletionForDistillation } from "../src/modules/distillation/distillation-runtime.service.js";

vi.mock("../src/modules/vibe-memory/distillation.repository.js");
vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/distillation/distillation-runtime.service.js");

describe("Vibe Memory Distillation Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listVibeMemoriesForDistillation).mockResolvedValue([
      {
        id: "v1",
        sessionId: "s1",
        content: "Memory 1",
        memoryType: "manual",
        createdAt: new Date(),
        metadata: {},
        dedupeKey: null,
        embedding: null,
      },
    ]);
    vi.mocked(listAgentDiffEntriesForVibeMemories).mockResolvedValue([]);
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

    const summary = await distillVibeMemories({ apply: false });

    expect(summary.processed).toBe(1);
    expect(summary.knowledgeCount).toBe(0); // Dry run doesn't insert
    expect(summary.results[0].status).toBe("dry_run");
    expect(upsertKnowledgeFromSource).not.toHaveBeenCalled();
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

    const summary = await distillVibeMemories({ apply: true });

    expect(summary.knowledgeCount).toBe(1);
    expect(summary.results[0].status).toBe("ok");
    expect(upsertKnowledgeFromSource).toHaveBeenCalled();
    expect(recordVibeMemoryDistillationState).toHaveBeenCalled();
  });

  test("handles low score by skipping", async () => {
    vi.mocked(callLocalLlmCompletionForDistillation).mockResolvedValue({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Low Score",
            body: "...",
            confidence: 30,
            importance: 30,
            score: 0.1,
            sourceRefs: ["ref1"],
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const summary = await distillVibeMemories({ apply: true });

    expect(summary.skipped).toBe(1);
    expect(summary.knowledgeCount).toBe(0);
    expect(summary.results[0].status).toBe("skipped");
  });

  test("repairs invalid JSON", async () => {
    vi.mocked(callLocalLlmCompletionForDistillation)
      .mockResolvedValueOnce({ content: "Invalid JSON", toolEvents: [], messages: [] })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          candidates: [
            {
              type: "rule",
              title: "Fixed",
              body: "...",
              confidence: 80,
              importance: 80,
              score: 0.8,
              sourceRefs: ["ref1"],
            },
          ],
        }),
        toolEvents: [],
        messages: [],
      });

    const summary = await distillVibeMemories({ apply: false });

    expect(summary.results[0].candidates[0].title).toBe("Fixed");
  });
});
