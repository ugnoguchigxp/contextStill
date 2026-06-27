import { describe, expect, test } from "vitest";

import { parseArgs } from "../src/cli/queue-supervisor.js";
import { distillationQueueNames } from "../src/modules/queue/core/index.js";

describe("queue supervisor CLI args", () => {
  test("keeps multiple queue filters in argument order", () => {
    const options = parseArgs([
      "--continuous",
      "--queue",
      "coveringEvidence",
      "--queue",
      "finalizeDistille",
      "--worker",
      "launchd-covering-worker",
    ]);

    expect(options.continuous).toBe(true);
    expect(options.worker).toBe("launchd-covering-worker");
    expect(options.queueNames).toEqual(["coveringEvidence", "finalizeDistille"]);
  });

  test("accepts comma-separated queue filters", () => {
    const options = parseArgs(["--queue=coveringEvidence,finalizeDistille"]);

    expect(options.queueNames).toEqual(["coveringEvidence", "finalizeDistille"]);
  });

  test("uses all queues when no queue filter is provided", () => {
    const options = parseArgs([]);

    expect(options.queueNames).toEqual(distillationQueueNames);
  });
});
