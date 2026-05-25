import { describe, expect, test } from "vitest";
import type { RuntimeSettingsRoute } from "../src/modules/settings/settings.types.js";
import {
  CoverEvidenceProviderPolicyError,
  resolveCloudApiRuntimeRoute,
  resolveCoverEvidenceRouteByPolicy,
} from "../src/modules/coverEvidence/provider-policy.js";

function runtimeRoute(
  provider: RuntimeSettingsRoute["provider"],
  fallback: RuntimeSettingsRoute["fallback"],
): RuntimeSettingsRoute {
  return { provider, fallback };
}

describe("coverEvidence provider policy", () => {
  test("keeps only cloud providers from primary and fallback", () => {
    const route = resolveCloudApiRuntimeRoute(runtimeRoute("local-llm", ["azure-openai"]));
    expect(route).toEqual({
      provider: "azure-openai",
      fallback: [],
    });
  });

  test("preserves cloud fallback order after filtering local providers", () => {
    const route = resolveCloudApiRuntimeRoute(
      runtimeRoute("local-llm", ["openai", "bedrock", "openai"]),
    );
    expect(route).toEqual({
      provider: "openai",
      fallback: ["bedrock"],
    });
  });

  test("throws when no cloud providers are available", () => {
    expect(() =>
      resolveCloudApiRuntimeRoute(runtimeRoute("local-llm", []), { routeName: "sourceSupport" }),
    ).toThrowError(CoverEvidenceProviderPolicyError);
  });

  test("excludes auto from cloud candidates", () => {
    const route = resolveCloudApiRuntimeRoute(runtimeRoute("auto", ["local-llm", "openai"]));
    expect(route).toEqual({
      provider: "openai",
      fallback: [],
    });
  });

  test("returns unchanged route when policy is default", () => {
    const input = runtimeRoute("local-llm", ["openai"]);
    const route = resolveCoverEvidenceRouteByPolicy({
      route: input,
      policy: "default",
      routeName: "sourceSupport",
    });
    expect(route).toBe(input);
  });
});
