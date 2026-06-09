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
  testAzureOpenAiDeployment: vi.fn(),
  testLocalLlmModel: vi.fn(),
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
  useRouterState: vi
    .fn()
    .mockImplementation(({ select }: any) =>
      typeof select === "function"
        ? select({ location: { pathname: routerState.pathname } })
        : routerState.pathname,
    ),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual(
    "../../../web/src/modules/admin/repositories/admin.repository",
  );
  return {
    ...actual,
    fetchRuntimeSettings: repositoryMocks.fetchRuntimeSettings,
    updateRuntimeSettings: repositoryMocks.updateRuntimeSettings,
    reloadRuntimeSettingsCache: repositoryMocks.reloadRuntimeSettingsCache,
    testAzureOpenAiDeployment: repositoryMocks.testAzureOpenAiDeployment,
    testLocalLlmModel: repositoryMocks.testLocalLlmModel,
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
    general: {
      distillationPriority: {
        targetPriorityOrder: ["knowledge_candidate", "web_ingest", "wiki_file", "vibe_memory"],
      },
    },
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
        apiKeySecrets: [secretStatus(true), secretStatus(false), secretStatus(false)],
        deployments: [
          {
            name: "Primary",
            apiBaseUrl: "https://example.openai.azure.com",
            apiPath: "/openai/deployments",
            apiVersion: "2025-04-01-preview",
            model: "gpt-5-4-mini",
          },
        ],
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
        models: [
          {
            name: "Primary",
            apiBaseUrl: "http://127.0.0.1:44448",
            model: "gemma-4-e4b-it",
          },
          {
            name: "Qwen",
            apiBaseUrl: "http://127.0.0.1:44449",
            model: "qwen-3.6-14b-it",
          },
        ],
        apiKeySecret: secretStatus(false),
      },
      codex: {
        enabled: false,
        model: "codex-sdk-agent",
      },
    },
    taskRouting: {
      findCandidate: {
        source: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        vibe: { provider: "openai", model: "gpt-5-4-mini", fallback: [] },
        throttling: {
          backgroundEnabled: true,
          interactiveWindowSeconds: 180,
          recentBlockSeconds: 30,
          minIntervalSeconds: 30,
          mediumIntervalSeconds: 90,
          busyIntervalSeconds: 180,
          maxIntervalSeconds: 300,
          rateLimitCooldownSeconds: 600,
          jitterSeconds: 10,
        },
      },
      webSourceResearch: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        fallback: ["azure-openai"],
      },
      coverEvidence: {
        sourceSupport: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          fallback: ["azure-openai"],
        },
        externalEvidence: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          fallback: ["azure-openai"],
        },
        mcpEvidence: {
          provider: "local-llm",
          model: "gemma-4-e4b-it",
          fallback: ["azure-openai"],
        },
      },
      finalizeDistille: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        fallback: ["azure-openai"],
      },
      deadZoneMergeReview: {
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        fallback: [],
      },
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
      findCandidateTimeoutMs: 600000,
      findCandidateMaxToolCalls: 8,
      coverEvidenceTimeoutMs: 600000,
      coverEvidenceSearchMaxCalls: 1,
      coverEvidenceFetchMaxCalls: 3,
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
      pipelineClaimLimit: 1,
      findingQueueTaskIntervalSeconds: 30,
      coveringQueueTaskIntervalSeconds: 10,
      continuousIdleSleepMs: 5000,
      continuousErrorSleepMs: 12000,
      inventoryRefreshIntervalMs: 30000,
      doctorFreshnessThresholdMinutes: 720,
      doctorDegradedRateThreshold: 0.5,
      doctorKnowledgeZeroUseWarningMinActiveCount: 10,
      codexLogSyncEnabled: true,
      antigravityLogSyncEnabled: true,
      claudeLogSyncEnabled: true,
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
    repositoryMocks.testAzureOpenAiDeployment.mockReset();
    repositoryMocks.testLocalLlmModel.mockReset();
    repositoryMocks.testRuntimeProvider.mockReset();

    repositoryMocks.fetchRuntimeSettings.mockResolvedValue(buildSnapshot());
    repositoryMocks.updateRuntimeSettings.mockResolvedValue(buildUpdateResponse());
    repositoryMocks.reloadRuntimeSettingsCache.mockResolvedValue({
      ok: true,
      reloadedAt: "2026-05-23T12:20:00.000Z",
    });
    repositoryMocks.testRuntimeProvider.mockImplementation(
      async (provider: RuntimeProviderName) => ({
        provider,
        health: {
          provider,
          configured: true,
          reachable: true,
          model: "gpt-5-4-mini",
          endpoint: "https://example.invalid",
        },
      }),
    );
    repositoryMocks.testAzureOpenAiDeployment.mockImplementation(
      async (deploymentIndex: number) => ({
        provider: "azure-openai",
        deployment: deploymentIndex + 1,
        health: {
          provider: "azure-openai",
          configured: true,
          reachable: true,
          model: `azure-deployment-${deploymentIndex + 1}`,
          endpoint: "https://example.invalid",
        },
      }),
    );
    repositoryMocks.testLocalLlmModel.mockImplementation(async (model: string) => ({
      provider: "local-llm",
      model,
      health: {
        provider: "local-llm",
        configured: true,
        reachable: true,
        model,
        endpoint: "http://127.0.0.1:44449",
      },
    }));
  });

  it("renders task-routing tab from URL and keeps tab links canonical", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByText("Find Candidate")).toBeInTheDocument();
    expect(screen.getByText("Cover Evidence")).toBeInTheDocument();
    expect(screen.getByText("Shared Distillation Runtime")).toBeInTheDocument();
    expect(screen.getByLabelText("Find Candidate LLM Timeout (seconds)")).toHaveValue(600);
    expect(screen.getByLabelText("Find Candidate Tool Calls")).toBeInTheDocument();
    expect(screen.getByLabelText("Finding Queue Task Interval (seconds)")).toHaveValue(30);
    expect(screen.getByLabelText("Covering Queue Task Interval (seconds)")).toHaveValue(10);
    expect(screen.getByLabelText("Cover Evidence Search Calls")).toBeInTheDocument();
    expect(screen.getByText("Agentic Compile")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Distillation Runtime" })).not.toBeInTheDocument();

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

  it("renders the task-routing screen for the legacy distillation-runtime settings URL", async () => {
    routerState.pathname = "/setting/distillation-runtime";
    renderPage();

    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Task Routing" })).toHaveClass("active");
    expect(screen.getByLabelText("Cover Evidence Fetch Calls")).toBeInTheDocument();
  });

  it("saves task-routing changes with provider-model sync and deduped fallback", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save Settings" });
    expect(saveButton).toBeDisabled();

    expect(screen.queryByText("findCandidate.source")).not.toBeInTheDocument();
    expect(screen.queryByText("findCandidate.vibe")).not.toBeInTheDocument();
    const sourceRow = screen.getByText("findCandidate").closest(".settings-route-row");
    expect(sourceRow).not.toBeNull();
    const rowScope = within(sourceRow as HTMLElement);

    fireEvent.change(rowScope.getByLabelText("Provider"), { target: { value: "azure-openai" } });
    fireEvent.change(rowScope.getByLabelText("Fallback 1"), { target: { value: "local-llm" } });
    expect(rowScope.getByLabelText("Local LLM API")).toBeInTheDocument();
    fireEvent.change(rowScope.getByLabelText("Local LLM API"), {
      target: { value: "qwen-3.6-14b-it" },
    });
    fireEvent.change(rowScope.getByLabelText("Fallback 2"), { target: { value: "local-llm" } });
    fireEvent.change(screen.getByLabelText("Find Candidate Tool Calls"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("Find Candidate LLM Timeout (seconds)"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Rate Limit Cooldown (sec)"), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getByLabelText("Cover Evidence Fetch Calls"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Finding Queue Task Interval (seconds)"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Covering Queue Task Interval (seconds)"), {
      target: { value: "10" },
    });

    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.updatedBy).toBe("admin-ui");
    expect(payload.settings.taskRouting.findCandidate.source).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
    });
    expect(payload.settings.taskRouting.findCandidate.vibe).toEqual({
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
    });
    expect(payload.settings.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds).toBe(
      120,
    );
    expect(payload.settings.distillationRuntime.findCandidateTimeoutMs).toBe(45_000);
    expect(payload.settings.distillationRuntime.findCandidateMaxToolCalls).toBe(6);
    expect(payload.settings.distillationRuntime.coverEvidenceFetchMaxCalls).toBe(2);
    expect(payload.settings.advanced.findingQueueTaskIntervalSeconds).toBe(45);
    expect(payload.settings.advanced.coveringQueueTaskIntervalSeconds).toBe(10);
  });

  it("edits Cover Evidence as one queue processing route", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    expect(screen.getByText("coverEvidence")).toBeInTheDocument();
    expect(screen.queryByText("coverEvidence.sourceSupport")).not.toBeInTheDocument();
    expect(screen.queryByText("coverEvidence.externalEvidence")).not.toBeInTheDocument();
    expect(screen.queryByText("coverEvidence.mcpEvidence")).not.toBeInTheDocument();

    const coverEvidenceRow = screen.getByText("coverEvidence").closest(".settings-route-row");
    expect(coverEvidenceRow).not.toBeNull();
    const rowScope = within(coverEvidenceRow as HTMLElement);
    fireEvent.change(rowScope.getByLabelText("Provider"), { target: { value: "azure-openai" } });
    fireEvent.change(rowScope.getByLabelText("Fallback 1"), { target: { value: "local-llm" } });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    const route = {
      provider: "azure-openai",
      model: "gpt-5-4-mini",
      localLlmModel: "gemma-4-e4b-it",
      fallback: ["local-llm"],
    };
    expect(payload.settings.taskRouting.coverEvidence.sourceSupport).toEqual(route);
    expect(payload.settings.taskRouting.coverEvidence.externalEvidence).toEqual(route);
    expect(payload.settings.taskRouting.coverEvidence.mcpEvidence).toEqual(route);
  });

  it("saves the Local LLM API selected for Agentic Compile fallback", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const agenticRow = screen.getByText("agenticCompile").closest(".settings-route-row");
    expect(agenticRow).not.toBeNull();
    const rowScope = within(agenticRow as HTMLElement);
    expect(rowScope.getByLabelText("Local LLM API")).toBeInTheDocument();
    fireEvent.change(rowScope.getByLabelText("Local LLM API"), {
      target: { value: "qwen-3.6-14b-it" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.taskRouting.agenticCompile).toMatchObject({
      provider: "openai",
      model: "gpt-5-4-mini",
      localLlmModel: "qwen-3.6-14b-it",
      fallback: ["local-llm"],
    });
  });

  it("calls provider health test for selected provider card", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "OpenAI" })).toBeInTheDocument();

    const testButtons = screen.getAllByRole("button", { name: "Test" });
    fireEvent.click(testButtons[0]);

    await waitFor(() => expect(repositoryMocks.testRuntimeProvider).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testRuntimeProvider).toHaveBeenCalledWith("openai");
  });

  it("calls Azure OpenAI deployment health test for selected deployment", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Azure OpenAI" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Test 2" }));

    await waitFor(() => expect(repositoryMocks.testAzureOpenAiDeployment).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testAzureOpenAiDeployment).toHaveBeenCalledWith(1);
  });

  it("calls Local LLM model health test for an added model", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByText("Qwen")).toBeInTheDocument();

    const qwenRow = screen.getByText("Qwen").closest(".settings-local-llm-model");
    expect(qwenRow).not.toBeNull();
    fireEvent.click(within(qwenRow as HTMLElement).getByRole("button", { name: "Test" }));

    await waitFor(() => expect(repositoryMocks.testLocalLlmModel).toHaveBeenCalledTimes(1));
    expect(repositoryMocks.testLocalLlmModel).toHaveBeenCalledWith("qwen-3.6-14b-it");
  });

  it("saves only complete added Local LLM model rows", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Local LLM" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Local LLM" }));
    const addedRows = screen.getAllByText("Local LLM 3");
    expect(addedRows.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["local-llm"].models).toEqual([
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        model: "qwen-3.6-14b-it",
      },
    ]);
  });

  it("includes a filled added Local LLM model row in the save payload", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Local LLM" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add Local LLM" }));
    const row = screen.getByText("Local LLM 3").closest(".settings-local-llm-model");
    expect(row).not.toBeNull();
    const rowScope = within(row as HTMLElement);
    fireEvent.change(rowScope.getByLabelText("Name"), { target: { value: "Reasoner" } });
    fireEvent.change(rowScope.getByLabelText("API Base URL"), {
      target: { value: "http://127.0.0.1:44450" },
    });
    fireEvent.change(rowScope.getByLabelText("Model"), {
      target: { value: "local-reasoner" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["local-llm"].models).toContainEqual({
      name: "Reasoner",
      apiBaseUrl: "http://127.0.0.1:44450",
      model: "local-reasoner",
    });
  });

  it("shows added Local LLM models in Task Routing and Agentic Compile model choices", async () => {
    routerState.pathname = "/setting/taskrouting";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Task Routing" })).toBeInTheDocument();

    const webResearchRow = screen.getByText("webSourceResearch").closest(".settings-route-row");
    expect(webResearchRow).not.toBeNull();
    expect(
      within(webResearchRow as HTMLElement).getByRole("option", {
        name: /qwen-3\.6-14b-it/,
      }),
    ).toBeInTheDocument();

    const agenticProvider = screen.getAllByLabelText("Provider").at(-1);
    expect(agenticProvider).toBeDefined();
    fireEvent.change(agenticProvider as HTMLElement, { target: { value: "local-llm" } });

    const agenticRow = screen.getByText("agenticCompile").closest(".settings-route-row");
    expect(agenticRow).not.toBeNull();
    expect(
      within(agenticRow as HTMLElement).getByRole("option", {
        name: /qwen-3\.6-14b-it/,
      }),
    ).toBeInTheDocument();
  });

  it("saves up to three Azure OpenAI deployments and separate API keys", async () => {
    routerState.pathname = "/setting/llmprovider";
    renderPage();
    expect(await screen.findByRole("heading", { name: "Azure OpenAI" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Deployment 2 Endpoint"), {
      target: { value: "https://second.openai.azure.com" },
    });
    fireEvent.change(screen.getByLabelText("Deployment 2 Model"), {
      target: { value: "gpt-5-4-mini-secondary" },
    });
    fireEvent.change(screen.getByLabelText("API Key 2 value"), {
      target: { value: "second-secret" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.providers["azure-openai"].deployments).toHaveLength(3);
    expect(payload.settings.providers["azure-openai"].deployments[1]).toMatchObject({
      apiBaseUrl: "https://second.openai.azure.com",
      model: "gpt-5-4-mini-secondary",
    });
    expect(payload.secrets.azureOpenAiApiKey2).toEqual({ value: "second-secret" });
  });

  it("renders Advanced sync settings and allows toggling them", async () => {
    routerState.pathname = "/setting/advanced";
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Advanced Runtime Controls" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent Log Synchronization" })).toBeInTheDocument();
    expect(screen.getByLabelText("Continuous Idle Sleep (seconds)")).toHaveValue(5);
    expect(
      screen.queryByLabelText("Finding Queue Task Interval (seconds)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Covering Queue Task Interval (seconds)"),
    ).not.toBeInTheDocument();

    const codexCheckbox = screen.getByLabelText("Enable Codex (Cursor) Log Sync");
    const antigravityCheckbox = screen.getByLabelText("Enable Antigravity Log Sync");
    const claudeCheckbox = screen.getByLabelText("Enable Claude Code Log Sync");

    expect(codexCheckbox).toBeChecked();
    expect(antigravityCheckbox).toBeChecked();
    expect(claudeCheckbox).toBeChecked();

    fireEvent.click(claudeCheckbox);
    expect(claudeCheckbox).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Continuous Idle Sleep (seconds)"), {
      target: { value: "7.5" },
    });
    const saveButton = screen.getByRole("button", { name: "Save Settings" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(repositoryMocks.updateRuntimeSettings).toHaveBeenCalledTimes(1));
    const payload = repositoryMocks.updateRuntimeSettings.mock.calls[0]?.[0];
    expect(payload.settings.advanced.claudeLogSyncEnabled).toBe(false);
    expect(payload.settings.advanced.continuousIdleSleepMs).toBe(7500);
  });
});
