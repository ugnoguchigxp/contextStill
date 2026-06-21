import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backendKind: "sqlite" as "sqlite" | "postgres",
  settings: {
    providerPools: [
      {
        id: "local-llm-default",
        label: "Local LLM",
        enabled: true,
        maxConcurrent: 2,
        staleLeaseSeconds: 120,
        lowPriorityAgingSeconds: 1800,
        targets: [
          { provider: "local-llm" as const, localLlmModelId: "local-a" },
          { provider: "local-llm" as const, localLlmModelId: "local-b" },
        ],
      },
    ],
    taskRouting: {
      findCandidate: {
        source: { provider: "local-llm", providerPoolId: "local-llm-default", fallback: [] },
        vibe: { provider: "local-llm", providerPoolId: "local-llm-default", fallback: [] },
      },
      webSourceResearch: { provider: "local-llm", fallback: [] },
      episodeDistiller: {
        provider: "local-llm",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
      coverEvidence: {
        sourceSupport: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          fallback: [],
        },
        externalEvidence: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          fallback: [],
        },
        mcpEvidence: {
          provider: "local-llm",
          providerPoolId: "local-llm-default",
          fallback: [],
        },
      },
      deadZoneMergeReview: { provider: "local-llm", fallback: [] },
      finalizeDistille: {
        provider: "local-llm",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
      mergeActivationFinalize: {
        provider: "local-llm",
        providerPoolId: "local-llm-default",
        fallback: [],
      },
    },
  },
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  getRuntimeSettingsSnapshot: () => mocks.settings,
  resolveProviderPools: () => mocks.settings.providerPools,
}));

describe("provider pool scheduler", () => {
  beforeEach(() => {
    mocks.backendKind = "sqlite";
  });

  test("uses enabled provider pools on SQLite", async () => {
    const { enabledProviderPoolsForQueues, unpooledQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["findingCandidate"])).toHaveLength(1);
    expect(unpooledQueues(["findingCandidate", "deadZoneMergeReview"])).toEqual([
      "deadZoneMergeReview",
    ]);
  });

  test("falls back to legacy unpooled queue execution outside SQLite", async () => {
    mocks.backendKind = "postgres";
    const { enabledProviderPoolsForQueues, unpooledQueues } = await import(
      "../src/modules/queue/core/scheduler.js"
    );

    expect(enabledProviderPoolsForQueues(["findingCandidate"])).toEqual([]);
    expect(unpooledQueues(["findingCandidate", "coveringEvidence"])).toEqual([
      "findingCandidate",
      "coveringEvidence",
    ]);
  });
});
