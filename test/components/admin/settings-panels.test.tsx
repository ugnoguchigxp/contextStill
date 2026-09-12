/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react";
import React, { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdvancedSettingsPanel } from "../../../web/src/modules/admin/components/settings/advanced-settings-panel";
import { CodexActionGuide } from "../../../web/src/modules/admin/components/settings/codex-action-guide";
import { EmbeddingSettingsPanel } from "../../../web/src/modules/admin/components/settings/embedding-settings-panel";
import { GeneralSettingsPanel } from "../../../web/src/modules/admin/components/settings/general-settings-panel";
import { SearchSettingsPanel } from "../../../web/src/modules/admin/components/settings/search-settings-panel";
import type { SettingsController } from "../../../web/src/modules/admin/components/settings/use-settings-controller";
import type {
  RuntimeSecretStatus,
  RuntimeSettingsEditable,
  RuntimeSettingsView,
} from "../../../web/src/modules/admin/repositories/admin.repository";

const secret = (configured: boolean): RuntimeSecretStatus => ({
  configured,
  source: configured ? "env" : "none",
  maskedValue: configured ? "sk****ey" : null,
  updatedAt: configured ? "2026-05-23T12:00:00.000Z" : null,
});

function buildDraft(): RuntimeSettingsEditable {
  return {
    general: {
      distillationPriority: {
        targetPriorityOrder: ["knowledge_candidate", "web_ingest", "wiki_file", "vibe_memory"],
      },
    },
    search: {
      providerOrder: ["brave", "exa", "duckduckgo"],
      maxProviderAttempts: 2,
      resultCount: 8,
      timeoutMs: 10000,
      rateLimitCooldownSeconds: 3600,
      providers: {
        brave: { enabled: true },
        exa: { enabled: false },
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
      coverEvidenceSearchMaxCalls: 3,
      coverEvidenceFetchMaxCalls: 5,
      coverEvidenceFetchMaxTokensPerSite: 3000,
      toolTimeoutMs: 10000,
      toolResultMaxChars: 12000,
      failureRetryDelaySeconds: 90,
      readerMaxReads: 12,
      readerMaxCharsPerRead: 12000,
      llmContextWindowTokens: 128000,
      llmMaxInputTokens: 80000,
      llmInputSafetyMarginTokens: 4096,
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
      antigravityLogSyncEnabled: false,
      claudeLogSyncEnabled: true,
    },
  } as RuntimeSettingsEditable;
}

function buildSourceView(draft: RuntimeSettingsEditable): RuntimeSettingsView {
  return {
    ...draft,
    search: {
      ...draft.search,
      providers: {
        brave: { enabled: draft.search.providers.brave.enabled, apiKeySecret: secret(true) },
        exa: { enabled: draft.search.providers.exa.enabled, apiKeySecret: secret(false) },
        duckduckgo: { enabled: draft.search.providers.duckduckgo.enabled },
      },
    },
  } as RuntimeSettingsView;
}

function StatefulPanels() {
  const [draft, setDraft] = useState<RuntimeSettingsEditable>(buildDraft());
  const patchDraft: SettingsController["patchDraft"] = (next) => {
    setDraft((current) => next(current));
  };
  const sourceView = buildSourceView(draft);
  return (
    <>
      <GeneralSettingsPanel
        draft={draft}
        movePriorityTargetKind={(kind, direction) => {
          patchDraft((current) => {
            const order = [...current.general.distillationPriority.targetPriorityOrder];
            const index = order.indexOf(kind);
            const nextIndex = index + direction;
            const swap = order[nextIndex];
            if (index < 0 || nextIndex < 0 || nextIndex >= order.length || !swap) return current;
            order[nextIndex] = order[index];
            order[index] = swap;
            return {
              ...current,
              general: {
                ...current.general,
                distillationPriority: { targetPriorityOrder: order },
              },
            };
          });
        }}
        setSaveError={() => undefined}
        setSaveMessage={() => undefined}
      />
      <SearchSettingsPanel
        draft={draft}
        patchDraft={patchDraft}
        moveSearchProvider={(provider, direction) => {
          patchDraft((current) => {
            const order = [...current.search.providerOrder];
            const index = order.indexOf(provider);
            const nextIndex = index + direction;
            const swap = order[nextIndex];
            if (index < 0 || nextIndex < 0 || nextIndex >= order.length || !swap) return current;
            order[nextIndex] = order[index];
            order[index] = swap;
            return { ...current, search: { ...current.search, providerOrder: order } };
          });
        }}
        renderSecretEditor={(key, label) => <div>{`${label}:${key}`}</div>}
        sourceView={sourceView}
      />
      <EmbeddingSettingsPanel draft={draft} patchDraft={patchDraft} />
      <AdvancedSettingsPanel
        draft={draft}
        patchDraft={patchDraft}
        renderDistillationRuntimeNumberField={({ label, settingKey }) => (
          <label className="settings-field">
            <span>{label}</span>
            <input
              type="number"
              aria-label={label}
              value={Number(draft.distillationRuntime[settingKey])}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  distillationRuntime: {
                    ...current.distillationRuntime,
                    [settingKey]: Number(event.target.value),
                  },
                }))
              }
            />
          </label>
        )}
      />
      <p data-testid="draft-summary">
        {draft.general.distillationPriority.targetPriorityOrder[0]}|{draft.search.providerOrder[0]}|
        {draft.search.providers.brave.enabled ? "brave-on" : "brave-off"}|{draft.embedding.provider}
        |{draft.advanced.pipelineLockStaleSeconds}|
        {draft.advanced.codexLogSyncEnabled ? "codex-on" : "codex-off"}
      </p>
    </>
  );
}

describe("settings panels", () => {
  it("renders nothing when draft is missing", () => {
    const { container } = render(
      <>
        <GeneralSettingsPanel
          draft={null as never}
          movePriorityTargetKind={vi.fn()}
          setSaveError={vi.fn()}
          setSaveMessage={vi.fn()}
        />
        <SearchSettingsPanel
          draft={null as never}
          patchDraft={vi.fn()}
          moveSearchProvider={vi.fn()}
          renderSecretEditor={vi.fn()}
          sourceView={null as never}
        />
        <EmbeddingSettingsPanel draft={null as never} patchDraft={vi.fn()} />
        <AdvancedSettingsPanel
          draft={null as never}
          patchDraft={vi.fn()}
          renderDistillationRuntimeNumberField={vi.fn()}
        />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("clicks and toggles general, search, embedding, and advanced fields", () => {
    render(<StatefulPanels />);

    const generalRow = screen.getByText("wiki_file").closest(".rounded-md") as HTMLElement;
    fireEvent.click(within(generalRow).getAllByRole("button")[0]);

    fireEvent.click(screen.getByLabelText("brave enabled"));
    fireEvent.change(screen.getByLabelText("Max Provider Attempts"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "disabled" } });
    fireEvent.change(screen.getByLabelText("Pipeline Lock Stale (sec)"), {
      target: { value: "90" },
    });
    fireEvent.change(screen.getByLabelText("Lock TTL (sec)"), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText("Pipeline Loop Claim Limit"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByLabelText("Continuous Error Sleep (seconds)"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("Inventory Refresh Interval (seconds)"), {
      target: { value: "9" },
    });
    fireEvent.change(screen.getByLabelText("Doctor Freshness Threshold (min)"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Doctor Degraded Rate Threshold"), {
      target: { value: "0.2" },
    });
    fireEvent.change(screen.getByLabelText("Doctor Zero-use Warning Min Active Count"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByLabelText("Enable Codex (Cursor) Log Sync"));
    fireEvent.click(screen.getByLabelText("Enable Antigravity Log Sync"));
    fireEvent.change(screen.getByLabelText("LLM Context Window Tokens"), {
      target: { value: "64000" },
    });

    expect(screen.getByTestId("draft-summary")).toHaveTextContent("knowledge_candidate");
    expect(screen.getByTestId("draft-summary")).toHaveTextContent("brave-off");
    expect(screen.getByTestId("draft-summary")).toHaveTextContent("disabled");
    expect(screen.getByTestId("draft-summary")).toHaveTextContent("90");
    expect(screen.getByTestId("draft-summary")).toHaveTextContent("codex-off");
    expect(screen.getByText("Brave API Key:braveApiKey")).toBeInTheDocument();
    expect(screen.getByText("Exa API Key:exaApiKey")).toBeInTheDocument();
  });
});

describe("CodexActionGuide", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("refreshes when Codex is ready", () => {
    const onRefresh = vi.fn();
    render(
      <CodexActionGuide
        recommendedAction="ready"
        isExpired={false}
        loginCommand={null}
        onGetCommand={vi.fn()}
        isPending={false}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("copies the install command", () => {
    render(
      <CodexActionGuide
        recommendedAction="install-codex-cli"
        isExpired={false}
        loginCommand={null}
        onGetCommand={vi.fn()}
        isPending={false}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npm install -g @openai/codex");
  });

  it("requests a login command while pending and copies it afterwards", async () => {
    const onGetCommand = vi.fn();
    const onRefresh = vi.fn();
    const { rerender } = render(
      <CodexActionGuide
        recommendedAction="run-codex-login"
        isExpired={false}
        loginCommand={null}
        onGetCommand={onGetCommand}
        isPending
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();

    rerender(
      <CodexActionGuide
        recommendedAction="set-codex-access-token"
        isExpired
        loginCommand="codex login --device"
        onGetCommand={onGetCommand}
        isPending={false}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText("Re-authenticate by running in your terminal:")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied!" });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("codex login --device");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to codex login when copying without a command", async () => {
    const onGetCommand = vi.fn();
    render(
      <CodexActionGuide
        recommendedAction="run-codex-login"
        isExpired={false}
        loginCommand={null}
        onGetCommand={onGetCommand}
        isPending={false}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get Login Command" }));
    expect(onGetCommand).toHaveBeenCalledTimes(1);
  });
});
