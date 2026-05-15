import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { agentDiffEntries, syncStates, vibeMemories } from "../../db/schema.js";
import {
  extractAgentDiffContentFromText,
  normalizeAgentDiffEntries,
  stripAgentDiffContentFromText,
} from "../vibe-memory/agent-diff-ingestion.service.js";
import {
  type ChatMessage,
  type IngestCursor,
  ingestAntigravityLogs,
  ingestCodexLogs,
  normalizeIngestCursor,
} from "./ingest.service.js";

type AgentLogSource = {
  id: "codex_logs" | "antigravity_logs";
  label: "Codex" | "Antigravity";
  ingest: (
    since?: Date,
    cursor?: IngestCursor,
  ) => Promise<{
    ok: boolean;
    errors: string[];
    warnings: string[];
    messages: ChatMessage[];
    cursor: IngestCursor;
    maxObservedMtimeMs: number;
    checkedFiles: number;
    skipped?: boolean;
  }>;
};

export type AgentLogSourceSyncSummary = {
  id: AgentLogSource["id"];
  label: AgentLogSource["label"];
  ok: boolean;
  skipped: boolean;
  checkedFiles: number;
  messages: number;
  insertedMemories: number;
  insertedDiffs: number;
  warnings: string[];
  errors: string[];
  lastSyncedAt: string | null;
};

export type AgentLogSyncSummary = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  imported: number;
  insertedDiffs: number;
  sources: AgentLogSourceSyncSummary[];
};

const sources: AgentLogSource[] = [
  { id: "codex_logs", label: "Codex", ingest: ingestCodexLogs },
  { id: "antigravity_logs", label: "Antigravity", ingest: ingestAntigravityLogs },
];

export function chunkMessages(
  messages: ChatMessage[],
  maxMessages = config.agentLogMaxMessagesPerChunk,
  maxChars = config.agentLogMaxCharsPerChunk,
): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentChars = 0;

  for (const message of messages) {
    const reachedMessageLimit = current.length >= maxMessages;
    const reachedCharLimit = current.length > 0 && currentChars + message.content.length > maxChars;

    if (reachedMessageLimit || reachedCharLimit) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(message);
    currentChars += message.content.length;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

function isToolCallMessage(message: ChatMessage): boolean {
  return message.metadata.messageKind === "tool_call";
}

function previewText(text: string, maxChars = 800): string {
  const compact = text.trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function getStringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBooleanMetadata(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeToolCallSummary(toolCall: unknown): Record<string, unknown> | null {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  const record = toolCall as Record<string, unknown>;
  const name = getStringMetadata(record, "name") ?? "tool";
  return {
    name,
    summary: getStringMetadata(record, "summary"),
    commandLine: getStringMetadata(record, "commandLine"),
    cwd: getStringMetadata(record, "cwd"),
    action: getStringMetadata(record, "action"),
    targetFile: getStringMetadata(record, "targetFile"),
    contentPreview: getStringMetadata(record, "contentPreview"),
    sourceTruncated: getBooleanMetadata(record, "sourceTruncated"),
    reconstructedFromFile: getBooleanMetadata(record, "reconstructedFromFile"),
  };
}

function summarizeToolMessage(message: ChatMessage): Record<string, unknown>[] {
  const toolCalls = message.metadata.toolCalls;
  if (Array.isArray(toolCalls)) {
    return toolCalls
      .map(sanitizeToolCallSummary)
      .filter((toolCall): toolCall is Record<string, unknown> => Boolean(toolCall))
      .map((toolCall) => ({
        ...toolCall,
        timestamp: message.metadata.timestamp,
        stepIndex: message.metadata.stepIndex,
      }));
  }

  return [
    {
      name: getStringMetadata(message.metadata, "toolName") ?? "tool",
      contentPreview: previewText(message.content),
      timestamp: message.metadata.timestamp,
    },
  ];
}

function collectToolCallSummaries(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.filter(isToolCallMessage).flatMap(summarizeToolMessage);
}

function firstMetadataString(messages: ChatMessage[], key: string): string | undefined {
  for (const message of messages) {
    const value = message.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function getSessionStartedAt(messages: ChatMessage[]): string | undefined {
  const timestamps = messages
    .flatMap((message) => [message.metadata.sessionStartedAt, message.metadata.timestamp])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  return timestamps[0]?.toISOString();
}

function formatSessionTitleTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function buildSessionTitle(source: AgentLogSource, messages: ChatMessage[]): string {
  const projectName = firstMetadataString(messages, "projectName") ?? "Unknown Project";
  const time = formatSessionTitleTime(getSessionStartedAt(messages));
  return [projectName, time, source.label].filter(Boolean).join(" / ");
}

export function buildReadableTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((message) => !isToolCallMessage(message))
    .map((message) => {
      const content = stripAgentDiffContentFromText(message.content);
      return content ? `${message.role.toUpperCase()}: ${content}` : "";
    })
    .filter((line) => !line.match(/^(USER|ASSISTANT):\s*$/))
    .join("\n\n");
}

export function buildMemorySessionId(sourceId: string, message: ChatMessage): string {
  const sessionId = message.metadata.sessionId;
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return `${sourceId}:${sessionId.trim()}`;
  }

  const sessionFile = message.metadata.sessionFile;
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    const digest = createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    return `${sourceId}:file:${digest}`;
  }

  return `${sourceId}:fallback`;
}

export function buildDedupeKey(params: {
  sourceId: string;
  memorySessionId: string;
  chunkIndex: number;
  content: string;
}): string {
  return createHash("sha256")
    .update(
      `${params.sourceId}\n${params.memorySessionId}\n${params.chunkIndex}\n${params.content}`,
    )
    .digest("hex");
}

export function extractUnifiedDiffsFromText(text: string): string {
  return extractAgentDiffContentFromText(text);
}

function getCheckpointDate(maxObservedMtimeMs: number, since?: Date): Date {
  if (Number.isFinite(maxObservedMtimeMs) && maxObservedMtimeMs > 0) {
    return new Date(maxObservedMtimeMs);
  }
  return since ?? new Date();
}

function mergeMessageMetadata(
  source: AgentLogSource,
  messages: ChatMessage[],
): Record<string, unknown> {
  const firstMetadata = messages.find((message) => message.metadata)?.metadata ?? {};
  const toolCalls = collectToolCallSummaries(messages);
  const projectName = firstMetadataString(messages, "projectName");
  const projectRoot = firstMetadataString(messages, "projectRoot");
  const sessionStartedAt = getSessionStartedAt(messages);
  const sessionFiles = Array.from(
    new Set(
      messages
        .map((message) => message.metadata.sessionFile)
        .filter((file): file is string => typeof file === "string" && file.length > 0),
    ),
  );

  return {
    ...firstMetadata,
    source: source.label,
    sourceId: source.id,
    sources: [source.label],
    sessionFiles,
    projectName,
    projectRoot,
    sessionStartedAt,
    sessionTitle: buildSessionTitle(source, messages),
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.slice(0, 100),
    toolCallsTruncated: toolCalls.length > 100,
    roles: Array.from(new Set(messages.map((message) => message.role))),
    kind: "agent_log_chunk",
    memoryPipeline: "raw_for_distillation",
  };
}

export async function syncAllAgentLogs(): Promise<AgentLogSyncSummary> {
  const startedAt = new Date();
  const summary: AgentLogSyncSummary = {
    ok: true,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    imported: 0,
    insertedDiffs: 0,
    sources: [],
  };

  for (const source of sources) {
    const [state] = await db.select().from(syncStates).where(eq(syncStates.id, source.id));
    const since = state?.lastSyncedAt ?? undefined;
    const cursor = normalizeIngestCursor(state?.cursor);
    const ingestResult = await source.ingest(since, cursor);

    if (!ingestResult.ok) {
      summary.ok = false;
      summary.sources.push({
        id: source.id,
        label: source.label,
        ok: false,
        skipped: Boolean(ingestResult.skipped),
        checkedFiles: ingestResult.checkedFiles,
        messages: 0,
        insertedMemories: 0,
        insertedDiffs: 0,
        warnings: ingestResult.warnings,
        errors: ingestResult.errors,
        lastSyncedAt: since?.toISOString() ?? null,
      });
      continue;
    }

    const messages = ingestResult.messages.filter((message) => message.content.trim().length > 0);
    const checkpointDate = getCheckpointDate(ingestResult.maxObservedMtimeMs, since);
    const sourceMetadata = {
      checkedFiles: ingestResult.checkedFiles,
      warnings: ingestResult.warnings,
      skipped: Boolean(ingestResult.skipped),
      messageCount: messages.length,
      syncedAt: new Date().toISOString(),
    };

    if (ingestResult.skipped) {
      summary.sources.push({
        id: source.id,
        label: source.label,
        ok: true,
        skipped: true,
        checkedFiles: ingestResult.checkedFiles,
        messages: 0,
        insertedMemories: 0,
        insertedDiffs: 0,
        warnings: ingestResult.warnings,
        errors: [],
        lastSyncedAt: since?.toISOString() ?? null,
      });
      continue;
    }

    const messagesBySession = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const memorySessionId = buildMemorySessionId(source.id, message);
      const bucket = messagesBySession.get(memorySessionId);
      if (bucket) {
        bucket.push(message);
      } else {
        messagesBySession.set(memorySessionId, [message]);
      }
    }

    let insertedMemories = 0;
    let insertedDiffs = 0;

    await db.transaction(async (tx) => {
      for (const [memorySessionId, sessionMessages] of messagesBySession.entries()) {
        const chunks = chunkMessages(sessionMessages);

        for (const [chunkIndex, chunk] of chunks.entries()) {
          const rawContent = buildTranscript(chunk);
          const readableContent = buildReadableTranscript(chunk);
          const diff = extractUnifiedDiffsFromText(rawContent);
          const diffEntries = normalizeAgentDiffEntries({ diff });
          const hiddenToolCallCount = chunk.filter((message) => isToolCallMessage(message)).length;
          if (!readableContent.trim() && diffEntries.length === 0 && hiddenToolCallCount === 0) {
            continue;
          }
          const content =
            readableContent.trim() ||
            (diffEntries.length > 0 ? "Agent diff recorded." : "Tool usage recorded.");
          const dedupeKey = buildDedupeKey({
            sourceId: source.id,
            memorySessionId,
            chunkIndex,
            content: rawContent,
          });
          const [inserted] = await tx
            .insert(vibeMemories)
            .values({
              sessionId: memorySessionId,
              content,
              memoryType: "chat",
              dedupeKey,
              metadata: {
                ...mergeMessageMetadata(source, chunk),
                chunkIndex,
                dedupeKey,
                rawContentHash: buildDedupeKey({
                  sourceId: source.id,
                  memorySessionId,
                  chunkIndex,
                  content: rawContent,
                }),
                hiddenToolCallCount,
                agentDiffCount: diffEntries.length,
              },
            })
            .onConflictDoNothing({
              target: [vibeMemories.sessionId, vibeMemories.dedupeKey],
            })
            .returning({ id: vibeMemories.id });

          if (!inserted) {
            continue;
          }

          insertedMemories += 1;

          if (diffEntries.length === 0) continue;

          const insertedEntries = await tx
            .insert(agentDiffEntries)
            .values(
              diffEntries.map((entry) => ({
                vibeMemoryId: inserted.id,
                filePath: entry.filePath,
                diffHunk: entry.diffHunk,
                changeType: entry.changeType ?? null,
                language: entry.language ?? null,
                symbolName: entry.symbolName ?? null,
                symbolKind: entry.symbolKind ?? null,
                signature: entry.signature ?? null,
                startLine: entry.startLine ?? null,
                endLine: entry.endLine ?? null,
                metadata: {
                  ...entry.metadata,
                  extractedFrom: "agent_log_sync",
                  dedupeKey,
                  sourceId: source.id,
                },
              })),
            )
            .returning({ id: agentDiffEntries.id });
          insertedDiffs += insertedEntries.length;
        }
      }

      const now = new Date();
      await tx
        .insert(syncStates)
        .values({
          id: source.id,
          lastSyncedAt: checkpointDate,
          cursor: ingestResult.cursor,
          metadata: sourceMetadata,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: syncStates.id,
          set: {
            lastSyncedAt: checkpointDate,
            cursor: ingestResult.cursor,
            metadata: sourceMetadata,
            updatedAt: now,
          },
        });
    });

    summary.imported += insertedMemories;
    summary.insertedDiffs += insertedDiffs;
    summary.sources.push({
      id: source.id,
      label: source.label,
      ok: true,
      skipped: false,
      checkedFiles: ingestResult.checkedFiles,
      messages: messages.length,
      insertedMemories,
      insertedDiffs,
      warnings: ingestResult.warnings,
      errors: [],
      lastSyncedAt: checkpointDate.toISOString(),
    });
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
