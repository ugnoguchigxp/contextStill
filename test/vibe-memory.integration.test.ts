import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { vibeGoals, vibeMemories, vibeMemoryMarks } from "../src/db/schema.js";
import {
  markVibeMemory,
  recordVibeMemoryCapsule,
  retrieveVibeMemoryContext,
} from "../src/modules/vibe-memory/vibe-memory.service.js";


// Skip tests if DATABASE is not configured or integration test flag is missing
const runDbTests = process.env.MEMORY_ROUTER_RUN_DB_TESTS || process.env.DATABASE_URL;

describe("Goal Room Memory Database Integration Tests", () => {
  if (!runDbTests) {
    test.skip("Skipping DB integration tests because DATABASE_URL is not set", () => {});
    return;
  }

  beforeEach(async () => {
    // Clean up test tables in correct dependency order
    await db.delete(vibeMemoryMarks);
    await db.delete(vibeMemories);
    await db.delete(vibeGoals);
  });

  test("recordVibeMemoryCapsule inserts goal and capsule successfully", async () => {
    const goalId = "test-hash-12345";
    const capsule = await recordVibeMemoryCapsule({
      goalId,
      goalUri: "repo://test-repo/plan.md",
      goalAnchorRef: "file:///workspace/plan.md",
      subject: "PR#1",
      intent: "ask",
      wants: ["review"],
      text: "Please review PR#1 middleware ordering.",
      refs: ["file:///workspace/src/server.ts"],
      confidence: "medium",
      actorId: "agent-alpha",
      metadata: { importance: "high" },
    });

    expect(capsule.id).toBeDefined();
    expect(capsule.intent).toBe("ask");
    expect(capsule.evidenceStatus).toBe("referenced"); // Has refs -> referenced

    // Verify vibe_goals record was auto-created
    const [goal] = await db.select().from(vibeGoals).where(eq(vibeGoals.id, goalId));
    expect(goal).toBeDefined();
    expect(goal.goalUri).toBe("repo://test-repo/plan.md");
  });

  test("markVibeMemory inserts mark successfully", async () => {
    const goalId = "test-hash-12345";
    const capsule = await recordVibeMemoryCapsule({
      goalId,
      intent: "ask",
      text: "Please review PR#1 middleware ordering.",
      actorId: "agent-alpha",
    });

    const mark = await markVibeMemory({
      goalId,
      targetMemoryId: capsule.id,
      mark: "pinned",
      note: "Important milestone",
      actorId: "agent-beta",
    });

    expect(mark.id).toBeDefined();
    expect(mark.mark).toBe("pinned");

    const [savedMark] = await db.select().from(vibeMemoryMarks).where(eq(vibeMemoryMarks.id, mark.id));
    expect(savedMark).toBeDefined();
    expect(savedMark.note).toBe("Important milestone");
  });


  test("retrieveVibeMemoryContext extracts unresolved open loops & formats Brief", async () => {
    const goalId = "test-hash-brief-check";

    // 1. Post an unresolved 'ask' capsule
    const askCapsule = await recordVibeMemoryCapsule({
      goalId,
      intent: "ask",
      wants: ["review"],
      text: "Is Redis fallback secure?",
      refs: [], // No refs -> ungrounded
      actorId: "agent-a",
    });

    // 2. Post a question capsule
    const questionCapsule = await recordVibeMemoryCapsule({
      goalId,
      intent: "question",
      text: "Where is the rate-limiter defined?",
      refs: ["file:///workspace/src/limiter.ts"], // Has valid ref -> referenced
      actorId: "agent-b",
    });

    // 3. Post a pinned checkpoint
    const checkpointCapsule = await recordVibeMemoryCapsule({
      goalId,
      intent: "checkpoint",
      text: "Phase 1 initialized.",
      actorId: "system",
    });
    await markVibeMemory({
      goalId,
      targetMemoryId: checkpointCapsule.id,
      mark: "pinned",
      note: "milestone",
      actorId: "agent-a",
    });

    // 4. Retrieve Context with 'code-review' profile matching the ask wants ['review']
    const [result] = await retrieveVibeMemoryContext({
      goalId,
      profile: ["code-review"],
    });

    expect(result).toBeDefined();
    expect(result.brief).toContain("Goal Room Brief");
    expect(result.brief).toContain("Is Redis fallback secure?");
    expect(result.brief).toContain("[未検証]"); // askCapsule has no refs
    expect(result.brief).toContain("Where is the rate-limiter defined?");
    expect(result.brief).toContain("[Evidence: referenced]"); // questionCapsule has refs
    expect(result.brief).toContain("Phase 1 initialized.");
    expect(result.brief).toContain("🔥 (Match)"); // profile code-review matches wants review

    expect(result.openLoops).toHaveLength(2); // ask and question are unresolved
    expect(result.pinned).toHaveLength(1);
  });

  test("resolving open loop thread resolves it in retrieveVibeMemoryContext", async () => {
    const goalId = "test-hash-thread-resolution";

    // 1. Post review capsule requiring a fix
    const reviewCapsule = await recordVibeMemoryCapsule({
      goalId,
      intent: "review",
      text: "Found bug in routes path.",
      actorId: "agent-reviewer",
    });
    // Mark as needs_fix
    await markVibeMemory({
      goalId,
      targetMemoryId: reviewCapsule.id,
      mark: "needs_fix",
      actorId: "agent-reviewer",
    });

    // Verify it is in open loops
    let [res] = await retrieveVibeMemoryContext({ goalId });
    expect(res.openLoops).toHaveLength(1);
    expect(res.brief).toContain("Found bug in routes path.");

    // 2. Post a patch capsule replying to review (fixes it)
    const patchCapsule = await recordVibeMemoryCapsule({
      goalId,
      parentId: reviewCapsule.id,
      intent: "patch",
      text: "Fixed routing bug.",
      actorId: "agent-developer",
    });

    // Verify open loops now contains patch, but review is resolved (has child patch)
    [res] = await retrieveVibeMemoryContext({ goalId });
    // ask/review is resolved because patch replied.
    // However, patch itself is not marked as needing verify in retrieveVibeMemoryContext
    // unless wants verify/needs_verify mark/metadata.requires_verify is true.
    // So patch is resolved and not in open loops. Let's assert length = 0.
    expect(res.openLoops).toHaveLength(0);

    // 3. What if patch wants verify?
    const patchVerifyCapsule = await recordVibeMemoryCapsule({
      goalId,
      parentId: reviewCapsule.id,
      intent: "patch",
      wants: ["verify"],
      text: "Fixed routing bug again, needs verification.",
      actorId: "agent-developer",
    });

    [res] = await retrieveVibeMemoryContext({ goalId });
    // Now patchVerifyCapsule is in open loops because it wants verify and has no child verify!
    expect(res.openLoops).toHaveLength(1);
    expect(res.openLoops[0].id).toBe(patchVerifyCapsule.id);

    // 4. Verify it
    await recordVibeMemoryCapsule({
      goalId,
      parentId: patchVerifyCapsule.id,
      intent: "verify",
      text: "Verified routing bug fix.",
      refs: ["test:///routes-test#success"],
      confidence: "high",
      actorId: "agent-tester",
    });

    [res] = await retrieveVibeMemoryContext({ goalId });
    // Thread is fully verified/resolved! Open loops should be empty.
    expect(res.openLoops).toHaveLength(0);
  });
});
