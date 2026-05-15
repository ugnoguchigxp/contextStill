import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  type AgentDiffEntry,
  type VibeMemory,
  deleteVibeMemory,
  fetchAgentDiffEntries,
  fetchVibeMemories,
} from "../repositories/admin.repository";
import { type ChatTurn, getChatRoleLabel, parseVibeMemoryTurns } from "./chat-rendering";

type ToolCallSummary = {
  name: string;
  summary?: string;
  commandLine?: string;
  cwd?: string;
  action?: string;
  targetFile?: string;
  contentPreview?: string;
  sourceTruncated?: boolean;
  reconstructedFromFile?: boolean;
};

type SessionSummary = {
  id: string;
  title: string;
  sourceLabel: string;
  projectRoot?: string;
  lastCreatedAt: Date;
  count: number;
};

export function VibeMemoryPage() {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const memories = useQuery({
    queryKey: ["vibe-memories", 200],
    queryFn: () => fetchVibeMemories(200),
  });

  const sessionMap =
    memories.data?.reduce(
      (acc, m) => {
        if (!acc[m.sessionId]) acc[m.sessionId] = [];
        acc[m.sessionId].push(m);
        return acc;
      },
      {} as Record<string, typeof memories.data>,
    ) ?? {};

  const sessions = Object.entries(sessionMap)
    .map(([id, items]) => buildSessionSummary(id, items))
    .sort((a, b) => b.lastCreatedAt.getTime() - a.lastCreatedAt.getTime());

  // Default to the latest session
  const activeSessionId = selectedSessionId ?? sessions[0]?.id;
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeMemories = activeSessionId
    ? (sessionMap[activeSessionId] || []).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
    : [];

  const activeMemoryIds = activeMemories.map((memory) => memory.id);

  const diffEntries = useQuery({
    queryKey: ["agent-diffs", "vibe-memory", activeMemoryIds],
    queryFn: () => fetchAgentDiffEntries(500, { vibeMemoryIds: activeMemoryIds }),
    enabled: activeMemoryIds.length > 0,
  });

  const diffsByMemoryId = groupAgentDiffsByMemory(diffEntries.data ?? []);

  const remove = useMutation({
    mutationFn: deleteVibeMemory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vibe-memories"] });
      queryClient.invalidateQueries({ queryKey: ["agent-diffs"] });
    },
  });

  return (
    <div className="vibe-layout">
      {/* Sidebar: Session List */}
      <aside className="vibe-sidebar">
        <div className="sidebar-header">
          <h2>Vibe Sessions</h2>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`session-item ${activeSessionId === s.id ? "active" : ""}`}
              onClick={() => setSelectedSessionId(s.id)}
              title={s.id}
            >
              <div className="session-info">
                <span className="session-title-label">{s.title}</span>
                <span className="session-meta">
                  {s.sourceLabel} · {s.count} vibes
                </span>
                {s.projectRoot ? (
                  <span className="session-project-root">{s.projectRoot}</span>
                ) : null}
              </div>
            </button>
          ))}
          {sessions.length === 0 && !memories.isLoading && (
            <div className="empty-state">No sessions found</div>
          )}
        </div>
      </aside>

      {/* Main Content: Vibe History */}
      <main className="vibe-main">
        {activeSessionId ? (
          <>
            <header className="vibe-content-header">
              <div className="header-title">
                <h1>{activeSession?.title ?? activeSessionId}</h1>
                <Badge variant="outline">{activeMemories.length} records</Badge>
              </div>
              {activeSession?.projectRoot ? (
                <div className="header-meta">
                  <span>{activeSession.projectRoot}</span>
                </div>
              ) : null}
            </header>
            <div className="vibe-history">
              {activeMemories.map((m) => {
                const turns = parseVibeMemoryTurns(m.content);
                const toolCalls = extractToolCalls(m);
                const memoryDiffs = diffsByMemoryId.get(m.id) ?? [];

                return (
                  <div key={m.id} className={`vibe-card vibe-type-${m.memoryType}`}>
                    <div className="vibe-card-header">
                      <Badge variant="secondary" className="type-badge">
                        {m.memoryType}
                      </Badge>
                      <span className="vibe-timestamp">
                        {new Date(m.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="vibe-card-body">
                      <ChatTranscript turns={turns} />
                    </div>
                    <MemoryAuxiliaryPanel toolCalls={toolCalls} agentDiffs={memoryDiffs} />
                    <div className="vibe-card-footer">
                      <button
                        type="button"
                        className="vibe-delete-link"
                        onClick={() => {
                          if (confirm("Delete this memory record?")) {
                            remove.mutate(m.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="vibe-empty-view">
            <p>セッションを選択してください</p>
          </div>
        )}
      </main>
    </div>
  );
}

function buildSessionSummary(id: string, items: VibeMemory[]): SessionSummary {
  const lastCreatedAt =
    latestMetadataTime(items, "timestamp") ??
    new Date(Math.max(...items.map((item) => new Date(item.createdAt).getTime())));
  const firstCreatedAt = new Date(
    Math.min(...items.map((item) => new Date(item.createdAt).getTime())),
  );
  const projectName = firstMetadataString(items, "projectName") ?? "Unknown Project";
  const projectRoot = firstMetadataString(items, "projectRoot");
  const sourceLabel = firstMetadataString(items, "source") ?? "Agent";
  const startedAt = earliestMetadataTime(items, "sessionStartedAt") ?? firstCreatedAt.toISOString();

  return {
    id,
    title: [projectName, formatSessionTime(startedAt), sourceLabel].join(" / "),
    sourceLabel,
    projectRoot,
    lastCreatedAt,
    count: items.length,
  };
}

function earliestMetadataTime(items: VibeMemory[], key: string): string | undefined {
  const times = items
    .map((item) => item.metadata?.[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return times[0]?.toISOString();
}

function latestMetadataTime(items: VibeMemory[], key: string): Date | undefined {
  const times = items
    .map((item) => item.metadata?.[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return times[0];
}

function firstMetadataString(items: VibeMemory[], key: string): string | undefined {
  for (const item of items) {
    const value = item.metadata?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function ChatTranscript({ turns }: { turns: ChatTurn[] }) {
  if (turns.length === 0) {
    return <p className="vibe-muted-text">自然言語の会話本文はありません。</p>;
  }

  return (
    <div className="chat-turns">
      {turns.map((turn, index) => (
        <div key={`${turn.role}-${index}`} className={`chat-turn chat-turn-${turn.role}`}>
          <span className="chat-turn-role">{getChatRoleLabel(turn.role)}</span>
          <div className="chat-turn-content">{turn.content}</div>
        </div>
      ))}
    </div>
  );
}

function MemoryAuxiliaryPanel({
  toolCalls,
  agentDiffs,
}: {
  toolCalls: ToolCallSummary[];
  agentDiffs: AgentDiffEntry[];
}) {
  if (toolCalls.length === 0 && agentDiffs.length === 0) return null;

  return (
    <div className="vibe-auxiliary-panel">
      {toolCalls.length > 0 ? (
        <details className="vibe-accordion">
          <summary>
            <span>Tool Usage</span>
            <Badge variant="outline">{toolCalls.length}</Badge>
          </summary>
          <div className="tool-call-list">
            {toolCalls.map((toolCall, index) => (
              <div key={`${toolCall.name}-${index}`} className="tool-call-item">
                <div className="tool-call-name">{toolCall.name}</div>
                {toolCall.summary ? (
                  <div className="tool-call-summary">{toolCall.summary}</div>
                ) : null}
                {toolCall.commandLine ? (
                  <code className="tool-call-command">{toolCall.commandLine}</code>
                ) : null}
                {toolCall.cwd ? <div className="tool-call-cwd">{toolCall.cwd}</div> : null}
                {toolCall.targetFile ? (
                  <div className="tool-call-cwd">{toolCall.targetFile}</div>
                ) : null}
                {toolCall.sourceTruncated ? (
                  <div className="tool-call-note">
                    {toolCall.reconstructedFromFile
                      ? "Antigravity のログは省略されていましたが、現在のファイル内容から展開しています。"
                      : "Antigravity のログ内で既に省略されています。"}
                  </div>
                ) : null}
                {toolCall.contentPreview ? (
                  <pre className="tool-call-preview">{toolCall.contentPreview}</pre>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {agentDiffs.length > 0 ? (
        <details className="vibe-accordion">
          <summary>
            <span>Agent Diff</span>
            <Badge variant="outline">{agentDiffs.length}</Badge>
          </summary>
          <div className="agent-diff-accordion-list">
            {agentDiffs.slice(0, 80).map((entry) => (
              <details key={entry.id} className="agent-diff-accordion-item">
                <summary>
                  <span className="agent-diff-title">{formatAgentDiffTitle(entry.filePath)}</span>
                  <span className="agent-diff-meta">{formatAgentDiffMeta(entry)}</span>
                </summary>
                <div className="agent-diff-file">{entry.filePath}</div>
                <pre className="agent-diff-hunk">{entry.diffHunk}</pre>
              </details>
            ))}
            {agentDiffs.length > 80 ? (
              <div className="vibe-muted-text">他 {agentDiffs.length - 80} 件は省略表示</div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function groupAgentDiffsByMemory(entries: AgentDiffEntry[]): Map<string, AgentDiffEntry[]> {
  const map = new Map<string, AgentDiffEntry[]>();
  for (const entry of entries) {
    const current = map.get(entry.vibeMemoryId) ?? [];
    current.push(entry);
    map.set(entry.vibeMemoryId, current);
  }
  return map;
}

function formatAgentDiffTitle(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? filePath;
}

function formatAgentDiffMeta(entry: AgentDiffEntry): string {
  if (entry.symbolName) {
    return [entry.symbolKind, entry.symbolName].filter(Boolean).join(": ");
  }
  return entry.changeType ?? "diff";
}

function extractToolCalls(memory: VibeMemory): ToolCallSummary[] {
  const rawToolCalls = memory.metadata?.toolCalls;
  if (!Array.isArray(rawToolCalls)) return [];

  const toolCalls: ToolCallSummary[] = [];
  for (const toolCall of rawToolCalls) {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) continue;
    const record = toolCall as Record<string, unknown>;
    toolCalls.push({
      name: readString(record.name) ?? "tool",
      summary: readString(record.summary),
      commandLine: readString(record.commandLine),
      cwd: readString(record.cwd),
      action: readString(record.action),
      targetFile: readString(record.targetFile),
      contentPreview: readString(record.contentPreview),
      sourceTruncated: readBoolean(record.sourceTruncated),
      reconstructedFromFile: readBoolean(record.reconstructedFromFile),
    });
  }

  return toolCalls;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
