import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextDistillationTargetState,
  upsertDistillationTargetState,
} from "../src/modules/selectDistillationTarget/repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("selectDistillationTarget repository", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  it("upserts a distillation target state correctly", async () => {
    const candidate = {
      targetKind: "wiki_file" as const,
      targetKey: "test/key.md",
      sourceUri: "/wiki/test/key.md",
      sortKey: "key",
    };

    const state = await upsertDistillationTargetState({ candidate });

    expect(state).toBeDefined();
    expect(state.targetKey).toBe("test/key.md");
    expect(state.status).toBe("pending");
  });

  it("claims a pending distillation target", async () => {
    const candidate = {
      targetKind: "wiki_file" as const,
      targetKey: "test/claim.md",
      sourceUri: "/wiki/test/claim.md",
      sortKey: "claim",
    };
    await upsertDistillationTargetState({ candidate });

    const claimed = await claimNextDistillationTargetState({ worker: "test-worker" });

    expect(claimed).toBeDefined();
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockedBy).toBe("test-worker");
  });
});
