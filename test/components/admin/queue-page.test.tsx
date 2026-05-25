/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuePage } from "../../../web/src/modules/admin/components/queue.page";

const repositoryMocks = vi.hoisted(() => ({
  fetchQueueDashboardStats: vi.fn(),
  fetchActiveQueueTasks: vi.fn(),
  fetchQueueItems: vi.fn(),
  pauseQueueTarget: vi.fn(),
  resumeQueueTarget: vi.fn(),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual(
    "../../../web/src/modules/admin/repositories/admin.repository",
  );
  return {
    ...actual,
    fetchQueueDashboardStats: repositoryMocks.fetchQueueDashboardStats,
    fetchActiveQueueTasks: repositoryMocks.fetchActiveQueueTasks,
    fetchQueueItems: repositoryMocks.fetchQueueItems,
    pauseQueueTarget: repositoryMocks.pauseQueueTarget,
    resumeQueueTarget: repositoryMocks.resumeQueueTarget,
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

describe("QueuePage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-24T09:58:30.000Z"));
    repositoryMocks.fetchQueueDashboardStats.mockResolvedValue({
      stats: { pending: 5, running: 1, completed: 10, failed: 2, paused: 1, skipped: 1 },
      kinds: { wiki_file: 15, vibe_memory: 3 },
      findCandidate: {
        status: "waiting",
        waitMs: 90_000,
        waitUntil: "2026-05-24T10:00:00.000Z",
        reason: "interactive_pressure",
        targetKind: "vibe_memory",
        provider: "openai",
        model: "gpt-5-4-mini",
        source: "scheduler",
        updatedAt: "2026-05-24T09:58:30.000Z",
        diagnostics: {
          provider: "openai",
          model: "gpt-5-4-mini",
          compileCount: 4,
          interactiveLlmCount: 3,
          lastCompileAgeSeconds: 10,
          lastBackgroundAgeSeconds: 20,
        },
      },
      providerPressure: {
        azureOpenai: {
          provider: "azure-openai",
          model: "gpt-5-4-mini",
          status: "ok",
          cooldownUntil: null,
          reason: null,
          source: null,
          lastRateLimitedAt: null,
          updatedAt: null,
        },
      },
    });
    repositoryMocks.fetchActiveQueueTasks.mockResolvedValue([]);
    repositoryMocks.fetchQueueItems.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 15,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders the findCandidate cooldown timer and ticks every second", async () => {
    renderQueuePage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("FindCandidate")).toBeInTheDocument();
    expect(screen.getByText("1m 30s")).toBeInTheDocument();
    expect(screen.getByText("interactive pressure / vibe memory")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("1m 29s")).toBeInTheDocument();
  });
});
