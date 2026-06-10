import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildLandscapeSnapshot } from "../src/modules/landscape/landscape.service.js";

// モック定義
const mockBuildGraphSnapshot = vi.fn();
const mockRunWithLandscapeSnapshotCache = vi.fn();
const mockLoadLandscapeKnowledgeRows = vi.fn();
const mockLoadLandscapeSelectionAggregates = vi.fn();
const mockLoadLandscapeSelectionPairs = vi.fn();
const mockLoadLandscapeFeedbackAggregates = vi.fn();
const mockLoadLandscapeSourceRefCountMap = vi.fn();

// インポート解決用モックパスの修正 (test/ から見た相対パス)
vi.mock("../api/modules/graph/graph.repository.js", () => ({
  buildGraphSnapshot: (...args: any[]) => mockBuildGraphSnapshot(...args),
}));

vi.mock("../src/modules/landscape/landscape-snapshot-cache.service.js", () => ({
  runWithLandscapeSnapshotCache: (options: any) => mockRunWithLandscapeSnapshotCache(options),
}));

vi.mock("../src/modules/landscape/landscape.repository.js", () => ({
  loadLandscapeKnowledgeRows: (...args: any[]) => mockLoadLandscapeKnowledgeRows(...args),
  loadLandscapeSelectionAggregates: (...args: any[]) =>
    mockLoadLandscapeSelectionAggregates(...args),
  loadLandscapeSelectionPairs: (...args: any[]) => mockLoadLandscapeSelectionPairs(...args),
  loadLandscapeFeedbackAggregates: (...args: any[]) => mockLoadLandscapeFeedbackAggregates(...args),
  loadLandscapeSourceRefCountMap: (...args: any[]) => mockLoadLandscapeSourceRefCountMap(...args),
}));

// 安全のため db 自体もモック化
vi.mock("../src/db/client.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
  },
}));

describe("landscape.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // キャッシュはスルーして build() を実行するデフォルト挙動
    mockRunWithLandscapeSnapshotCache.mockImplementation((options: any) => options.build());

    // デフォルトのリポジトリ結果
    mockLoadLandscapeKnowledgeRows.mockResolvedValue([
      {
        id: "kb-1",
        type: "rule",
        scope: "repo",
        status: "active",
        importance: 80,
        confidence: 90,
        dynamicScore: 50,
        compileSelectCount: 5,
        embedded: false,
        updatedAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    ]);
    mockLoadLandscapeSelectionAggregates.mockResolvedValue([
      { knowledgeId: "kb-1", selectedItemCountWindow: 3, selectedRunCountWindow: 2 },
    ]);
    mockLoadLandscapeSelectionPairs.mockResolvedValue([{ knowledgeId: "kb-1", runId: "run-1" }]);
    mockLoadLandscapeFeedbackAggregates.mockResolvedValue([
      {
        knowledgeId: "kb-1",
        usedCountWindow: 2,
        notUsedCountWindow: 1,
        offTopicCountWindow: 0,
        wrongCountWindow: 0,
      },
    ]);
    mockLoadLandscapeSourceRefCountMap.mockResolvedValue(new Map([["kb-1", 2]]));
  });

  test("buildLandscapeSnapshot builds a detailed snapshot of the knowledge landscape", async () => {
    mockBuildGraphSnapshot.mockResolvedValue({
      nodes: [{ id: "knowledge:kb-1", kind: "knowledge", communityKey: "comm-1" }],
      communities: [
        {
          communityId: "comm-id-1",
          communityKey: "comm-1",
          communityLabel: "Testing Domain Comm",
          communityRank: 1,
          size: 1,
        },
      ],
    });

    const input = {
      windowDays: 7,
      limit: 100,
      status: "active" as const,
      relationAxes: ["session"] as any,
      minSelectedCount: 1,
      minFeedbackCount: 1,
    };

    const snapshot = await buildLandscapeSnapshot(input);

    expect(snapshot.basis.unit).toBe("community");
    expect(snapshot.communities).toHaveLength(1);
    expect(snapshot.communities[0].communityLabel).toBe("Testing Domain Comm");
    expect(snapshot.communities[0].representativeKnowledgeIds).toContain("kb-1");
    expect(snapshot.stats.totalCommunities).toBe(1);
    expect(snapshot.risks).toBeDefined();
  });

  test("buildLandscapeSnapshot detects wrong review required risk when wrong verdict count is observed", async () => {
    mockBuildGraphSnapshot.mockResolvedValue({
      nodes: [{ id: "knowledge:kb-1", kind: "knowledge", communityKey: "comm-1" }],
      communities: [
        {
          communityId: "comm-id-1",
          communityKey: "comm-1",
          communityLabel: "Comm with wrong feedback",
          communityRank: 1,
          size: 1,
        },
      ],
    });

    // wrongCountWindow を多くして wrong_review_required を誘発する
    mockLoadLandscapeFeedbackAggregates.mockResolvedValue([
      {
        knowledgeId: "kb-1",
        usedCountWindow: 1,
        notUsedCountWindow: 0,
        offTopicCountWindow: 0,
        wrongCountWindow: 5, // 5件の wrong verdict
      },
    ]);

    const input = {
      windowDays: 7,
      limit: 100,
      status: "active" as const,
      relationAxes: ["session"] as any,
      minSelectedCount: 1,
      minFeedbackCount: 1,
    };

    const snapshot = await buildLandscapeSnapshot(input);

    const wrongRisk = snapshot.risks.find((r) => r.type === "wrong_review_required");
    expect(wrongRisk).toBeDefined();
    expect(wrongRisk?.severity).toBe("high");
  });
});
