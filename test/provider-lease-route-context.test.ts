import { describe, expect, test } from "vitest";
import {
  applyProviderLeaseRouteContext,
  runWithProviderLeaseRouteContext,
} from "../src/modules/settings/provider-lease-route-context.js";
import { cloneDefaultSettings } from "../src/modules/settings/settings.defaults.js";

describe("provider lease route context", () => {
  test("fails closed when a TypeScript worker receives a LARM pool target", async () => {
    const settings = cloneDefaultSettings();
    settings.providers["larm-agent-connection"] = {
      enabled: true,
      connections: [
        {
          id: "contextstill-background",
          controlBaseUrl: "http://gnosis.local:9810",
          agentProfile: "contextstill-background",
          audience: "saaa-desktop",
          availabilityPollMs: 5_000,
          availabilityTimeoutMs: 2_000,
          controlTimeoutMs: 5_000,
          readyTimeoutMs: 180_000,
          ttlSeconds: 900,
          requestTimeoutMs: 300_000,
        },
      ],
    };
    settings.providerPools = [
      {
        id: "dynamic-pool",
        label: "Dynamic pool",
        targets: [
          {
            provider: "larm-agent-connection",
            connectionId: "contextstill-background",
          },
        ],
        maxConcurrent: 1,
        staleLeaseSeconds: 120,
        enabled: true,
        lowPriorityAgingSeconds: 1800,
      },
    ];
    const route = {
      provider: "local-llm" as const,
      providerPoolId: "dynamic-pool",
      fallback: [],
    };

    await runWithProviderLeaseRouteContext(
      {
        poolId: "dynamic-pool",
        targetId: "contextstill-background",
      },
      async () => {
        expect(() => applyProviderLeaseRouteContext(settings, route)).toThrow(
          "dynamic_provider_requires_rust_resident: contextstill-background",
        );
      },
    );
  });
});

test("mixed pool Codex target overrides a Qwen route model and clears fallback", async () => {
  const settings = cloneDefaultSettings();
  settings.providers.codex.model = "gpt-5.4-mini";
  settings.providerPools = [
    {
      id: "mixed",
      label: "mixed",
      enabled: true,
      maxConcurrent: 3,
      staleLeaseSeconds: 120,
      lowPriorityAgingSeconds: 1800,
      targets: [{ provider: "codex", targetId: "spark", model: "gpt-5.3-codex-spark" }],
    },
  ];
  await runWithProviderLeaseRouteContext({ poolId: "mixed", targetId: "spark" }, async () => {
    expect(
      applyProviderLeaseRouteContext(settings, {
        provider: "auto",
        model: "qwen",
        localLlmModel: "qwen",
        providerPoolId: "mixed",
        fallback: ["codex"],
      }),
    ).toMatchObject({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      localLlmModel: undefined,
      fallback: [],
    });
  });
});
