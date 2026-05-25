import { closeDbPool } from "../db/index.js";
import { buildLandscapeReplayComparison } from "../modules/landscape/landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "../modules/landscape/landscape-replay.service.js";
import { createLandscapeReviewCandidates } from "../modules/landscape/landscape-review-candidate.service.js";
import {
  listLandscapeReviewItems,
  materializeLandscapeReviewItems,
} from "../modules/landscape/landscape-review-items.service.js";
import {
  clearLandscapeSnapshotCache,
  getLandscapeSnapshotCacheStatus,
  isLandscapeSnapshotCacheEnabled,
  purgeLandscapeSnapshotCache,
} from "../modules/landscape/landscape-snapshot-cache.service.js";
import { buildLandscapeTrajectory } from "../modules/landscape/landscape-trajectory.service.js";
import { buildLandscapeSnapshot } from "../modules/landscape/landscape.service.js";
import { parseArgs } from "./landscape-options.js";
import {
  buildContradictionDryRunSummary,
  printContradictionDryRunSummary,
  printQueueCreateCandidatesSummary,
  printQueueListSummary,
  printQueueMaterializeSummary,
  printReplayComparisonSummary,
  printReplaySummary,
  printSnapshotCacheStatus,
  printSummary,
  printTrajectorySummary,
  queueStatusForCandidateCreation,
  warmupLandscapeSnapshotCache,
} from "./landscape-output.js";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.snapshotCacheStatus) {
    const status = await getLandscapeSnapshotCacheStatus();
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    printSnapshotCacheStatus(status);
    return;
  }

  if (options.snapshotCacheRefresh) {
    const cacheEnabled = isLandscapeSnapshotCacheEnabled();
    const deletedCount = await clearLandscapeSnapshotCache({
      snapshotTypes: options.snapshotCacheTypes,
    });
    const warmedTypes =
      options.snapshotCacheWarmup && cacheEnabled
        ? await warmupLandscapeSnapshotCache(options.snapshotCacheTypes, options)
        : [];
    const status = await getLandscapeSnapshotCacheStatus();
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            refreshedAt: new Date().toISOString(),
            cacheEnabled,
            deletedCount,
            requestedTypes: options.snapshotCacheTypes,
            warmupRequested: options.snapshotCacheWarmup,
            warmedTypes,
            cacheStatus: status,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`Landscape Snapshot Cache refresh deleted rows=${deletedCount}`);
    console.log(`Cache enabled: ${cacheEnabled}`);
    printSnapshotCacheStatus(status);
    return;
  }

  if (options.snapshotCachePurge) {
    const purge = await purgeLandscapeSnapshotCache({
      snapshotTypes: options.snapshotCacheTypes,
    });
    const status = await getLandscapeSnapshotCacheStatus();
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            purgedAt: purge.purgedAt,
            requestedTypes: purge.requestedSnapshotTypes,
            staleDeletedCount: purge.staleDeletedCount,
            expiredDeletedCount: purge.expiredDeletedCount,
            deletedCount: purge.deletedCount,
            bySnapshotType: purge.bySnapshotType,
            error: purge.error,
            cacheStatus: status,
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      `Landscape Snapshot Cache purge deleted=${purge.deletedCount} stale=${purge.staleDeletedCount} expired=${purge.expiredDeletedCount}`,
    );
    printSnapshotCacheStatus(status);
    return;
  }

  if (options.trajectoryRunId) {
    const trajectory = await buildLandscapeTrajectory({
      runId: options.trajectoryRunId,
      includeCandidates: options.trajectoryIncludeCandidates,
      limit: options.trajectoryLimit,
    });
    if (!trajectory) throw new Error(`trajectory run not found: ${options.trajectoryRunId}`);
    if (options.json) {
      console.log(JSON.stringify(trajectory, null, 2));
      return;
    }
    printTrajectorySummary(trajectory);
    return;
  }

  if (options.queueList) {
    const result = await listLandscapeReviewItems({
      status: options.queueStatus,
      source: "all",
      reason: "all",
      proposedAction: "all",
      priorityMin: 0,
      limit: options.queueLimit,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printQueueListSummary(result);
    return;
  }

  if (options.queueCreateCandidates) {
    const result = await createLandscapeReviewCandidates({
      status: queueStatusForCandidateCreation(options.queueStatus),
      limit: options.queueLimit,
      dryRun: options.queueDryRun,
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printQueueCreateCandidatesSummary(result);
    return;
  }

  if (options.queue || options.queueDryRun) {
    const result = await materializeLandscapeReviewItems({
      dryRun: options.queueDryRun || !options.queue,
      windowDays: options.windowDays,
      limit: options.limit,
      runStatus: options.runStatus,
      currentLimit: options.currentLimit,
      landscapeLimit: options.landscapeLimit,
      landscapeStatus: options.landscapeStatus,
      relationAxes: options.relationAxes,
      minSelectedCount: options.minSelectedCount,
      minFeedbackCount: options.minFeedbackCount,
      minSimilarity: options.minSimilarity,
      semanticTopK: options.semanticTopK,
      sources: options.queueSources,
      materializeLimit: options.queueLimit,
    });
    const contradictionSummary = buildContradictionDryRunSummary(result);
    if (options.json) {
      console.log(
        JSON.stringify({ ...result, contradictionDryRunSummary: contradictionSummary }, null, 2),
      );
      return;
    }
    printQueueMaterializeSummary(result);
    printContradictionDryRunSummary(contradictionSummary);
    return;
  }

  if (options.replayCompare) {
    const comparison = await buildLandscapeReplayComparison({
      windowDays: options.windowDays,
      limit: options.limit,
      runStatus: options.runStatus,
      currentLimit: options.currentLimit,
      includeRuns: true,
    });
    if (options.json) {
      console.log(JSON.stringify(comparison, null, 2));
      return;
    }
    printReplayComparisonSummary(comparison);
    return;
  }

  if (options.replay) {
    const snapshot = await buildLandscapeReplaySnapshot({
      windowDays: options.windowDays,
      limit: options.limit,
      landscapeLimit: options.landscapeLimit,
      runStatus: options.runStatus,
      landscapeStatus: options.landscapeStatus,
      relationAxes: options.relationAxes,
      minSelectedCount: options.minSelectedCount,
      minFeedbackCount: options.minFeedbackCount,
      minSimilarity: options.minSimilarity,
      semanticTopK: options.semanticTopK,
      includeRuns: !options.compareCommunities,
    });
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    printReplaySummary(snapshot);
    return;
  }

  const snapshot = await buildLandscapeSnapshot({
    windowDays: options.windowDays,
    limit: options.limit,
    status: options.status,
    relationAxes: options.relationAxes,
    minSelectedCount: options.minSelectedCount,
    minFeedbackCount: options.minFeedbackCount,
  });
  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printSummary(snapshot);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
