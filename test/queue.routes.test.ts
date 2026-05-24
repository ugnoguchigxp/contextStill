import { Hono } from "hono";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { queueRouter } from "../api/modules/queue/queue.routes.js";
import {
  fetchQueueDashboardStats,
  listQueueItems,
  fetchActiveTasks,
  pauseTarget,
  resumeTarget,
} from "../api/modules/queue/queue.repository.js";

vi.mock("../api/modules/queue/queue.repository.js", () => ({
  fetchQueueDashboardStats: vi.fn(),
  listQueueItems: vi.fn(),
  fetchActiveTasks: vi.fn(),
  pauseTarget: vi.fn(),
  resumeTarget: vi.fn(),
}));

const buildApp = () => {
  const app = new Hono();
  app.route("/api/queue", queueRouter);
  return app;
};

describe("Queue route contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("GET /api/queue/stats returns correct stats", async () => {
    vi.mocked(fetchQueueDashboardStats).mockResolvedValueOnce({
      stats: { pending: 5, running: 1, completed: 10, failed: 2, paused: 0 },
      kinds: { wiki_file: 15, vibe_memory: 3 },
    });

    const app = buildApp();
    const response = await app.request("/api/queue/stats");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      stats: { pending: 5, running: 1, completed: 10, failed: 2, paused: 0 },
      kinds: { wiki_file: 15, vibe_memory: 3 },
    });
    expect(fetchQueueDashboardStats).toHaveBeenCalled();
  });

  test("GET /api/queue lists targets with correct queries", async () => {
    vi.mocked(listQueueItems).mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      limit: 15,
    });

    const app = buildApp();
    const response = await app.request(
      "/api/queue?page=2&limit=15&targetKind=wiki_file&status=pending",
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 15,
    });
    expect(listQueueItems).toHaveBeenCalledWith({
      page: 2,
      limit: 15,
      targetKind: "wiki_file",
      status: "pending",
      query: undefined,
    });
  });

  test("GET /api/queue rejects unknown status filter", async () => {
    const app = buildApp();
    const response = await app.request("/api/queue?status=unknown");
    expect(response.status).toBe(400);
    expect(listQueueItems).not.toHaveBeenCalled();
  });

  test("GET /api/queue/active returns active targets", async () => {
    vi.mocked(fetchActiveTasks).mockResolvedValueOnce([
      {
        id: "active-1",
        targetKind: "wiki_file",
        targetKey: "wiki/intro.md",
        sourceUri: "file:///intro.md",
        distillationVersion: "1.0",
        status: "running",
        phase: "reading",
        priorityGroup: "wiki",
        sortKey: "sort-1",
        attemptCount: 1,
        lockedBy: "worker-1",
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        lastError: null,
        lastOutcomeKind: null,
        candidateCount: 0,
        knowledgeIds: [],
        metadata: {},
        createdAt: null,
        updatedAt: null,
        completedAt: null,
      } as any,
    ]);

    const app = buildApp();
    const response = await app.request("/api/queue/active");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toHaveLength(1);
    expect(json[0].id).toBe("active-1");
    expect(json[0].status).toBe("running");
  });

  test("POST /api/queue/:id/pause successfully pauses target", async () => {
    vi.mocked(pauseTarget).mockResolvedValueOnce({
      id: "target-1",
      status: "paused",
    } as any);

    const app = buildApp();
    const response = await app.request("/api/queue/target-1/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual pause" }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(pauseTarget).toHaveBeenCalledWith("target-1", "manual pause");
  });

  test("POST /api/queue/:id/resume successfully resumes target", async () => {
    vi.mocked(resumeTarget).mockResolvedValueOnce({
      id: "target-1",
      status: "pending",
    } as any);

    const app = buildApp();
    const response = await app.request("/api/queue/target-1/resume", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    expect(resumeTarget).toHaveBeenCalledWith("target-1");
  });
});
