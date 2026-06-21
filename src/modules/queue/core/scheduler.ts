import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import {
  getRuntimeSettingsSnapshot,
  resolveProviderPools,
} from "../../settings/settings.service.js";
import type { RuntimeSettingsRoute } from "../../settings/settings.types.js";
import type { DistillationQueueName } from "./types.js";

export const providerPoolQueuePriorityOrder: DistillationQueueName[] = [
  "findingCandidate",
  "coveringEvidence",
  "episodeDistiller",
  "deadZoneMergeReview",
  "mergeActivationFinalize",
  "finalizeDistille",
];

function routePoolId(route: RuntimeSettingsRoute | undefined): string | null {
  return route?.providerPoolId?.trim() || null;
}

export function providerPoolIdsForQueue(queueName: DistillationQueueName): string[] {
  const settings = getRuntimeSettingsSnapshot();
  const ids = new Set<string>();
  if (queueName === "findingCandidate") {
    const source = routePoolId(settings.taskRouting.findCandidate.source);
    const vibe = routePoolId(settings.taskRouting.findCandidate.vibe);
    if (source) ids.add(source);
    if (vibe) ids.add(vibe);
  } else if (queueName === "coveringEvidence") {
    const sourceSupport = routePoolId(settings.taskRouting.coverEvidence.sourceSupport);
    const externalEvidence = routePoolId(settings.taskRouting.coverEvidence.externalEvidence);
    const mcpEvidence = routePoolId(settings.taskRouting.coverEvidence.mcpEvidence);
    if (sourceSupport) ids.add(sourceSupport);
    if (externalEvidence) ids.add(externalEvidence);
    if (mcpEvidence) ids.add(mcpEvidence);
  } else if (queueName === "episodeDistiller") {
    const id = routePoolId(settings.taskRouting.episodeDistiller);
    if (id) ids.add(id);
  } else if (queueName === "deadZoneMergeReview") {
    const id = routePoolId(settings.taskRouting.deadZoneMergeReview);
    if (id) ids.add(id);
  } else if (queueName === "mergeActivationFinalize") {
    const id = routePoolId(settings.taskRouting.mergeActivationFinalize);
    if (id) ids.add(id);
  } else {
    const id = routePoolId(settings.taskRouting.finalizeDistille);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function priorityQueuesForProviderPool(params: {
  poolId: string;
  allowedQueues: DistillationQueueName[];
}): DistillationQueueName[] {
  const allowed = new Set(params.allowedQueues);
  return providerPoolQueuePriorityOrder.filter(
    (queueName) =>
      allowed.has(queueName) && providerPoolIdsForQueue(queueName).includes(params.poolId),
  );
}

export function enabledProviderPoolsForQueues(
  queueNames: DistillationQueueName[],
): ReturnType<typeof resolveProviderPools> {
  if (resolveDatabaseBackendConfig().kind !== "sqlite") return [];
  const queueNameSet = new Set(queueNames);
  return resolveProviderPools().filter((pool) => {
    if (!pool.enabled || pool.targets.length === 0) return false;
    return providerPoolQueuePriorityOrder.some(
      (queueName) =>
        queueNameSet.has(queueName) && providerPoolIdsForQueue(queueName).includes(pool.id),
    );
  });
}

export function unpooledQueues(queueNames: DistillationQueueName[]): DistillationQueueName[] {
  if (resolveDatabaseBackendConfig().kind !== "sqlite") return queueNames;
  return queueNames.filter((queueName) => providerPoolIdsForQueue(queueName).length === 0);
}
