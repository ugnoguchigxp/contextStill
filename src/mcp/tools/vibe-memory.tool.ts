import type { ToolEntry } from "../registry.js";
import {
  markVibeMemory,
  recordVibeMemoryCapsule,
  retrieveVibeMemoryContext,
} from "../../modules/vibe-memory/vibe-memory.service.js";
import {
  markVibeMemoryInputSchema,
  recordVibeMemoryCapsuleInputSchema,
} from "../../shared/schemas/vibe-memory.schema.js";

function resolveActorId(
  explicitActorId: string | undefined,
  requestMeta?: Record<string, unknown>,
): string {
  if (explicitActorId?.trim()) return explicitActorId.trim();
  const keys = ["agentId", "agentName", "sessionId", "conversationId"] as const;
  for (const key of keys) {
    const value = requestMeta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "agent-vibe";
}

/**
 * vibe_memory_say: Place a new memory Capsule in a Goal Room
 */
export const vibeMemorySayTool: ToolEntry = {
  name: "vibe_memory_say",
  description: "Place a new Capsule (shared note, task, findings, decision) inside a Goal Room.",
  inputSchema: {
    type: "object",
    properties: {
      goalId: { type: "string", description: "Goal Room stable ID (SHA-256 hash or stable ID)." },
      goalUri: {
        type: "string",
        description: "Normalized Goal URI. e.g. repo://org/repo/spec/plan.md",
      },
      goalAnchorRef: {
        type: "string",
        description: "Absolute path reference of the local implementation plan file.",
      },
      subject: { type: "string", description: "Subject context. e.g. 'PR#128', 'src/server.ts'" },
      intent: {
        type: "string",
        enum: [
          "ask",
          "note",
          "finding",
          "review",
          "question",
          "answer",
          "decision",
          "risk",
          "warning",
          "patch",
          "result",
          "verify",
          "checkpoint",
        ],
        description: "Intended type of message.",
      },
      wants: {
        type: "array",
        items: { type: "string" },
        description:
          "Actionable wants required from other agents. e.g. ['review', 'fix', 'verify']",
      },
      text: { type: "string", description: "Message body. Keep it concise." },
      refs: {
        type: "array",
        items: { type: "string" },
        description: "Structured evidence references (file://, git://, doc:// etc.).",
      },
      confidence: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "Self-assessed confidence level.",
      },
      metadata: { type: "object", description: "Additional metadata." },
      actorId: { type: "string", description: "Explicit identifier of the posting agent." },
      ttlHours: { type: "number", description: "Time-to-live hours for auto-compaction cleanups." },
    },
    required: ["goalId", "intent", "text"],
  },
  handler: async (args, context) => {
    const actorId = resolveActorId((args as any)?.actorId, context?.requestMeta);
    const parsed = recordVibeMemoryCapsuleInputSchema.parse({
      ...(args ?? {}),
      actorId,
    });

    const capsule = await recordVibeMemoryCapsule(parsed);
    return { content: [{ type: "text", text: JSON.stringify({ capsule }, null, 2) }] };
  },
};

/**
 * vibe_memory_reply: Reply to an existing Capsule
 */
export const vibeMemoryReplyTool: ToolEntry = {
  name: "vibe_memory_reply",
  description: "Reply to an existing Capsule inside a Goal Room to form a thread.",
  inputSchema: {
    type: "object",
    properties: {
      goalId: { type: "string", description: "Goal Room stable ID." },
      parentId: {
        type: "string",
        description: "Parent Capsule UUID (the message being replied to).",
      },
      subject: { type: "string", description: "Subject context." },
      intent: {
        type: "string",
        enum: [
          "ask",
          "note",
          "finding",
          "review",
          "question",
          "answer",
          "decision",
          "risk",
          "warning",
          "patch",
          "result",
          "verify",
          "checkpoint",
        ],
        description: "Intended type of reply.",
      },
      wants: {
        type: "array",
        items: { type: "string" },
        description: "Actionable wants from other agents.",
      },
      text: { type: "string", description: "Concise reply text." },
      refs: {
        type: "array",
        items: { type: "string" },
        description: "Structured evidence references.",
      },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      metadata: { type: "object" },
      actorId: { type: "string" },
    },
    required: ["goalId", "parentId", "intent", "text"],
  },
  handler: async (args, context) => {
    const actorId = resolveActorId((args as any)?.actorId, context?.requestMeta);
    const parsed = recordVibeMemoryCapsuleInputSchema.parse({
      ...(args ?? {}),
      actorId,
    });

    const capsule = await recordVibeMemoryCapsule(parsed);
    return { content: [{ type: "text", text: JSON.stringify({ capsule }, null, 2) }] };
  },
};

/**
 * vibe_memory_peek: Peek unresolved Open Loops and current Brief context of the Goal Room
 */
export const vibeMemoryPeekTool: ToolEntry = {
  name: "vibe_memory_peek",
  description:
    "Peek actionable Open Loops and localized Goal Room Brief tailored for the agent's profile.",
  inputSchema: {
    type: "object",
    properties: {
      goalId: { type: "string", description: "Goal Room stable ID to view." },
      profile: {
        type: "array",
        items: { type: "string" },
        description:
          "Agent capabilities profile to highlight matched Wants. e.g. ['code-review', 'implementation']",
      },
    },
    required: ["goalId"],
  },
  handler: async (args) => {
    const goalId = (args as any)?.goalId;
    if (!goalId) throw new Error("goalId is required");
    const profile = (args as any)?.profile ?? [];

    const [contextPack] = await retrieveVibeMemoryContext({
      goalId,
      profile,
    });

    if (!contextPack) {
      return { content: [{ type: "text", text: "Goal Room is currently empty." }] };
    }

    return { content: [{ type: "text", text: contextPack.brief }] };
  },
};

/**
 * vibe_memory_mark: Add a status Mark (付箋) to a Capsule
 */
export const vibeMemoryMarkTool: ToolEntry = {
  name: "vibe_memory_mark",
  description:
    "Mark a Capsule with a status label. Useful for resolutions, verification, staling, or pinning checkpoints.",
  inputSchema: {
    type: "object",
    properties: {
      goalId: { type: "string", description: "Goal Room stable ID." },
      targetMemoryId: { type: "string", description: "Capsule UUID to attach the mark to." },
      mark: {
        type: "string",
        enum: [
          "resolved",
          "verified",
          "needs_fix",
          "needs_verify",
          "stale",
          "superseded",
          "wrong",
          "accepted_risk",
          "pinned",
        ],
        description: "Label type to mark the Capsule.",
      },
      note: { type: "string", description: "Optional explanation note." },
      actorId: { type: "string" },
    },
    required: ["goalId", "targetMemoryId", "mark"],
  },
  handler: async (args, context) => {
    const actorId = resolveActorId((args as any)?.actorId, context?.requestMeta);
    const parsed = markVibeMemoryInputSchema.parse({
      ...(args ?? {}),
      actorId,
    });

    const mark = await markVibeMemory(parsed);
    return { content: [{ type: "text", text: JSON.stringify({ mark }, null, 2) }] };
  },
};
