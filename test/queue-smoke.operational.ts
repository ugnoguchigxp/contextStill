import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { getDb } from "../src/db/index.js";
import {
  coveringEvidenceQueue,
  distillationQueueEvents,
  findingCandidateQueue,
  foundCandidates,
} from "../src/db/schema.js";
import { enqueueFindingJob, runQueueWorkerOnce } from "../src/modules/queue/core/index.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("queue operational smoke", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("moves a provided candidate from finding queue to covering queue", async () => {
    const queued = await enqueueFindingJob({
      inputKind: "provided_candidate",
      sourceKind: "knowledge_candidate",
      sourceKey: "queue-smoke-candidate",
      sourceUri: "memory://queue-smoke-candidate",
      priority: 91,
      payload: {
        type: "procedure",
        title: "Verify queue smoke transitions",
        body: [
          "Use when:",
          "- Checking queue operational smoke",
          "",
          "Workflow:",
          "1. Enqueue a provided candidate",
          "2. Run one finding queue worker",
          "",
          "Verification:",
          "- The candidate reaches covering queue",
          "",
          "Avoid:",
          "- Calling external providers from this smoke test",
        ].join("\n"),
        sourceSummary: "queue smoke fixture",
      },
      metadata: {
        smoke: true,
      },
    });

    expect(queued?.status).toBe("pending");

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "queue-smoke-test",
    });

    expect(result).toMatchObject({
      ok: true,
      idle: false,
      claimedJobId: queued?.id,
      completedJobId: queued?.id,
      message: "processed job",
    });

    const db = getDb();
    const [findingJob] = await db
      .select()
      .from(findingCandidateQueue)
      .where(eq(findingCandidateQueue.id, queued?.id ?? ""));
    expect(findingJob).toMatchObject({
      status: "completed",
      lastOutcomeKind: "provided_candidate_registered",
      lockedBy: null,
    });
    expect(findingJob.completedAt).toBeInstanceOf(Date);

    const [foundCandidate] = await db
      .select()
      .from(foundCandidates)
      .where(eq(foundCandidates.findingJobId, findingJob.id));
    expect(foundCandidate).toMatchObject({
      candidateIndex: 0,
      title: "Verify queue smoke transitions",
      type: "procedure",
      sourceSummary: "queue smoke fixture",
    });

    const [coveringJob] = await db
      .select()
      .from(coveringEvidenceQueue)
      .where(eq(coveringEvidenceQueue.foundCandidateId, foundCandidate.id));
    expect(coveringJob).toMatchObject({
      status: "pending",
      priority: 91,
      providerPolicy: "default",
    });

    const events = await db
      .select({
        eventType: distillationQueueEvents.eventType,
        message: distillationQueueEvents.message,
      })
      .from(distillationQueueEvents)
      .where(eq(distillationQueueEvents.queueJobId, findingJob.id));

    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["enqueued", "claimed", "completed"]),
    );
    expect(
      events.some((event) => event.message === "provided candidate moved to covering queue"),
    ).toBe(true);
  });
});
