import { describe, expect, test } from "vitest";
import { isPipelineLockLikelyBlocking } from "../src/modules/doctor/distillation-lock.util";

describe("isPipelineLockLikelyBlocking", () => {
  test("returns false when lock is not stale", () => {
    expect(
      isPipelineLockLikelyBlocking({
        staleByCreatedAge: false,
        launchAgentLoaded: true,
        staleRunning: 0,
        running: 0,
        blockedByHigherPriority: false,
      }),
    ).toBe(false);
  });

  test("returns true when launch agent is not loaded", () => {
    expect(
      isPipelineLockLikelyBlocking({
        staleByCreatedAge: true,
        launchAgentLoaded: false,
        staleRunning: 0,
        running: 1,
        blockedByHigherPriority: false,
      }),
    ).toBe(true);
  });

  test("returns true when stale running jobs exist", () => {
    expect(
      isPipelineLockLikelyBlocking({
        staleByCreatedAge: true,
        launchAgentLoaded: true,
        staleRunning: 1,
        running: 1,
        blockedByHigherPriority: false,
      }),
    ).toBe(true);
  });

  test("returns false when queue is blocked by higher priority with no running job", () => {
    expect(
      isPipelineLockLikelyBlocking({
        staleByCreatedAge: true,
        launchAgentLoaded: true,
        staleRunning: 0,
        running: 0,
        blockedByHigherPriority: true,
      }),
    ).toBe(false);
  });

  test("returns true when queue is not blocked and no running job exists", () => {
    expect(
      isPipelineLockLikelyBlocking({
        staleByCreatedAge: true,
        launchAgentLoaded: true,
        staleRunning: 0,
        running: 0,
        blockedByHigherPriority: false,
      }),
    ).toBe(true);
  });
});
