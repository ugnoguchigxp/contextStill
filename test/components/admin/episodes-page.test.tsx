/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EpisodesPage } from "../../../web/src/modules/admin/components/episodes.page";
import type { EpisodeCard } from "../../../web/src/modules/admin/repositories/admin.repository";
import {
  createEpisode,
  fetchEpisode,
  fetchEpisodes,
} from "../../../web/src/modules/admin/repositories/admin.repository";

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual<
    typeof import("../../../web/src/modules/admin/repositories/admin.repository")
  >("../../../web/src/modules/admin/repositories/admin.repository");
  return {
    ...actual,
    fetchEpisodes: vi.fn(),
    fetchEpisode: vi.fn(),
    createEpisode: vi.fn(),
  };
});

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <EpisodesPage />
    </QueryClientProvider>,
  );
}

function episode(overrides: Partial<EpisodeCard> = {}): EpisodeCard {
  return {
    id: "ep-1",
    title: "First episode",
    situation: "A detailed situation that should be truncated because it is quite long. ".repeat(4),
    observations: "Context notes",
    action: "Implemented coverage tests",
    outcome: "Tests started failing less often",
    lesson: "Keep source refs explicit",
    applicability: {},
    antiApplicability: {},
    domains: ["episodic-memory", "admin-ui", "coverage", "testing"],
    technologies: ["typescript", "react", "vitest"],
    changeTypes: ["ui", "api"],
    tools: ["vitest"],
    sourceKind: "manual",
    sourceKey: "manual-1",
    outcomeKind: "success",
    importance: 70,
    confidence: 80,
    compileUseCount: 2,
    decisionUseCount: 1,
    status: "active",
    metadata: {
      episodeDistillation: {
        sourceFragmentKey: "vibe_memory:mem-1:episode:abcd:episode-distiller-v1",
        sourceStartOffset: 0,
        sourceEndOffset: 42,
        scores: { importance: 70, confidence: 80, reusability: 75 },
      },
    },
    createdAt: "2026-05-21T08:00:00.000Z",
    updatedAt: "2026-05-21T08:00:00.000Z",
    refs: [
      {
        id: "r-vibe",
        episodeCardId: "ep-1",
        refKind: "vibe_memory",
        refValue: "mem-1",
        queryHint: "open memory",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-diff",
        episodeCardId: "ep-1",
        refKind: "agent_diff",
        refValue: "diff-1",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-compile",
        episodeCardId: "ep-1",
        refKind: "compile_run",
        refValue: "https://local/run/run-123",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-decision",
        episodeCardId: "ep-1",
        refKind: "decision_run",
        refValue: "decision-9",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-audit",
        episodeCardId: "ep-1",
        refKind: "audit_log",
        refValue: "audit-q",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-file-url",
        episodeCardId: "ep-1",
        refKind: "file",
        refValue: "https://example.com/note.md",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-file-path",
        episodeCardId: "ep-1",
        refKind: "file",
        refValue: "src/worker.ts",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
      {
        id: "r-commit",
        episodeCardId: "ep-1",
        refKind: "commit",
        refValue: "abc123",
        createdAt: "2026-05-21T08:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("EpisodesPage", () => {
  beforeEach(() => {
    vi.mocked(fetchEpisodes).mockReset();
    vi.mocked(fetchEpisode).mockReset();
    vi.mocked(createEpisode).mockReset();
  });

  it("shows the loading state while episodes are fetched", async () => {
    vi.mocked(fetchEpisodes).mockImplementation(() => new Promise(() => undefined));
    renderPage();
    expect(await screen.findByText("Loading episodes...")).toBeInTheDocument();
  });

  it("shows the error state when the list query fails", async () => {
    vi.mocked(fetchEpisodes).mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByText("Failed to load episodes.")).toBeInTheDocument();
  });

  it("shows the empty state and keeps register disabled until required fields are filled", async () => {
    vi.mocked(fetchEpisodes).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("No episode cards found.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /new/i }));
    expect(await screen.findByRole("heading", { name: "New Episode" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Title, origin key, summary, takeaway, and at least one source ref are required.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /register/i })).toBeDisabled();
  });

  it("renders cards, filters, refreshes, and opens episode details with source refs", async () => {
    const rich = episode();
    const sparse = episode({
      id: "ep-2",
      title: "Sparse episode",
      situation: "",
      observations: "",
      action: "",
      outcome: "",
      lesson: "",
      domains: [],
      technologies: [],
      changeTypes: [],
      tools: [],
      refs: [],
      metadata: {},
      compileUseCount: 0,
      decisionUseCount: 0,
      outcomeKind: "unknown",
      sourceKind: "vibe_memory",
      sourceKey: "mem-9",
    });
    vi.mocked(fetchEpisodes).mockResolvedValue([rich, sparse]);
    const detailResolvers: Array<(value: EpisodeCard) => void> = [];
    vi.mocked(fetchEpisode).mockImplementation(
      () =>
        new Promise((resolve) => {
          detailResolvers.push(resolve);
        }),
    );

    renderPage();
    expect(await screen.findByText("First episode")).toBeInTheDocument();
    expect(screen.getByText("Sparse episode")).toBeInTheDocument();
    expect(screen.getByText("2 cards")).toBeInTheDocument();
    expect(screen.getByText("1 with refs")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("First episode"));
    expect(await screen.findByText("Loading episode...")).toBeInTheDocument();
    for (const resolve of detailResolvers.splice(0)) resolve(rich);

    const drawer = await screen.findByLabelText("Episode details");
    expect(await within(drawer).findByText("Episode Summary")).toBeInTheDocument();
    expect(within(drawer).getByText("Reusable Takeaway")).toBeInTheDocument();
    expect(within(drawer).getByText("Context Notes")).toBeInTheDocument();
    expect(within(drawer).getByText(/bytes:0-42/)).toBeInTheDocument();
    expect(within(drawer).getByText("importance 70")).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /vibe_memory/ })).toHaveAttribute(
      "href",
      "/vibe-memory?memoryId=mem-1",
    );
    expect(within(drawer).getByRole("link", { name: /agent_diff/ })).toHaveAttribute(
      "href",
      "/vibe-memory?agentDiffId=diff-1",
    );
    expect(within(drawer).getByRole("link", { name: /compile_run/ })).toHaveAttribute(
      "href",
      "/compile?runId=run-123",
    );
    expect(
      within(drawer).getByRole("link", { name: /https:\/\/example.com\/note.md/ }),
    ).toHaveAttribute("target", "_blank");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByLabelText("Episode details")).not.toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Search episodes"), {
      target: { value: "sparse" },
    });
    fireEvent.change(screen.getByLabelText("episode-status-filter"), {
      target: { value: "deprecated" },
    });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() =>
      expect(fetchEpisodes).toHaveBeenLastCalledWith({
        query: "sparse",
        status: "deprecated",
        limit: 100,
      }),
    );
  });

  it("shows episode not found after the selected card disappears from the list", async () => {
    const item = episode({ refs: [] });
    vi.mocked(fetchEpisodes).mockResolvedValueOnce([item]).mockResolvedValue([]);
    vi.mocked(fetchEpisode).mockResolvedValue(undefined as unknown as EpisodeCard);

    renderPage();
    fireEvent.click(await screen.findByText("First episode"));
    fireEvent.change(screen.getByPlaceholderText("Search episodes"), {
      target: { value: "missing" },
    });
    expect(await screen.findByText("Episode not found.")).toBeInTheDocument();
  });

  it("creates an episode from the modal and surfaces create errors", async () => {
    let items: EpisodeCard[] = [];
    vi.mocked(fetchEpisodes).mockImplementation(async () => items);
    const created = episode({ id: "ep-created", title: "Created episode", refs: [] });
    vi.mocked(createEpisode)
      .mockRejectedValueOnce(new Error("create failed"))
      .mockImplementation(async () => {
        items = [created];
        return created;
      });
    vi.mocked(fetchEpisode).mockResolvedValue(created);

    renderPage();
    await screen.findByText("No episode cards found.");
    fireEvent.click(screen.getByRole("button", { name: /new/i }));

    fireEvent.change(screen.getByLabelText("Episode title"), {
      target: { value: "Created episode" },
    });
    fireEvent.change(screen.getByLabelText("Origin type"), { target: { value: "vibe_memory" } });
    fireEvent.change(screen.getByLabelText("Origin key"), { target: { value: "mem-created" } });
    fireEvent.change(screen.getByLabelText("Episode summary"), {
      target: { value: "summary text" },
    });
    fireEvent.change(screen.getByLabelText("Reusable takeaway"), {
      target: { value: "lesson text" },
    });
    fireEvent.change(screen.getByLabelText("Result kind"), { target: { value: "success" } });
    fireEvent.change(screen.getByLabelText("Importance"), { target: { value: "88" } });
    fireEvent.change(screen.getByLabelText("Confidence"), { target: { value: "76" } });
    fireEvent.change(screen.getByLabelText("Domains"), { target: { value: "memory, admin" } });
    fireEvent.change(screen.getByLabelText("Technologies"), { target: { value: "typescript" } });
    fireEvent.change(screen.getByLabelText("Change types"), { target: { value: "ui" } });
    fireEvent.change(screen.getByLabelText("Tools"), { target: { value: "vitest" } });
    fireEvent.change(screen.getByLabelText("Default ref kind"), { target: { value: "audit_log" } });
    fireEvent.change(screen.getByLabelText("Source refs"), {
      target: { value: "vibe_memory:mem-created\nplain-ref\n" },
    });
    fireEvent.change(screen.getByLabelText("Source query hint"), {
      target: { value: "reopen this" },
    });

    fireEvent.click(screen.getByRole("button", { name: /register/i }));
    expect(await screen.findByText("Error: create failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /register/i }));
    await waitFor(() => expect(createEpisode).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createEpisode).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        title: "Created episode",
        sourceKind: "vibe_memory",
        sourceKey: "mem-created",
        situation: "summary text",
        lesson: "lesson text",
        outcomeKind: "success",
        importance: 88,
        confidence: 76,
        domains: ["memory", "admin"],
        technologies: ["typescript"],
        changeTypes: ["ui"],
        tools: ["vitest"],
        refs: [
          expect.objectContaining({
            refKind: "vibe_memory",
            refValue: "mem-created",
            queryHint: "reopen this",
          }),
          expect.objectContaining({
            refKind: "audit_log",
            refValue: "plain-ref",
            queryHint: "reopen this",
          }),
        ],
      }),
    );
    expect(await screen.findByText("Created episode")).toBeInTheDocument();
  });

  it("paginates and sorts a long episode list", async () => {
    const items = Array.from({ length: 26 }, (_, index) =>
      episode({
        id: `ep-${index}`,
        title: `Episode ${String(index).padStart(2, "0")}`,
        createdAt: `2026-05-${String((index % 27) + 1).padStart(2, "0")}T08:00:00.000Z`,
        refs: [],
        domains: ["one"],
        technologies: ["ts"],
        changeTypes: ["ui"],
      }),
    );
    vi.mocked(fetchEpisodes).mockResolvedValue(items);
    vi.mocked(fetchEpisode).mockResolvedValue(items[0]);

    renderPage();
    expect(await screen.findByText("Episode 25")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText(/Showing 26 to 26 of 26 episodes/)).toBeInTheDocument();
    expect(screen.getByText("Episode 00")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^episode$/i }));
    expect(screen.getByText("Episode 00")).toBeInTheDocument();
  });
});
