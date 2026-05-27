import type { ToolEntry } from "../registry.js";
import {
  sessionMemoSlotLimit,
  sessionMemoToolInputSchema,
} from "../../shared/schemas/session-memo.schema.js";
import {
  getSessionMemo,
  listSessionMemos,
  putManySessionMemos,
  putSessionMemo,
} from "../../modules/session-memo/session-memo.service.js";

function resolveSessionId(
  explicitSessionId: string | undefined,
  requestMeta?: Record<string, unknown>,
): string {
  const keys = ["sessionId", "threadId", "conversationId", "codexSessionId"] as const;
  for (const key of keys) {
    const value = requestMeta?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (explicitSessionId?.trim()) return explicitSessionId.trim();
  throw new Error(
    "SESSION_ID_REQUIRED: session_memo requires a session id from MCP metadata or explicit sessionId.",
  );
}

export const sessionMemoTool: ToolEntry = {
  name: "session_memo",
  description:
    "Session-scoped scratchpad. Store and retrieve short working notes such as goals, decisions, run IDs, quality checks, and open questions.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["put", "put_many", "list", "get"] },
      sessionId: { type: "string" },
      slot: {
        type: "number",
        description: "Optional slot locator used by action=get.",
      },
      kind: { type: "string" },
      title: { type: "string" },
      label: { type: "string" },
      body: { type: "string" },
      metadata: { type: "object" },
      expiresAt: { type: "string" },
      items: {
        type: "array",
        items: { type: "object" },
        minItems: 1,
        maxItems: sessionMemoSlotLimit,
      },
      includeEmpty: { type: "boolean", default: false },
      previewChars: { type: "number", default: 320 },
    },
    required: ["action"],
  },
  handler: async (args, context) => {
    const parsed = sessionMemoToolInputSchema.parse(args ?? {});
    const sessionId = resolveSessionId(parsed.sessionId, context?.requestMeta);

    if (parsed.action === "put") {
      if (!parsed.body) throw new Error("body is required");
      const saved = await putSessionMemo({
        sessionId,
        slot: undefined,
        kind: parsed.kind,
        title: parsed.title,
        label: parsed.label,
        body: parsed.body,
        metadata: parsed.metadata,
        expiresAt: parsed.expiresAt,
        source: "mcp",
      });
      return { content: [{ type: "text", text: JSON.stringify({ memo: saved }, null, 2) }] };
    }

    if (parsed.action === "put_many") {
      if (!parsed.items) throw new Error("items is required");
      const items = parsed.items.map((item) => ({
        slot: undefined,
        kind: item.kind,
        title: item.title,
        label: item.label,
        body: item.body,
        metadata: item.metadata,
        expiresAt: item.expiresAt,
      }));
      const saved = await putManySessionMemos(sessionId, items, "mcp");
      return { content: [{ type: "text", text: JSON.stringify({ items: saved }, null, 2) }] };
    }

    if (parsed.action === "list") {
      const items = await listSessionMemos({
        sessionId,
        includeEmpty: parsed.includeEmpty,
        previewChars: parsed.previewChars,
      });
      return { content: [{ type: "text", text: JSON.stringify({ sessionId, items }, null, 2) }] };
    }

    if (parsed.action === "get") {
      const memo = await getSessionMemo({ sessionId, slot: parsed.slot, label: parsed.label });
      return { content: [{ type: "text", text: JSON.stringify({ memo }, null, 2) }] };
    }

    throw new Error(`Unsupported action: ${parsed.action}`);
  },
};
