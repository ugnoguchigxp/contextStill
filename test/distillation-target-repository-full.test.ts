import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
import { distillationTargetStates } from "../src/db/schema.js";
import { releaseRetryablePausedDistillationTargets } from "../src/modules/distillationTarget/repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("distillationTarget repository full coverage", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  it.skip("releases retryable paused targets and sets status to pending", async () => {
    const now = new Date();
    await db.insert(distillationTargetStates).values({
      targetKind: "wiki_file",
      targetKey: "p1",
      sourceUri: "u1",
      distillationVersion: "v1",
      status: "paused",
      nextRetryAt: new Date(now.getTime() - 60000),
      priorityGroup: "wiki",
      sortKey: "k1",
    });

    const count = await releaseRetryablePausedDistillationTargets({
      distillationVersion: "v1",
      now,
    });
    expect(count).toBe(1);

    const updated = await db
      .select()
      .from(distillationTargetStates)
      .where(eq(distillationTargetStates.targetKey, "p1"))
      .execute();
    expect(updated[0].status).toBe("pending");
  });
});
