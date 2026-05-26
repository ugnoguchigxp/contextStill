/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuePage } from "../../../web/src/modules/admin/components/queue.page";
import * as adminRepository from "../../../web/src/modules/admin/repositories/admin.repository";

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual(
    "../../../web/src/modules/admin/repositories/admin.repository",
  );
  return {
    ...actual,
    fetchQueueDashboardStatsV2: vi.fn(),
    fetchActiveQueueTasksV2: vi.fn(),
    fetchQueueItemsV2: vi.fn(),
    pauseQueueJobV2: vi.fn(),
    resumeQueueJobV2: vi.fn(),
    retryQueueJobV2: vi.fn(),
  };
});

function renderQueuePage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <QueuePage />
    </QueryClientProvider>,
  );
}

describe("QueuePage v2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    vi.mocked(adminRepository.fetchQueueDashboardStatsV2).mockResolvedValue({
      queues: {
        findingCandidate: {
          counters: { pending: 1, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
          escalated: 0,
        },
        coveringEvidence: {
          counters: { pending: 0, running: 1, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 1,
          failed: 0,
          offline: 0,
          nonRegistered: 2,
          escalated: 1,
        },
        premiumCoveringEvidence: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 1, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 1,
          offline: 1,
          nonRegistered: 1,
          escalated: 0,
        },
        finalizeDistille: {
          counters: { pending: 0, running: 0, completed: 2, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
          escalated: 0,
        },
      },
      totals: {
        counters: { pending: 1, running: 1, completed: 2, skipped: 0, failed: 1, paused: 0 },
        oldestPendingAt: null,
        running: 1,
        failed: 1,
        offline: 1,
        nonRegistered: 3,
        escalated: 1,
      },
    });

    vi.mocked(adminRepository.fetchActiveQueueTasksV2).mockResolvedValue([
      {
        queueName: "coveringEvidence",
        id: "job-running",
        status: "running",
        priority: 50,
        attemptCount: 1,
        subjectTitle: "candidate A",
        subjectDetail: "detail",
        provider: "default",
        model: null,
        lastError: null,
        lastOutcomeKind: null,
        lockedBy: "worker-1",
        lockedAt: "2026-05-25T11:59:25.000Z",
        heartbeatAt: "2026-05-25T11:59:30.000Z",
        createdAt: "2026-05-25T11:58:00.000Z",
        updatedAt: "2026-05-25T11:59:30.000Z",
        completedAt: null,
        nextRunAt: null,
        metadataSummary: null,
      },
    ]);

    vi.mocked(adminRepository.fetchQueueItemsV2).mockResolvedValue({
      queue: "findingCandidate",
      items: [
        {
          queueName: "findingCandidate",
          id: "job-1",
          status: "pending",
          priority: 50,
          attemptCount: 0,
          subjectTitle: "wiki/page.md",
          subjectDetail: "wiki_file | file:///wiki/page.md",
          provider: null,
          model: null,
          lastError: null,
          lastOutcomeKind: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          createdAt: "2026-05-25T11:58:00.000Z",
          updatedAt: "2026-05-25T11:59:00.000Z",
          completedAt: null,
          nextRunAt: null,
          metadataSummary: "input=source_target",
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    vi.mocked(adminRepository.pauseQueueJobV2).mockResolvedValue({ ok: true });
    vi.mocked(adminRepository.resumeQueueJobV2).mockResolvedValue({ ok: true });
    vi.mocked(adminRepository.retryQueueJobV2).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders 4 queue tabs and table rows", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("button", { name: "Finding" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Covering" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Premium" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalize" })).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("wiki/page.md")).toBeInTheDocument();
  });

  it("switches queue tab and refetches list with selected queue", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Covering" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.fetchQueueItemsV2).toHaveBeenCalledWith(
      expect.objectContaining({ queue: "coveringEvidence" }),
    );
  });

  it("runs pause action with queue-aware endpoint call", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByTitle("Pause queue job"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.pauseQueueJobV2).toHaveBeenCalledWith("findingCandidate", "job-1");
  });

  it("shows LLM status labels (Ready/Active/Offline) and does not show 待機中 label", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("button", { name: "Finding" })).toHaveTextContent("Ready");
    expect(screen.getByRole("button", { name: "Covering" })).toHaveTextContent("Active");
    expect(screen.getByRole("button", { name: "Covering" })).toHaveTextContent("非登録");
    expect(screen.getByRole("button", { name: "Covering" })).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Premium" })).toHaveTextContent("Offline");
    expect(screen.getByRole("button", { name: "Premium" })).toHaveTextContent("非登録");
    expect(screen.getAllByText("非登録")).toHaveLength(2);
    expect(screen.queryByText("待機中")).not.toBeInTheDocument();
  });
});
