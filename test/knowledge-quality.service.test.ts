import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import { applyKnowledgeQualityAdjustments } from "../src/modules/knowledge/knowledge-quality.service.js";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    update: (...args: any[]) => mockUpdate(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    knowledgeQualityAdjusted: "KNOWLEDGE_QUALITY_ADJUSTED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

// Helper to create thenable query chains
const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    groupBy: vi.fn().mockImplementation(() => chain),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("knowledge-quality.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("dryRun works correctly and returns active knowledge preview without DB update", async () => {
    const mockActiveKnowledge = [
      { id: "k1", importance: 5, confidence: 5 },
      { id: "k2", importance: 8, confidence: 8 },
    ];

    const mockUsageEvents = [
      { knowledgeId: "k1", offTopicRunCount: 6, usedRunCount: 2 }, // offTopicRate = 6/8 = 0.75 >= 0.6, offTopicRunCount 6 >= 5 -> candidate
      { knowledgeId: "k2", offTopicRunCount: 2, usedRunCount: 8 }, // offTopicRate = 2/10 = 0.2 < 0.6 -> ignored
    ];

    const mockCooldowns: any[] = []; // No cooldown history

    // Chain 1: loadActiveKnowledgeRows
    mockSelect.mockReturnValueOnce(makeChain(mockActiveKnowledge));
    // Chain 2: loadUsageAggregates
    mockSelect.mockReturnValueOnce(makeChain(mockUsageEvents));
    // Chain 3: loadCooldownRows
    mockSelect.mockReturnValueOnce(makeChain(mockCooldowns));

    const result = await applyKnowledgeQualityAdjustments({
      apply: false, // Dry run
      windowDays: 14,
      cooldownDays: 14,
      minOffTopicRuns: 5,
      minOffTopicRate: 0.6,
      decrement: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.scannedCount).toBe(2);
    expect(result.candidateCount).toBe(1);
    expect(result.adjustedCount).toBe(0);
    expect(result.skippedByCooldownCount).toBe(0);
    expect(result.candidatePreview).toHaveLength(1);
    expect(result.candidatePreview[0]).toMatchObject({
      knowledgeId: "k1",
      usedRunCount: 2,
      offTopicRunCount: 6,
      offTopicRate: 0.75,
      cooldownBlocked: false,
    });

    // Make sure no update or insert is called during dry-run
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test("apply: true updates the DB and inserts records, sending audit log", async () => {
    const mockActiveKnowledge = [{ id: "k1", importance: 5, confidence: 6 }];
    const mockUsageEvents = [{ knowledgeId: "k1", offTopicRunCount: 5, usedRunCount: 1 }];
    const mockCooldowns: any[] = [];

    mockSelect.mockReturnValueOnce(makeChain(mockActiveKnowledge));
    mockSelect.mockReturnValueOnce(makeChain(mockUsageEvents));
    mockSelect.mockReturnValueOnce(makeChain(mockCooldowns));

    // Mock update chain
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    mockUpdate.mockReturnValue(updateChain);

    // Mock insert chain
    const insertChain = {
      values: vi.fn().mockResolvedValue(undefined),
    };
    mockInsert.mockReturnValue(insertChain);

    const result = await applyKnowledgeQualityAdjustments({
      apply: true,
      windowDays: 10,
      cooldownDays: 5,
      decrement: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.adjustedCount).toBe(1);

    expect(mockUpdate).toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalled();
    expect(recordAuditLogSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "KNOWLEDGE_QUALITY_ADJUSTED",
        actor: "system",
        payload: expect.objectContaining({
          knowledgeId: "k1",
          importanceDelta: -3,
          confidenceDelta: -3,
        }),
      }),
    );
  });

  test("cooldownDays blocks adjustment when candidate has recent quality decrement", async () => {
    const mockActiveKnowledge = [{ id: "k1", importance: 5, confidence: 5 }];
    const mockUsageEvents = [{ knowledgeId: "k1", offTopicRunCount: 10, usedRunCount: 0 }];

    // Cooldown is set to 14 days. The last adjustment was 5 days ago (blocked).
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 5);
    const mockCooldowns = [{ knowledgeId: "k1", lastAdjustedAt: recentDate }];

    mockSelect.mockReturnValueOnce(makeChain(mockActiveKnowledge));
    mockSelect.mockReturnValueOnce(makeChain(mockUsageEvents));
    mockSelect.mockReturnValueOnce(makeChain(mockCooldowns));

    const result = await applyKnowledgeQualityAdjustments({
      apply: true,
      cooldownDays: 14,
    });

    expect(result.ok).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.adjustedCount).toBe(0);
    expect(result.skippedByCooldownCount).toBe(1);
    expect(result.candidatePreview[0].cooldownBlocked).toBe(true);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("cooldownDays does NOT block adjustment if last adjusted is older than cooldownDays", async () => {
    const mockActiveKnowledge = [{ id: "k1", importance: 5, confidence: 5 }];
    const mockUsageEvents = [{ knowledgeId: "k1", offTopicRunCount: 10, usedRunCount: 0 }];

    // Cooldown is 14 days. Last adjustment was 20 days ago (eligible).
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 20);
    const mockCooldowns = [{ knowledgeId: "k1", lastAdjustedAt: oldDate }];

    mockSelect.mockReturnValueOnce(makeChain(mockActiveKnowledge));
    mockSelect.mockReturnValueOnce(makeChain(mockUsageEvents));
    mockSelect.mockReturnValueOnce(makeChain(mockCooldowns));

    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    });
    mockInsert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    const result = await applyKnowledgeQualityAdjustments({
      apply: true,
      cooldownDays: 14,
    });

    expect(result.ok).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.adjustedCount).toBe(1);
    expect(result.skippedByCooldownCount).toBe(0);
    expect(result.candidatePreview[0].cooldownBlocked).toBe(false);
  });

  test("handles empty active knowledge or empty usage events gracefully", async () => {
    mockSelect.mockReturnValueOnce(makeChain([])); // No active knowledge
    mockSelect.mockReturnValueOnce(makeChain([]));
    mockSelect.mockReturnValueOnce(makeChain([]));

    const result = await applyKnowledgeQualityAdjustments({ apply: true });
    expect(result.ok).toBe(true);
    expect(result.scannedCount).toBe(0);
    expect(result.candidateCount).toBe(0);
  });
});
