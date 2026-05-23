/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "../../../web/src/modules/admin/components/settings.page";
import type {
  RuntimeProviderName,
  RuntimeSettingsSnapshotResponse,
  RuntimeSettingsUpdateResponse,
  RuntimeSettingsView,
} from "../../../web/src/modules/admin/repositories/admin.repository";

const routerState = vi.hoisted(() => ({
  pathname: "/setting/llmprovider",
}));

const repositoryMocks = vi.hoisted(() => ({
  fetchRuntimeSettings: vi.fn(),
  updateRuntimeSettings: vi.fn(),
  reloadRuntimeSettingsCache: vi.fn(),
  testRuntimeProvider: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, className, children }: any) => {
    let href = typeof to === "string" ? to : "/";
    if (href.includes("$section")) {
      href = href.replace("$section", params?.section ?? "");
    }
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  },
  useRouterState: vi.fn().mockImplementation(({ select }: any) =>
    typeof select === "function"
      ? select({ location: { pathname: routerState.pathname } })
      : routerState.pathname,
  ),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual("../../../web/src/modules/admin/repositories/admin.repository");
  return {
    ...actual,
    fetchRuntimeSettings: repositoryMocks.fetchRuntimeSettings,
    updateRuntimeSettings: repositoryMocks.updateRuntimeSettings,
    reloadRuntimeSettingsCache: repositoryMocks.reloadRuntimeSettingsCache,
    testRuntimeProvider: repositoryMocks.testRuntimeProvider,
  };
});

function secretStatus(configured: boolean) {
  return {
    configured,
    source: configured ? ("env" as const) : ("none" as const),
    maskedValue: configured ? "sk****ey" : null,
    updatedAt: configured ? "2026-05-23T12:00:00.000Z" : null,
  };
}

function buildSettingsView(): RuntimeSettingsView {
  return {
    providers: {
      openai: {
        enabled: true,
        apiBaseUrl: "https://api.openai.com/v1",
        model: "gpt-5-4-mini",
        apiKeySecret: secretStatus(true),
      },
      "azure-openai": {
        enabled: true,
        apiBaseUrl: "https://example.openai.azure.com",
        apiPath: "/openai/deployments",
        apiVersion: "2025-04-01-preview",
        model: "gpt-5-4-mini",
        apiKeySecret: secretStatus(true),
      },
      bedrock: {
        enabled: false,
        region: "us-east-1",
        profile: "",
        model: "anthropic.claude-3-5-haiku-20241022-v1:0",
        credentialSecret: {
          configured: false,
          source: "none",
          maskedValue: null,
          updatedAt: null,
        },
      },
      "local-llm": {
        enabled: true,
        apiBaseUrl: "http://127.0.0.1:44448",
        model: "gemma-4-e4b-it",
        apiKeySecret: secretStatus(false),
      },
    },
    taskRouting: {
      findCandidate: {
        source: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        vibe: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
      },
      coverEvidence: {
        sourceSupport: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
        externalEvidence: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
        mcpEvidence: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
      },
      finalizeDistille: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
      agenticCompile: {
        enabled: true,
        provider: "openai",
        model: "gpt-5-4-mini",
        fallback: ["local-llm"],
        timeoutMs: 15000,
        maxTokens: 4000,
      },
    },
    search: {
      providerOrder: ["brave", "exa", "duckduckgo"],
      maxProviderAttempts: 2,
      resultCount: 3,
      timeoutMs: 10000,
      rateLimitCooldownSeconds: 3600,
      providers: {
        brave: { enabled: true, apiKeySecret: secretStatus(true) },
        exa: { enabled: true, apiKeySecret: secretStatus(false) },
        duckduckgo: { enabled: true },
      },
    },
    embedding: {
      provider: "daemon",
      daemonUrl: "http://127.0.0.1:44512",
      openaiModel: "text-embedding-3-small",
      timeoutMs: 30000,
    },
    distillationRuntime: {
      timeoutMs: 30000,
      candidateTimeoutMs: 15000,
      maxToolRounds: 4,
      toolTimeoutMs: 10000,
      toolResultMaxChars: 12000,
      failureRetryDelaySeconds: 90,
      readerMaxReads: 12,
      readerMaxCharsPerRead: 12000,
      lowImportanceRejectThreshold: 40,
    },
    advanced: {
      pipelineLockStaleSeconds: 1200,
      lockTtlSeconds: 1800,
      continuousIdleSleepMs: 5000,
      continuousErrorSleepMs: 12000,
      inventoryRefreshIntervalMs: 30000,
      doctorFreshnessThresholdMinutes: 720,
      doctorDegradedRateThreshold: 0.5,
      doctorKnowledgeZeroUseWarningMinActiveCount: 10,
    },
  };
}

function buildSnapshot(revision = 1): RuntimeSettingsSnapshotResponse {
  const settings = buildSettingsView();
  return {
    settings,
    effective: settings,
    sources: {},
    revision,
    loadedAt: "2026-05-23T12:00:00.000Z",
  };
}

function buildUpdateResponse(): RuntimeSettingsUpdateResponse {
  return {
    ...buildSnapshot(2),
    updatedAt: "2026-05-23T12:10:00.000Z",
    cacheInvalidated: true,
    reloadRequired: true,
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPage() {
  const queryClient = createQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    routerState.pathname = "/setting/llmprovider";
    repositoryMocks.fetchRuntimeSettings.mockReset();
    repositoryMocks.updateRuntimeSettings.mockReset();
    repositoryMocks.reloadRuntimeSettingsCache.mockReset();
    repositoryMocks.testRuntimeProvider.mockReset();

    repositoryMocks.fetchRuntimeSettings.mockResolvedValue(buildSnapshot());
    repositoryMocks.updateRuntimeSettings.mockResolvedValue(buildUpdateResponse());
    repositoryMocks.reloadRuntimeSettingsCache.mockResolvedValue({
      ok: true,
      reloadedAt: "2026-05-23T12:20:00.000Z",
    });
    repositoryMocks.testRuntimeProvider.mockImplementation(async (provider: RuntimeProviderName) => ({
      provider,
      health: {
        provider,
        configured: true,
        reachable: true,
        model: "gpt-5-4-mini",
        endpoint: "https://example.invalid",
      },
    }));
  });

  it("renders task-routing tab from URL and keeps tab links canonical", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByText("Find Candidate")).toBeInTheDocument();
    expect(screen.getByText("Cover Evidence")).toBeInTheDocument();
    expect(screen.getByText("Agentic Compile")).toBeInTheDocument();

    const tabLink = screen.getByRole("link", { name: "LLM Providers" });
    expect(tabLink).toHaveAttribute("href", "/setting/llmprovider");

    const providerSelects = screen.getAllByLabelText("Provider");
    const firstProviderSelect = providerSelects[0];
    expect(within(firstProviderSelect).getByRole("option", { name: "auto" })).toBeInTheDocument();
  });

  it("supports legacy settings URL and resolves active tab", async () => {
    routerState.pathname = "/settings/taskrouting";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Task Routing" })).toHaveClass("active");
    expect(screen.getByRole("link", { name: "LLM Providers" })).toHaveAttribute(
      "href",
      "/setting/llmprovider",
    );
  });

  it("saves task-routing changes with provider-model sync and deduped fallback", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save Settings" });
    expect(saveButton).toBeDisabled();

    const sourceRow = screen.getByText("findCandidate.source").closest(".settings-route-row");
    expect(sourceRow).not.toBeNull();
    const rowScope = within(sourceRow as HTMLElement);

    fireEvent.change(rowScope.getByLabelText("Provider"), { target: { value: "azure-openai" } });
    fireEvent.change(rowScope.getByLabelText("Fallback 1"), { target: { value: "local-llm" } });
    fireEvent.change(rowScope.getByLabelText("Fallback 2"), { target: { value: "local-llm" } });

    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.updatedBy).toBe("admin-ui");
    expect(payload.settings.taskRouting.findCandidate.source).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      fallback: ["local-llm"],
    });
  });

  it("calls provider health test for selected provider card", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Azure OpenAI" })).toBeInTheDocument();

    const testButtons = screen.getAllByRole("button", { name: "Test" });
    fireEvent.click(testButtons[1]);

    await waitFor(() => expect(repositoryMocks.testRuntimeProvider).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testRuntimeProvider).toHaveBeenCalledWith("azure-openai");
  });
});
