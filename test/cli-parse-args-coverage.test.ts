import { describe, expect, test } from "vitest";
import { parseArgs as parseBackfillEpisodesArgs } from "../src/cli/backfill-episodes-from-compile.js";
import { parseArgs as parseRequeueEpisodeArgs } from "../src/cli/requeue-episode-distiller-missing-cards.js";

describe("CLI parseArgs coverage", () => {
  test("backfill-episodes-from-compile collects unique run ids", () => {
    expect(
      parseBackfillEpisodesArgs(["--run-id", "a,b", "--run-ids=b,c", "--write", "--json"]),
    ).toEqual({
      runIds: ["a", "b", "c"],
      write: true,
    });
    expect(parseBackfillEpisodesArgs(["--run-id=only", "--dry-run"]).write).toBe(false);
    expect(() => parseBackfillEpisodesArgs([])).toThrow();
    expect(() => parseBackfillEpisodesArgs(["--run-id"])).toThrow("requires a value");
    expect(() => parseBackfillEpisodesArgs(["--nope"])).toThrow("Unknown argument");
  });

  test("requeue-episode-distiller-missing-cards parses write, limit and reason", () => {
    expect(parseRequeueEpisodeArgs([])).toEqual({ write: false, limit: 100 });
    expect(
      parseRequeueEpisodeArgs(["--write", "--limit", "4", "--reason=repair", "--json"]),
    ).toEqual({
      write: true,
      limit: 4,
      reason: "repair",
    });
    expect(parseRequeueEpisodeArgs(["--dry-run"]).write).toBe(false);
    expect(() => parseRequeueEpisodeArgs(["--limit=0"])).toThrow("positive integer");
    expect(() => parseRequeueEpisodeArgs(["--unknown"])).toThrow("Unknown argument");
  });
});
