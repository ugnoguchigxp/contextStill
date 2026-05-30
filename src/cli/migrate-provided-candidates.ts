import { eq, and } from "drizzle-orm";
import { db, closeDbPool } from "../db/index.js";
import { findingCandidateQueue, foundCandidates, coveringEvidenceQueue } from "../db/schema.js";
import { appendQueueEvent } from "../modules/queue/core/events.js";

async function main() {
  console.log("Starting migration of pending provided candidates from finding to covering...");

  // 1. Fetch all pending provided_candidate jobs
  const pendingJobs = await db
    .select()
    .from(findingCandidateQueue)
    .where(
      and(
        eq(findingCandidateQueue.inputKind, "provided_candidate"),
        eq(findingCandidateQueue.status, "pending"),
      ),
    );

  console.log(`Found ${pendingJobs.length} pending provided_candidate jobs.`);

  let migratedCount = 0;

  for (const job of pendingJobs) {
    const payload = job.payload as any;
    if (!payload || !payload.title || !payload.body) {
      console.warn(`Job ${job.id} has invalid payload. Skipping.`, payload);
      continue;
    }

    const now = new Date();

    const result = await db.transaction(async (tx) => {
      // 1. Upsert found candidate
      const origin = payload.origin ?? {};
      const candidateMetadata = {
        sourceKind: job.sourceKind,
        sourceKey: job.sourceKey,
        sourceUri: job.sourceUri,
      };

      const [foundCandidate] = await tx
        .insert(foundCandidates)
        .values({
          findingJobId: job.id,
          candidateIndex: 0,
          type: payload.type ?? "rule",
          title: payload.title,
          content: payload.body,
          origin,
          metadata: candidateMetadata,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [foundCandidates.findingJobId, foundCandidates.candidateIndex],
          set: {
            type: payload.type ?? "rule",
            title: payload.title,
            content: payload.body,
            origin,
            metadata: candidateMetadata,
            updatedAt: now,
          },
        })
        .returning();

      if (!foundCandidate)
        throw new Error(`failed to create/upsert found candidate for job ${job.id}`);

      // 2. Upsert covering job
      const [coveringJob] = await tx
        .insert(coveringEvidenceQueue)
        .values({
          foundCandidateId: foundCandidate.id,
          distillationVersion: job.distillationVersion,
          status: "pending",
          priority: 90,
          providerPolicy: "default",
          payload: {},
          metadata: {},
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: coveringEvidenceQueue.foundCandidateId,
          set: {
            status: "pending",
            priority: 90,
            completedAt: null,
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            lastError: null,
            lastOutcomeKind: null,
            updatedAt: now,
          },
        })
        .returning();

      if (!coveringJob) throw new Error(`failed to create covering job for job ${job.id}`);

      // 3. Mark finding job as completed
      await tx
        .update(findingCandidateQueue)
        .set({
          status: "completed",
          completedAt: now,
          lastOutcomeKind: "provided_candidate_registered",
          updatedAt: now,
        })
        .where(eq(findingCandidateQueue.id, job.id));

      return { foundCandidate, coveringJob };
    });

    console.log(`Migrated job ${job.id}: enqueued covering job ${result.coveringJob.id}`);
    migratedCount++;

    // 4. Record queue events (out of transaction)
    try {
      await appendQueueEvent({
        queueName: "findingCandidate",
        queueJobId: job.id,
        eventType: "completed",
        message: "provided candidate registered synchronously (finding skipped by migration)",
        metadata: {
          sourceKind: job.sourceKind,
          sourceKey: job.sourceKey,
          inputKind: "provided_candidate",
          foundCandidateId: result.foundCandidate.id,
        },
      });

      await appendQueueEvent({
        queueName: "coveringEvidence",
        queueJobId: result.coveringJob.id,
        eventType: "enqueued",
        message: "covering job enqueued from migration",
        metadata: {
          foundCandidateId: result.foundCandidate.id,
          findingJobId: job.id,
        },
      });
    } catch (e) {
      console.warn("Failed to append event log:", e);
    }
  }

  console.log(`Successfully migrated ${migratedCount} jobs from finding to covering!`);
}

main()
  .catch((error) => {
    console.error("Migration failed with error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
