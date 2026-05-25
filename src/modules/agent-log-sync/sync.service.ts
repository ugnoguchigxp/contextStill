import { eq, like } from "drizzle-orm";
import { db } from "../../db/client.js";
import { agentDiffEntries, syncStates, vibeMemories } from "../../db/schema.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  auditEventTypes,
  cleanupExpiredAuditLogsSafe,
  recordAuditLogSafe,
} from "../audit/audit-log.service.js";
import {
  normalizeAgentDiffEntries,
} from "../vibe-memory/agent-diff-ingestion.service.js";
import {
  type ChatMessage,
  type IngestCursor,
  ingestAntigravityLogs,
  ingestCodexLogs,
  ingestClaudeLogs,
  normalizeIngestCursor,
} from "./ingest.service.js";
import {
  buildDedupeKey,
  buildMemorySessionId,
  buildReadableTranscript,
  buildTranscript,
  chunkMessages,
  extractAgentDiffsFromToolCalls,
  extractUnifiedDiffsFromText,
  getCheckpointDate,
  isNonDistillableAgentTaskLogMessage,
  isToolCallMessage,
  mergeMessageMetadata,
} from "./sync.service.helpers.js";

type AgentLogSource = {
  id: "codex_logs" | "antigravity_logs" | "claude_logs";
  label: "Codex" | "Antigravity" | "Claude";
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

type AgentLogSourceSyncSummary = {
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
  { id: "claude_logs", label: "Claude", ingest: ingestClaudeLogs },
];
export {
  buildDedupeKey,
  buildReadableTranscript,
  chunkMessages,
  extractUnifiedDiffsFromText,
  isNonDistillableAgentTaskLogMessage,
};

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
  await recordAuditLogSafe({
    eventType: auditEventTypes.syncRunStarted,
    actor: "system",
    payload: {
      sourceIds: sources.map((source) => source.id),
    },
  });

  try {
    const { getRuntimeSettings } = await import("../settings/runtime-settings.js");
    const settings = await getRuntimeSettings();
    const enabledBySourceId: Record<string, boolean> = {
      codex_logs: settings.advanced.codexLogSyncEnabled,
      antigravity_logs: settings.advanced.antigravityLogSyncEnabled,
      claude_logs: settings.advanced.claudeLogSyncEnabled,
    };

    for (const source of sources) {
      const [state] = await db.select().from(syncStates).where(eq(syncStates.id, source.id));

      const enabled = enabledBySourceId[source.id] ?? true;
      if (!enabled) {
        summary.sources.push({
          id: source.id,
          label: source.label,
          ok: true,
          skipped: true,
          checkedFiles: 0,
          messages: 0,
          insertedMemories: 0,
          insertedDiffs: 0,
          warnings: [],
          errors: [],
          lastSyncedAt: state?.lastSyncedAt?.toISOString() ?? null,
        });
        continue;
      }

      // Antigravity ログの 2.0 移行自動クリーンアップ判定
      const isFirst20Sync =
        source.id === "antigravity_logs" &&
        (!state ||
          (state.metadata as Record<string, unknown> | undefined)?.formatVersion !== "2.0");

      const since = isFirst20Sync ? undefined : (state?.lastSyncedAt ?? undefined);
      const cursor = isFirst20Sync ? {} : normalizeIngestCursor(state?.cursor);
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

      const messages = ingestResult.messages.filter(
        (message) =>
          message.content.trim().length > 0 && !isNonDistillableAgentTaskLogMessage(message),
      );
      const checkpointDate = getCheckpointDate(ingestResult.maxObservedMtimeMs, since);
      const sourceMetadata = {
        checkedFiles: ingestResult.checkedFiles,
        warnings: ingestResult.warnings,
        skipped: Boolean(ingestResult.skipped),
        messageCount: messages.length,
        syncedAt: new Date().toISOString(),
        formatVersion: "2.0", // 2.0 移行の識別子
      };
      const redactedSourceMetadata = redactSecretRecord(sourceMetadata);

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
        if (isFirst20Sync) {
          // 旧 Antigravity 会話ログに関連するメモリデータを DB から全削除
          if (typeof tx.delete === "function") {
            await tx.delete(vibeMemories).where(like(vibeMemories.sessionId, "antigravity_logs:%"));
            console.log("[Cleanup] Deleted legacy Antigravity vibe memories from DB successfully.");
          }
        }

        for (const [memorySessionId, sessionMessages] of messagesBySession.entries()) {
          const chunks = chunkMessages(sessionMessages);

          for (const [chunkIndex, chunk] of chunks.entries()) {
            const rawContent = buildTranscript(chunk);
            const readableContent = buildReadableTranscript(chunk);
            const diff = extractUnifiedDiffsFromText(rawContent);
            const toolCallDiffs = extractAgentDiffsFromToolCalls(chunk);
            const diffEntries = normalizeAgentDiffEntries({
              diff,
              agentDiffs: toolCallDiffs,
            });

            const hiddenToolCallCount = chunk.filter((message) =>
              isToolCallMessage(message),
            ).length;
            if (!readableContent.trim() && diffEntries.length === 0 && hiddenToolCallCount === 0) {
              continue;
            }
            const content =
              readableContent.trim() ||
              (diffEntries.length > 0 ? "Agent diff recorded." : "Tool usage recorded.");
            const redactedContent = redactSecrets(content);
            const dedupeKey = buildDedupeKey({
              sourceId: source.id,
              memorySessionId,
              chunkIndex,
            });
            const [inserted] = await tx
              .insert(vibeMemories)
              .values({
                sessionId: memorySessionId,
                content: redactedContent,
                memoryType: "chat",
                dedupeKey,
                metadata: redactSecretRecord({
                  ...mergeMessageMetadata(source, chunk),
                  chunkIndex,
                  dedupeKey,
                  hiddenToolCallCount,
                  agentDiffCount: diffEntries.length,
                }),
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
                  diffHunk: redactSecrets(entry.diffHunk),
                  changeType: entry.changeType ?? null,
                  language: entry.language ?? null,
                  symbolName: entry.symbolName ?? null,
                  symbolKind: entry.symbolKind ?? null,
                  signature: entry.signature ?? null,
                  startLine: entry.startLine ?? null,
                  endLine: entry.endLine ?? null,
                  metadata: redactSecretRecord({
                    ...entry.metadata,
                    extractedFrom: "agent_log_sync",
                    dedupeKey,
                    sourceId: source.id,
                  }),
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
            metadata: redactedSourceMetadata,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: syncStates.id,
            set: {
              lastSyncedAt: checkpointDate,
              cursor: ingestResult.cursor,
              metadata: redactedSourceMetadata,
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
    const cleanup = await cleanupExpiredAuditLogsSafe({ trigger: "sync" });
    await recordAuditLogSafe({
      eventType: auditEventTypes.syncRunFinished,
      actor: "system",
      payload: {
        ...summary,
        cleanup: cleanup ?? null,
      },
    });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary.ok = false;
    summary.finishedAt = new Date().toISOString();
    await recordAuditLogSafe({
      eventType: auditEventTypes.syncRunFinished,
      actor: "system",
      payload: {
        ...summary,
        error: message,
      },
    });
    throw error;
  }
}
