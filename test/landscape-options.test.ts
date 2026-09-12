import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/landscape-options.js";

describe("landscape CLI options", () => {
  test("defaults match the operator contract", () => {
    expect(parseArgs([])).toMatchObject({
      windowDays: 30,
      limit: 1000,
      status: "active",
      runStatus: "all",
      relationAxes: ["session", "project", "source"],
      snapshotCacheWarmup: true,
      json: false,
    });
  });

  test("parses space-separated and inline flags", () => {
    const options = parseArgs([
      "--json",
      "--trajectory-no-candidates",
      "--trajectory-run-id",
      "run-1",
      "--trajectory-limit=20",
      "--replay",
      "--compare-communities",
      "--replay-compare",
      "--queue",
      "--queue-dry-run",
      "--queue-create-candidates",
      "--queue-list",
      "--window-days",
      "7",
      "--limit=50",
      "--landscape-limit",
      "80",
      "--min-selected-count=2",
      "--min-feedback-count",
      "4",
      "--status=draft",
      "--run-status",
      "degraded",
      "--landscape-status=all",
      "--relation-axes=session,unknown,project",
      "--min-similarity=0.5",
      "--semantic-top-k=5",
      "--current-limit=8",
      "--queue-status=pending",
      "--queue-source=promotion_gate,contradiction_detection",
      "--queue-limit=12",
      "--snapshot-cache-status",
      "--snapshot-cache-refresh",
      "--snapshot-cache-purge",
      "--snapshot-cache-no-warmup",
      "--snapshot-cache-type=all",
    ]);
    expect(options.json).toBe(true);
    expect(options.trajectoryIncludeCandidates).toBe(false);
    expect(options.trajectoryRunId).toBe("run-1");
    expect(options.trajectoryLimit).toBe(20);
    expect(options.replay).toBe(true);
    expect(options.compareCommunities).toBe(true);
    expect(options.replayCompare).toBe(true);
    expect(options.queue).toBe(true);
    expect(options.status).toBe("draft");
    expect(options.landscapeStatus).toBe("all");
    expect(options.runStatus).toBe("degraded");
    expect(options.relationAxes).toEqual(["session", "project"]);
    expect(options.minSimilarity).toBe(0.5);
    expect(options.queueStatus).toBe("pending");
    expect(options.queueSources).toEqual(["promotion_gate", "contradiction_detection"]);
    expect(options.snapshotCacheWarmup).toBe(false);
    expect(options.snapshotCacheTypes).toEqual([
      "landscape_snapshot",
      "landscape_replay_snapshot",
      "landscape_replay_comparison",
    ]);
  });

  test("accepts remaining status, source and cache type values", () => {
    expect(parseArgs(["--status", "current"]).status).toBe("current");
    expect(parseArgs(["--status", "active"]).status).toBe("active");
    expect(parseArgs(["--status", "deprecated"]).status).toBe("deprecated");
    expect(parseArgs(["--run-status=ok"]).runStatus).toBe("ok");
    expect(parseArgs(["--run-status=failed"]).runStatus).toBe("failed");
    expect(parseArgs(["--queue-status=reviewing"]).queueStatus).toBe("reviewing");
    expect(parseArgs(["--queue-status=resolved"]).queueStatus).toBe("resolved");
    expect(parseArgs(["--queue-status=dismissed"]).queueStatus).toBe("dismissed");
    expect(parseArgs(["--queue-status=all"]).queueStatus).toBe("all");
    expect(parseArgs(["--recompile-compare"]).replayCompare).toBe(true);
    expect(parseArgs(["--relation-axes=,"]).relationAxes).toEqual(["session", "project", "source"]);
    expect(
      parseArgs(["--queue-source=replay_compare,landscape_snapshot,semantic_relation_comparison"])
        .queueSources,
    ).toHaveLength(3);
    expect(
      parseArgs(["--snapshot-cache-type=landscape_snapshot,landscape_replay_comparison"])
        .snapshotCacheTypes,
    ).toEqual(["landscape_snapshot", "landscape_replay_comparison"]);
  });

  test("rejects invalid values", () => {
    expect(() => parseArgs(["--status", "nope"])).toThrow("--status must be one of");
    expect(() => parseArgs(["--run-status", "slow"])).toThrow("--run-status must be one of");
    expect(() => parseArgs(["--queue-status", "open"])).toThrow("--queue-status must be one of");
    expect(() => parseArgs(["--queue-source=nope"])).toThrow("--queue-source must include");
    expect(() => parseArgs(["--snapshot-cache-type=nope"])).toThrow(
      "--snapshot-cache-type must include",
    );
    expect(() => parseArgs(["--window-days", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["--window-days", "181"])).toThrow("180 or less");
    expect(() => parseArgs(["--min-similarity", "2"])).toThrow("between 0 and 1");
    expect(() => parseArgs(["--trajectory-run-id", "  "])).toThrow("must not be empty");
    expect(() => parseArgs(["--limit"])).toThrow("requires a value");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument");
  });
});
