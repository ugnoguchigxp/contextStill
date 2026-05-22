export function isPipelineLockLikelyBlocking(params: {
  staleByCreatedAge: boolean;
  launchAgentLoaded: boolean;
  staleRunning: number;
  running: number;
  blockedByHigherPriority: boolean;
}): boolean {
  if (!params.staleByCreatedAge) return false;
  if (!params.launchAgentLoaded) return true;
  if (params.staleRunning > 0) return true;
  if (params.running === 0 && !params.blockedByHigherPriority) return true;
  return false;
}
