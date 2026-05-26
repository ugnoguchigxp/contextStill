import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { queueRouter } from "../api/modules/queue/queue.routes.js";
import * as repo from "../api/modules/queue/queue.repository.js";

vi.mock("../api/modules/queue/queue.repository.js", () => ({
  fetchQueueDashboardStats: vi.fn(),
  listQueueItems: vi.fn(),
  fetchActiveTasks: vi.fn(),
  pauseTarget: vi.fn(),
  resumeTarget: vi.fn(),
  retryTarget: vi.fn(),
}));

const buildApp = () => {
  const app = new Hono();
  app.route("/api/queue", queueRouter);
  return app;
};

describe("queue routes v2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("GET /api/queue/stats returns queue stats", async () => {
    vi.mocked(repo.fetchQueueDashboardStats).mockResolvedValueOnce({
      queues: {
        findingCandidate: {
          counters: { pending: 1, running: 1, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 1,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
          escalated: 0,
        },
        coveringEvidence: {
          counters: { pending: 2, running: 0, completed: 0, skipped: 0, failed: 1, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 1,
          offline: 1,
          nonRegistered: 1,
          escalated: 1,
        },
        premiumCoveringEvidence: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
          escalated: 0,
        },
        finalizeDistille: {
          counters: { pending: 0, running: 0, completed: 3, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
          escalated: 0,
        },
      },
      totals: {
        counters: { pending: 3, running: 1, completed: 3, skipped: 0, failed: 1, paused: 0 },
        oldestPendingAt: null,
        running: 1,
        failed: 1,
        offline: 1,
        nonRegistered: 1,
        escalated: 1,
      },
    });

    const app = buildApp();
    const response = await app.request("/api/queue/stats");
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.totals.counters.pending).toBe(3);
    expect(json.queues.coveringEvidence.nonRegistered).toBe(1);
    expect(repo.fetchQueueDashboardStats).toHaveBeenCalled();
  });

  test("GET /api/queue validates filters and proxies to repository", async () => {
    vi.mocked(repo.listQueueItems).mockResolvedValueOnce({
      queue: "findingCandidate",
      items: [],
      total: 0,
      page: 2,
      limit: 15,
    });

    const app = buildApp();
    const response = await app.request(
      "/api/queue?page=2&limit=15&queue=findingCandidate&status=pending",
    );
    expect(response.status).toBe(200);
    expect(repo.listQueueItems).toHaveBeenCalledWith({
      page: 2,
      limit: 15,
      queue: "findingCandidate",
      status: "pending",
      query: undefined,
    });
  });

  test("GET /api/queue rejects unknown queue name", async () => {
    const app = buildApp();
    const response = await app.request("/api/queue?queue=invalidQueue");
    expect(response.status).toBe(400);
  });

  test("POST /api/queue/:queue/:id/pause routes action", async () => {
    vi.mocked(repo.pauseTarget).mockResolvedValueOnce({ id: "job-1", status: "paused" });

    const app = buildApp();
    const response = await app.request("/api/queue/findingCandidate/job-1/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "manual pause" }),
    });
    expect(response.status).toBe(200);
    expect(repo.pauseTarget).toHaveBeenCalledWith("findingCandidate", "job-1", "manual pause");
  });

  test("POST /api/queue/:queue/:id/resume routes action", async () => {
    vi.mocked(repo.resumeTarget).mockResolvedValueOnce({ id: "job-1", status: "pending" });

    const app = buildApp();
    const response = await app.request("/api/queue/findingCandidate/job-1/resume", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(repo.resumeTarget).toHaveBeenCalledWith("findingCandidate", "job-1");
  });

  test("POST /api/queue/:queue/:id/retry routes action", async () => {
    vi.mocked(repo.retryTarget).mockResolvedValueOnce({ id: "job-1", status: "pending" });

    const app = buildApp();
    const response = await app.request("/api/queue/coveringEvidence/job-1/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "cloud_api", forceRefreshEvidence: true }),
    });
    expect(response.status).toBe(200);
    expect(repo.retryTarget).toHaveBeenCalledWith({
      queueName: "coveringEvidence",
      id: "job-1",
      mode: "cloud_api",
      forceRefreshEvidence: true,
      reason: undefined,
    });
  });

  test("GET /api/queue returns 503 when queue schema is not migrated", async () => {
    const error = new Error('relation "covering_evidence_queue" does not exist') as Error & {
      code?: string;
    };
    error.code = "42P01";
    vi.mocked(repo.listQueueItems).mockRejectedValueOnce(error);

    const app = buildApp();
    const response = await app.request("/api/queue?queue=coveringEvidence&status=running");
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.code).toBe("QUEUE_SCHEMA_NOT_READY");
  });
});
