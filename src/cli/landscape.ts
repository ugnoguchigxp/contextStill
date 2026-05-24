import { closeDbPool } from "../db/index.js";
import { buildLandscapeSnapshot } from "../modules/landscape/landscape.service.js";

type CliOptions = {
  windowDays: number;
  limit: number;
  status: "current" | "active" | "draft" | "deprecated" | "all";
  relationAxes: Array<"session" | "project" | "source">;
  minSelectedCount: number;
  minFeedbackCount: number;
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    windowDays: 30,
    limit: 1000,
    status: "active",
    relationAxes: ["session", "project", "source"],
    minSelectedCount: 3,
    minFeedbackCount: 3,
    json: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
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
      if (arg === "--status") index += 1;
      continue;
    }
    if (arg === "--relation-axes" || arg.startsWith("--relation-axes=")) {
      const value = readArgValue(args, index, "--relation-axes");
      options.relationAxes = parseRelationAxes(value);
      if (arg === "--relation-axes") index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printSummary(snapshot: Awaited<ReturnType<typeof buildLandscapeSnapshot>>) {
  console.log(`Landscape Snapshot (${snapshot.windowDays}d, ${snapshot.basis.status})`);
  console.log(`Communities: ${snapshot.stats.totalCommunities}`);
  console.log(`Strong attractors: ${snapshot.stats.strongAttractorCount}`);
  console.log(`Useful attractors: ${snapshot.stats.usefulAttractorCount}`);
  console.log(`Negative candidates: ${snapshot.stats.negativeCandidateCount}`);
  console.log(`Over-selected not used: ${snapshot.stats.overSelectedNotUsedCount}`);
  console.log(`Dead reachability risks: ${snapshot.stats.deadZoneReachabilityCount}`);
  console.log(`Dead stale: ${snapshot.stats.deadZoneStaleCount}`);
  console.log(`Feedback insufficient: ${snapshot.stats.insufficientFeedbackCommunities}`);

  if (snapshot.risks.length === 0) return;
  console.log("");
  console.log("Top risks:");
  for (const risk of snapshot.risks.slice(0, 10)) {
    console.log(
      `- [${risk.severity}] #${risk.communityRank} ${risk.communityLabel} (${risk.type}) ${risk.reason}`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
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
