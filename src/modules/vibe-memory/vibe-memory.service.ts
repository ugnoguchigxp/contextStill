import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeGoals, vibeMemories, vibeMemoryMarks } from "../../db/schema.js";
import {
  type MarkVibeMemoryInput,
  type RecordVibeMemoryCapsuleInput,
  type RecordVibeMemoryInput,
  recordVibeMemoryInputSchema,
} from "../../shared/schemas/vibe-memory.schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  extractAgentDiffContentFromText,
  normalizeAgentDiffEntries,
  stripAgentDiffContentFromText,
} from "./agent-diff-ingestion.service.js";
import {
  type VibeMemorySeed,
  insertVibeMemory,
  searchVibeMemories,
} from "./vibe-memory.repository.js";

export type RecordedVibeMemory = {
  memory: typeof vibeMemories.$inferSelect;
  diffEntries: (typeof agentDiffEntries.$inferSelect)[];
};

// Legacy support
export async function recordVibeMemory(memory: VibeMemorySeed) {
  return insertVibeMemory(memory);
}

// Legacy support
export async function recordVibeMemoryWithDiffEntries(
  input: RecordVibeMemoryInput,
): Promise<RecordedVibeMemory> {
  const parsed = recordVibeMemoryInputSchema.parse(input);
  const redactedContent = redactSecrets(parsed.content);
  const embeddedDiff = extractAgentDiffContentFromText(redactedContent);
  const normalizedEntries = normalizeAgentDiffEntries({
    diff: [parsed.diff ? redactSecrets(parsed.diff) : undefined, embeddedDiff]
      .filter((diff): diff is string => Boolean(diff?.trim()))
      .join("\n\n"),
    agentDiffs: parsed.agentDiffs.map((entry) => ({
      ...entry,
      diffHunk: redactSecrets(entry.diffHunk ?? ""),
      metadata: redactSecretRecord(entry.metadata ?? {}),
    })),
  });
  const content =
    redactSecrets(stripAgentDiffContentFromText(redactedContent)) ||
    (normalizedEntries.length > 0 ? "Agent diff recorded." : redactedContent.trim());

  return db.transaction(async (tx) => {
    const [memory] = await tx
      .insert(vibeMemories)
      .values({
        sessionId: parsed.sessionId,
        content,
        memoryType: parsed.memoryType,
        metadata: redactSecretRecord(parsed.metadata),
      })
      .returning();

    const diffEntries =
      normalizedEntries.length > 0
        ? await tx
            .insert(agentDiffEntries)
            .values(
              normalizedEntries.map((entry) => ({
                vibeMemoryId: memory.id,
                filePath: entry.filePath,
                diffHunk: entry.diffHunk,
                changeType: entry.changeType ?? null,
                language: entry.language ?? null,
                symbolName: entry.symbolName ?? null,
                symbolKind: entry.symbolKind ?? null,
                signature: entry.signature ?? null,
                startLine: entry.startLine ?? null,
                endLine: entry.endLine ?? null,
                metadata: redactSecretRecord(entry.metadata),
              })),
            )
            .returning()
        : [];

    return { memory, diffEntries };
  });
}

// Helper to determine evidence status based on refs
function determineEvidenceStatus(
  intent: string,
  refs: string[],
  confidence?: string | null,
): string {
  if (!refs || refs.length === 0) {
    return "ungrounded";
  }

  // Basic validation of URI schemes
  const validPrefixes = [
    "file://",
    "git://",
    "github://",
    "test://",
    "log://",
    "doc://",
    "memory://",
  ];
  const hasValidRef = refs.some((ref) => validPrefixes.some((prefix) => ref.startsWith(prefix)));
  if (!hasValidRef) {
    return "ungrounded";
  }

  if (intent === "verify" && confidence === "high") {
    return "verified";
  }

  return "referenced";
}

/**
 * Record a Goal Room Memory Capsule (v3)
 */
export async function recordVibeMemoryCapsule(input: RecordVibeMemoryCapsuleInput) {
  const goalId = input.goalId;

  return db.transaction(async (tx) => {
    // 1. Ensure goal exists in vibe_goals
    const [existingGoal] = await tx.select().from(vibeGoals).where(eq(vibeGoals.id, goalId));
    if (!existingGoal) {
      const defaultGoalUri = input.goalUri ?? `repo://local-repo/goals/${goalId}`;
      const defaultGoalAnchor = input.goalAnchorRef ?? `file:///workspace/goals/${goalId}`;
      await tx.insert(vibeGoals).values({
        id: goalId,
        goalUri: defaultGoalUri,
        goalAnchorRef: defaultGoalAnchor,
        title: input.subject ?? "Goal Room",
      });
    }

    // 2. Resolve evidence status
    const evidenceStatus = determineEvidenceStatus(
      input.intent,
      input.refs ?? [],
      input.confidence,
    );

    // 3. Insert Capsule into vibe_memories
    const [inserted] = await tx
      .insert(vibeMemories)
      .values({
        sessionId: `goal:${goalId}`, // keep notNull constraint happy
        content: redactSecrets(input.text),
        memoryType: "capsule",
        metadata: redactSecretRecord(input.metadata ?? {}),
        goalId: goalId,
        parentId: input.parentId ?? null,
        subject: input.subject ?? null,

        intent: input.intent,
        wants: input.wants,
        refs: input.refs,
        confidence: input.confidence ?? null,
        evidenceStatus: evidenceStatus,
        actorId: input.actorId,
        ttlAt: input.ttlHours ? new Date(Date.now() + input.ttlHours * 60 * 60 * 1000) : null,
      })
      .returning();

    return inserted;
  });
}

/**
 * Add a mark (付箋) to a vibe memory (v3)
 */
export async function markVibeMemory(input: MarkVibeMemoryInput) {
  const [mark] = await db
    .insert(vibeMemoryMarks)
    .values({
      goalId: input.goalId,
      targetMemoryId: input.targetMemoryId,
      mark: input.mark,
      note: input.note ? redactSecrets(input.note) : null,
      actorId: input.actorId,
    })
    .returning();
  return mark;
}

/**
 * Retrieve Vibe Memory Context or generate Goal Room Memory Brief (v3)
 */
export async function retrieveVibeMemoryContext(params: {
  query?: string;
  sessionId?: string; // Legacy chat context lookup
  goalId?: string; // Goal Room Memory lookup (Priority)
  profile?: string[]; // Agent profiles for Step 2 profile filtering
  limit?: number;
}): Promise<any> {
  // If goalId is provided, run the Goal Room Memory 5-step Pipeline
  if (params.goalId) {
    const goalId = params.goalId;
    const profile = params.profile ?? [];

    // Step 1: SQL Candidate Extraction (Open Loop extraction)
    // We execute the deterministic extraction logic via direct SQL query
    const openLoopsQuery = await db.execute(sql`
      SELECT 
        vm.id, vm.goal_id as "goalId", vm.parent_id as "parentId", vm.subject, 
        vm.intent, vm.wants, vm.content as "text", vm.refs, vm.confidence, 
        vm.evidence_status as "evidenceStatus", vm.actor_id as "actorId", vm.created_at as "createdAt",
        COALESCE(
          (
            SELECT json_agg(json_build_object('id', vmm.id, 'mark', vmm.mark, 'note', vmm.note, 'actorId', vmm.actor_id))
            FROM vibe_memory_marks vmm
            WHERE vmm.target_memory_id = vm.id
          ),
          '[]'::json
        ) as "marks"
      FROM vibe_memories vm
      WHERE vm.goal_id = ${goalId}
        AND vm.memory_type = 'capsule'
        AND NOT EXISTS (
          SELECT 1 FROM vibe_memory_marks vmm 
          WHERE vmm.target_memory_id = vm.id 
            AND vmm.mark IN ('stale', 'superseded')
        )
        AND (
          -- 1. Actionable ask unresolved
          (vm.intent = 'ask' 
           AND jsonb_array_length(vm.wants) > 0
           AND NOT EXISTS (
             SELECT 1 FROM vibe_memory_marks vmm 
             WHERE vmm.target_memory_id = vm.id AND vmm.mark = 'resolved'
           )
          )
          -- 2. Question without answer or resolution
          OR (vm.intent = 'question'
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memories child 
                WHERE child.parent_id = vm.id AND child.intent = 'answer'
              )
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memory_marks vmm 
                WHERE vmm.target_memory_id = vm.id AND vmm.mark = 'resolved'
              )
          )
          -- 3. Review warning (needs_fix) without patch or resolution
          OR (vm.intent = 'review'
              AND EXISTS (SELECT 1 FROM vibe_memory_marks vmm WHERE vmm.target_memory_id = vm.id AND vmm.mark = 'needs_fix')
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memories child 
                WHERE child.parent_id = vm.id AND child.intent = 'patch'
              )
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memory_marks vmm 
                WHERE vmm.target_memory_id = vm.id AND vmm.mark = 'resolved'
              )
          )
          -- 4. Patch requiring verification without verification or resolution
          OR (vm.intent = 'patch'
              AND (
                vm.wants ? 'verify'
                OR EXISTS (SELECT 1 FROM vibe_memory_marks vmm WHERE vmm.target_memory_id = vm.id AND vmm.mark = 'needs_verify')
                OR (vm.metadata->>'requires_verify')::boolean = true
              )
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memories child 
                WHERE child.parent_id = vm.id AND child.intent = 'verify'
              )
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memory_marks vmm 
                WHERE vmm.target_memory_id = vm.id AND vmm.mark IN ('verified', 'resolved')
              )
          )
          -- 5. Risk unresolved
          OR (vm.intent = 'risk'
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memory_marks vmm 
                WHERE vmm.target_memory_id = vm.id 
                  AND vmm.mark IN ('accepted_risk', 'mitigated', 'resolved')
              )
          )
          -- 6. Warning unresolved
          OR (vm.intent = 'warning'
              AND NOT EXISTS (
                SELECT 1 FROM vibe_memory_marks vmm 
                WHERE vmm.target_memory_id = vm.id AND vmm.mark = 'resolved'
              )
          )
        )
      ORDER BY vm.created_at ASC;
    `);

    const openLoops = openLoopsQuery.rows as any[];

    // Fetch other compaction layers: Pinned Checkpoints, Verified Decisions, and Recent timeline
    const pinnedMemories = await db
      .select({
        id: vibeMemories.id,
        text: vibeMemories.content,
        intent: vibeMemories.intent,
        refs: vibeMemories.refs,
        actorId: vibeMemories.actorId,
        createdAt: vibeMemories.createdAt,
      })
      .from(vibeMemories)
      .innerJoin(vibeMemoryMarks, eq(vibeMemoryMarks.targetMemoryId, vibeMemories.id))
      .where(
        and(
          eq(vibeMemories.goalId, goalId),
          eq(vibeMemoryMarks.mark, "pinned"),
          eq(vibeMemories.memoryType, "capsule"),
        ),
      );

    const verifiedDecisions = await db
      .select({
        id: vibeMemories.id,
        text: vibeMemories.content,
        intent: vibeMemories.intent,
        refs: vibeMemories.refs,
        actorId: vibeMemories.actorId,
        createdAt: vibeMemories.createdAt,
      })
      .from(vibeMemories)
      .where(
        and(
          eq(vibeMemories.goalId, goalId),
          eq(vibeMemories.intent, "decision"),
          eq(vibeMemories.evidenceStatus, "verified"),
          eq(vibeMemories.memoryType, "capsule"),
        ),
      );

    const recentCapsulesQuery = await db.execute(sql`
      SELECT
        vm.id, vm.goal_id as "goalId", vm.parent_id as "parentId", vm.subject,
        vm.intent, vm.wants, vm.content as "text", vm.refs, vm.confidence,
        vm.evidence_status as "evidenceStatus", vm.actor_id as "actorId", vm.created_at as "createdAt",
        COALESCE(
          (
            SELECT json_agg(json_build_object('id', vmm.id, 'mark', vmm.mark, 'note', vmm.note, 'actorId', vmm.actor_id))
            FROM vibe_memory_marks vmm
            WHERE vmm.target_memory_id = vm.id
          ),
          '[]'::json
        ) as "marks"
      FROM vibe_memories vm
      WHERE vm.goal_id = ${goalId}
        AND vm.memory_type = 'capsule'
        AND NOT EXISTS (
          SELECT 1 FROM vibe_memory_marks vmm
          WHERE vmm.target_memory_id = vm.id
            AND vmm.mark IN ('stale', 'superseded')
        )
      ORDER BY vm.created_at DESC
      LIMIT 20;
    `);
    const recentCapsules = recentCapsulesQuery.rows as any[];
    const openLoopIds = new Set(openLoops.map((loop) => loop.id));
    const pinnedIds = new Set(pinnedMemories.map((memory) => memory.id));
    const decisionIds = new Set(verifiedDecisions.map((decision) => decision.id));
    const agentMemos = recentCapsules.filter(
      (capsule) =>
        !openLoopIds.has(capsule.id) && !pinnedIds.has(capsule.id) && !decisionIds.has(capsule.id),
    );
    const recentTimeline = recentCapsules.slice(0, 10);

    const [goal] = await db.select().from(vibeGoals).where(eq(vibeGoals.id, goalId));

    // Wants to Profile Matching Mapping
    const profileWantsMap: Record<string, string[]> = {
      "code-review": ["review", "verify"],
      architect: ["review", "decide"],
      implementation: ["fix"],
      debugging: ["fix", "investigate"],
      testing: ["verify"],
      documentation: ["document"],
      reviewer: ["decide"],
      research: ["investigate"],
    };

    const actionableWants = profile.flatMap((p) => profileWantsMap[p] ?? []);

    // Step 2 & 3: Eligibility & Scoring
    const scoredLoops = openLoops.map((loop) => {
      let score = 0;
      const wants = (loop.wants as string[]) ?? [];

      // Profile Matching Match
      const matchesProfile = wants.some((w) => actionableWants.includes(w));
      if (matchesProfile) score += 100;

      // Intent based priority
      if (loop.intent === "risk" || loop.intent === "warning") score += 80;
      else if (loop.intent === "patch" && wants.includes("verify")) score += 60;
      else if (loop.intent === "question") score += 40;
      else score += 20;

      return { ...loop, score, matchesProfile };
    });

    // Sort by Score descending
    scoredLoops.sort((a, b) => b.score - a.score);

    // Step 5: Brief generation (Compaction view)
    let brief = "## Goal Room Brief\n";
    brief += `**Goal ID**: ${goalId}\n`;
    if (goal) {
      brief += `**Goal URI**: ${goal.goalUri}\n`;
      brief += `**Goal Title**: ${goal.title}\n\n`;
    }

    if (pinnedMemories.length > 0) {
      brief += "### 📌 Pinned Checkpoints\n";
      for (const pin of pinnedMemories) {
        const refs = (pin.refs as string[]) ?? [];
        brief += `- [${pin.actorId}]: ${pin.text} ${refs.length > 0 ? `(Refs: ${refs.join(", ")})` : ""}\n`;
      }
      brief += "\n";
    }

    if (scoredLoops.length > 0) {
      brief += "### ⚡ Actionable Open Loops\n";
      for (const loop of scoredLoops) {
        const wants = (loop.wants as string[]) ?? [];
        const refs = (loop.refs as string[]) ?? [];
        const isUnverified = loop.evidenceStatus === "ungrounded";
        const validationLabel = isUnverified ? " [未検証]" : ` [Evidence: ${loop.evidenceStatus}]`;
        const actionMatch = loop.matchesProfile ? " 🔥 (Match)" : "";

        brief += `- [${loop.intent.toUpperCase()}] ${loop.actorId}: ${loop.text}`;
        brief += wants.length > 0 ? ` (Wants: ${wants.join(", ")})` : "";
        brief += refs.length > 0 ? ` (Refs: ${refs.join(", ")})` : "";
        brief += `${validationLabel}${actionMatch}\n`;

        const marks = (loop.marks as any[]) ?? [];
        const activeMarks = marks.filter((m) => m.mark !== "stale" && m.mark !== "superseded");
        if (activeMarks.length > 0) {
          brief += `  └─ Marks: ${activeMarks.map((m) => `[${m.mark}] ${m.note ?? ""}`).join(", ")}\n`;
        }
      }
      brief += "\n";
    }

    if (verifiedDecisions.length > 0) {
      brief += "### ✓ Verified Decisions\n";
      for (const dec of verifiedDecisions) {
        const refs = (dec.refs as string[]) ?? [];
        brief += `- ${dec.text} ${refs.length > 0 ? `(Refs: ${refs.join(", ")})` : ""} [Verified]\n`;
      }
      brief += "\n";
    }

    if (recentTimeline.length > 0) {
      brief += "### 🕒 Recent Timeline\n";
      for (const time of recentTimeline.reverse()) {
        const dateStr = new Date(time.createdAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        brief += `- [${dateStr}] [${time.intent}] ${time.actorId}: ${time.text}\n`;
      }
    }

    return [
      {
        brief,
        openLoops: scoredLoops,
        agentMemos,
        recentTimeline,
        pinned: pinnedMemories,
        decisions: verifiedDecisions,
        goal: goal,
      },
    ];
  }

  // Legacy Semantic / Text Search Fallback
  if (params.query) {
    const limit = params.limit ?? 10;
    const memories = await searchVibeMemories({
      query: params.query,
      sessionId: params.sessionId,
      limit,
    });

    return memories.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      content: m.content,
      memoryType: m.memoryType,
      createdAt: m.createdAt,
      score: m.score,
    }));
  }

  return [];
}

/**
 * List all Goal Rooms (v3)
 */
export async function listVibeGoals() {
  return db.select().from(vibeGoals).orderBy(desc(vibeGoals.createdAt));
}
