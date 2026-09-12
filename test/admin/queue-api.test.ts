import { beforeEach, describe, expect, it, vi } from "vitest";
import { getJson, requestJson } from "../../web/src/modules/admin/repositories/admin/http";
import {
  fetchActiveQueueTasksV2,
  fetchQueueDashboardStatsV2,
  fetchQueueItemsV2,
  pauseQueueJobV2,
  pauseQueueLaneV2,
  resumeQueueJobV2,
  resumeQueueLaneV2,
  retryQueueJobV2,
} from "../../web/src/modules/admin/repositories/admin/queue-api";

vi.mock("../../web/src/modules/admin/repositories/admin/http", () => ({
  getJson: vi.fn(),
  requestJson: vi.fn(),
}));

describe("queue-api", () => {
  beforeEach(() => {
    vi.mocked(getJson).mockReset();
    vi.mocked(requestJson).mockReset();
    vi.mocked(getJson).mockResolvedValue({ ok: true });
    vi.mocked(requestJson).mockResolvedValue({ ok: true });
  });

  it("fetches dashboard stats and active tasks", async () => {
    await fetchQueueDashboardStatsV2();
    await fetchActiveQueueTasksV2();
    expect(getJson).toHaveBeenCalledWith("/api/queue/stats");
    expect(getJson).toHaveBeenCalledWith("/api/queue/active");
  });

  it("builds queue list query params including optional filters", async () => {
    await fetchQueueItemsV2({
      page: 2,
      limit: 25,
      queue: "coveringEvidence",
      query: "  auth retry  ",
      status: "failed",
      sortBy: "updatedAt",
      sortDir: "desc",
    });
    expect(getJson).toHaveBeenCalledWith(
      "/api/queue?page=2&limit=25&queue=coveringEvidence&query=auth+retry&status=failed&sortBy=updatedAt&sortDir=desc",
    );

    await fetchQueueItemsV2({
      page: 1,
      limit: 10,
      queue: "findingCandidate",
    });
    expect(getJson).toHaveBeenLastCalledWith("/api/queue?page=1&limit=10&queue=findingCandidate");
  });

  it("posts pause, resume, and retry actions", async () => {
    await pauseQueueJobV2("episodeDistiller", "job/1", "hold");
    await pauseQueueLaneV2("finalizeDistille", "lane-pause");
    await resumeQueueLaneV2("landscapeCuration");
    await resumeQueueJobV2("deadZoneMergeReview", "job 2");
    await retryQueueJobV2({
      queue: "coveringEvidence",
      id: "job-3",
    });
    await retryQueueJobV2({
      queue: "findingCandidate",
      id: "job-4",
      mode: "cloud_api",
      forceRefreshEvidence: false,
      reason: "manual",
    });

    expect(requestJson).toHaveBeenCalledWith("/api/queue/episodeDistiller/job%2F1/pause", "POST", {
      reason: "hold",
    });
    expect(requestJson).toHaveBeenCalledWith("/api/queue/finalizeDistille/pause", "POST", {
      reason: "lane-pause",
    });
    expect(requestJson).toHaveBeenCalledWith("/api/queue/landscapeCuration/resume", "POST", {
      reason: undefined,
    });
    expect(requestJson).toHaveBeenCalledWith(
      "/api/queue/deadZoneMergeReview/job%202/resume",
      "POST",
    );
    expect(requestJson).toHaveBeenCalledWith("/api/queue/coveringEvidence/job-3/retry", "POST", {
      mode: "default",
      forceRefreshEvidence: true,
      reason: undefined,
    });
    expect(requestJson).toHaveBeenCalledWith("/api/queue/findingCandidate/job-4/retry", "POST", {
      mode: "cloud_api",
      forceRefreshEvidence: false,
      reason: "manual",
    });
  });
});
