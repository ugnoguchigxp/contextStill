import { expect, test } from "vitest";
import { routeClaimGroupId } from "../src/modules/queue/core/scheduler";
import { routeWithProviderPool } from "../web/src/modules/admin/components/settings/settings-routing";

test("selecting a pool clears fixed models and uses the pool with auto routing", () => {
  const route = routeWithProviderPool(
    { provider: "local-llm", model: "qwen", localLlmModel: "qwen", fallback: ["codex"] },
    "shared",
  );
  expect(route).toEqual({ provider: "auto", providerPoolId: "shared", fallback: [] });
  expect(routeClaimGroupId(route)).toBe("shared");
  expect(routeClaimGroupId({ provider: "auto", fallback: [] })).toBeNull();
});
