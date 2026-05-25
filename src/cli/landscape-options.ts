import type { LandscapeSnapshotCacheType } from "../modules/landscape/landscape-snapshot-cache.service.js";

export type CliOptions = {
  windowDays: number;
  limit: number;
  landscapeLimit: number;
  status: "current" | "active" | "draft" | "deprecated" | "all";
  runStatus: "ok" | "degraded" | "failed" | "all";
  landscapeStatus: "current" | "active" | "draft" | "deprecated" | "all";
  relationAxes: Array<"session" | "project" | "source">;
  minSelectedCount: number;
  minFeedbackCount: number;
  minSimilarity: number;
  semanticTopK: number;
  currentLimit: number;
  trajectoryRunId: string | null;
  trajectoryLimit: number;
  trajectoryIncludeCandidates: boolean;
  replay: boolean;
  replayCompare: boolean;
  compareCommunities: boolean;
  queue: boolean;
  queueDryRun: boolean;
  queueCreateCandidates: boolean;
  queueList: boolean;
  queueStatus: "pending" | "reviewing" | "resolved" | "dismissed" | "all";
  queueSources: Array<
    | "replay_compare"
    | "landscape_snapshot"
    | "semantic_relation_comparison"
    | "promotion_gate"
    | "contradiction_detection"
  >;
  queueLimit: number;
  snapshotCacheStatus: boolean;
  snapshotCacheRefresh: boolean;
  snapshotCachePurge: boolean;
  snapshotCacheWarmup: boolean;
  snapshotCacheTypes: LandscapeSnapshotCacheType[];
  json: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parsePositiveInt(
  args: string[],
  index: number,
  name: string,
  max?: number,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be ${max} or less`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

function parseRelationAxes(value: string): Array<"session" | "project" | "source"> {
  const axes = new Set<"session" | "project" | "source">();
  for (const token of value.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "session" || normalized === "project" || normalized === "source") {
      axes.add(normalized);
    }
  }
  return axes.size > 0 ? [...axes] : ["session", "project", "source"];
}

function parseStatus(value: string): CliOptions["status"] {
  if (
    value === "current" ||
    value === "active" ||
    value === "draft" ||
    value === "deprecated" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("--status must be one of current|active|draft|deprecated|all");
}

function parseQueueStatus(value: string): CliOptions["queueStatus"] {
  if (
    value === "pending" ||
    value === "reviewing" ||
    value === "resolved" ||
    value === "dismissed" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("--queue-status must be one of pending|reviewing|resolved|dismissed|all");
}

function parseQueueSources(
  value: string,
): Array<
  | "replay_compare"
  | "landscape_snapshot"
  | "semantic_relation_comparison"
  | "promotion_gate"
  | "contradiction_detection"
> {
  const sources = new Set<
    | "replay_compare"
    | "landscape_snapshot"
    | "semantic_relation_comparison"
    | "promotion_gate"
    | "contradiction_detection"
  >();
  for (const token of value.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (
      normalized === "replay_compare" ||
      normalized === "landscape_snapshot" ||
      normalized === "semantic_relation_comparison" ||
      normalized === "promotion_gate" ||
      normalized === "contradiction_detection"
    ) {
      sources.add(normalized);
    }
  }
  if (sources.size === 0) {
    throw new Error(
      "--queue-source must include replay_compare|landscape_snapshot|semantic_relation_comparison|promotion_gate|contradiction_detection",
    );
  }
  return [...sources];
}

function parseSnapshotCacheTypes(value: string): LandscapeSnapshotCacheType[] {
  const types = new Set<LandscapeSnapshotCacheType>();
  for (const token of value.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "all") {
      types.add("landscape_snapshot");
      types.add("landscape_replay_snapshot");
      types.add("landscape_replay_comparison");
      continue;
    }
    if (
      normalized === "landscape_snapshot" ||
      normalized === "landscape_replay_snapshot" ||
      normalized === "landscape_replay_comparison"
    ) {
      types.add(normalized);
    }
  }
  if (types.size === 0) {
    throw new Error(
      "--snapshot-cache-type must include landscape_snapshot|landscape_replay_snapshot|landscape_replay_comparison|all",
    );
  }
  return [...types];
}

function parseRunStatus(value: string): CliOptions["runStatus"] {
  if (value === "ok" || value === "degraded" || value === "failed" || value === "all") {
    return value;
  }
  throw new Error("--run-status must be one of ok|degraded|failed|all");
}

function parseUnitNumber(
  args: string[],
  index: number,
  name: string,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    windowDays: 30,
    limit: 1000,
    landscapeLimit: 1000,
    status: "active",
    runStatus: "all",
    landscapeStatus: "active",
    relationAxes: ["session", "project", "source"],
    minSelectedCount: 3,
    minFeedbackCount: 3,
    minSimilarity: 0.72,
    semanticTopK: 3,
    currentLimit: 12,
    trajectoryRunId: null,
    trajectoryLimit: 200,
    trajectoryIncludeCandidates: true,
    replay: false,
    replayCompare: false,
    compareCommunities: false,
    queue: false,
    queueDryRun: false,
    queueCreateCandidates: false,
    queueList: false,
    queueStatus: "all",
    queueSources: ["replay_compare"],
    queueLimit: 100,
    snapshotCacheStatus: false,
    snapshotCacheRefresh: false,
    snapshotCachePurge: false,
    snapshotCacheWarmup: true,
    snapshotCacheTypes: [
      "landscape_snapshot",
      "landscape_replay_snapshot",
      "landscape_replay_comparison",
    ],
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--trajectory-no-candidates") {
      options.trajectoryIncludeCandidates = false;
      continue;
    }
    if (arg === "--trajectory-run-id" || arg.startsWith("--trajectory-run-id=")) {
      const value = readArgValue(args, index, "--trajectory-run-id").trim();
      if (!value) throw new Error("--trajectory-run-id must not be empty");
      options.trajectoryRunId = value;
      if (arg === "--trajectory-run-id") index += 1;
      continue;
    }
    if (arg === "--trajectory-limit" || arg.startsWith("--trajectory-limit=")) {
      const parsed = parsePositiveInt(args, index, "--trajectory-limit", 2000);
      options.trajectoryLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--replay") {
      options.replay = true;
      continue;
    }
    if (arg === "--compare-communities") {
      options.replay = true;
      options.compareCommunities = true;
      continue;
    }
    if (arg === "--replay-compare" || arg === "--recompile-compare") {
      options.replayCompare = true;
      continue;
    }
    if (arg === "--queue") {
      options.queue = true;
      continue;
    }
    if (arg === "--queue-dry-run") {
      options.queueDryRun = true;
      continue;
    }
    if (arg === "--queue-create-candidates") {
      options.queueCreateCandidates = true;
      continue;
    }
    if (arg === "--queue-list") {
      options.queueList = true;
      continue;
    }
    if (arg === "--window-days" || arg.startsWith("--window-days=")) {
      const parsed = parsePositiveInt(args, index, "--window-days", 180);
      options.windowDays = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = parsePositiveInt(args, index, "--limit", 1000);
      options.limit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--landscape-limit" || arg.startsWith("--landscape-limit=")) {
      const parsed = parsePositiveInt(args, index, "--landscape-limit", 2000);
      options.landscapeLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--min-selected-count" || arg.startsWith("--min-selected-count=")) {
      const parsed = parsePositiveInt(args, index, "--min-selected-count", 100);
      options.minSelectedCount = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--min-feedback-count" || arg.startsWith("--min-feedback-count=")) {
      const parsed = parsePositiveInt(args, index, "--min-feedback-count", 100);
      options.minFeedbackCount = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--status" || arg.startsWith("--status=")) {
      const value = readArgValue(args, index, "--status");
      options.status = parseStatus(value);
      options.landscapeStatus = options.status;
      if (arg === "--status") index += 1;
      continue;
    }
    if (arg === "--run-status" || arg.startsWith("--run-status=")) {
      const value = readArgValue(args, index, "--run-status");
      options.runStatus = parseRunStatus(value);
      if (arg === "--run-status") index += 1;
      continue;
    }
    if (arg === "--landscape-status" || arg.startsWith("--landscape-status=")) {
      const value = readArgValue(args, index, "--landscape-status");
      options.landscapeStatus = parseStatus(value);
      if (arg === "--landscape-status") index += 1;
      continue;
    }
    if (arg === "--relation-axes" || arg.startsWith("--relation-axes=")) {
      const value = readArgValue(args, index, "--relation-axes");
      options.relationAxes = parseRelationAxes(value);
      if (arg === "--relation-axes") index += 1;
      continue;
    }
    if (arg === "--min-similarity" || arg.startsWith("--min-similarity=")) {
      const parsed = parseUnitNumber(args, index, "--min-similarity");
      options.minSimilarity = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--semantic-top-k" || arg.startsWith("--semantic-top-k=")) {
      const parsed = parsePositiveInt(args, index, "--semantic-top-k", 10);
      options.semanticTopK = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--current-limit" || arg.startsWith("--current-limit=")) {
      const parsed = parsePositiveInt(args, index, "--current-limit", 50);
      options.currentLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--queue-status" || arg.startsWith("--queue-status=")) {
      const value = readArgValue(args, index, "--queue-status");
      options.queueStatus = parseQueueStatus(value);
      if (arg === "--queue-status") index += 1;
      continue;
    }
    if (arg === "--queue-source" || arg.startsWith("--queue-source=")) {
      const value = readArgValue(args, index, "--queue-source");
      options.queueSources = parseQueueSources(value);
      if (arg === "--queue-source") index += 1;
      continue;
    }
    if (arg === "--queue-limit" || arg.startsWith("--queue-limit=")) {
      const parsed = parsePositiveInt(args, index, "--queue-limit", 500);
      options.queueLimit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--snapshot-cache-status") {
      options.snapshotCacheStatus = true;
      continue;
    }
    if (arg === "--snapshot-cache-refresh") {
      options.snapshotCacheRefresh = true;
      continue;
    }
    if (arg === "--snapshot-cache-purge") {
      options.snapshotCachePurge = true;
      continue;
    }
    if (arg === "--snapshot-cache-no-warmup") {
      options.snapshotCacheWarmup = false;
      continue;
    }
    if (arg === "--snapshot-cache-type" || arg.startsWith("--snapshot-cache-type=")) {
      const value = readArgValue(args, index, "--snapshot-cache-type");
      options.snapshotCacheTypes = parseSnapshotCacheTypes(value);
      if (arg === "--snapshot-cache-type") index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}
