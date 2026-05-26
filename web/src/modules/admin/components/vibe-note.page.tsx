import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import mermaid from "mermaid";
import { MarkdownEditor } from "markdown-wysiwyg-editor";
import { useEffect, useMemo, useState } from "react";
import {
  type SessionMemoSessionListItem,
  type VibeMemory,
  fetchSessionMemoSessions,
  fetchSessionMemos,
  fetchVibeMemories,
} from "../repositories/admin.repository";
import { parseVibeMemoryTurns } from "./chat-rendering";

type SessionSummary = {
  id: string;
  title: string;
  firstMessage?: string;
  sourceLabel: string;
  count: number;
  projectName: string;
  startedAt: string;
  lastCreatedAt: Date;
};

mermaid.initialize({ startOnLoad: false });

export function VibeNotePage() {
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const sessionIdFromQuery = useMemo(
    () => new URLSearchParams(search).get("sessionId") ?? "",
    [search],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    sessionIdFromQuery || null,
  );

  const memoSessions = useQuery({
    queryKey: ["session-memo-sessions", 400, "include-compile-only"],
    queryFn: () => fetchSessionMemoSessions(400, { includeCompileOnly: true }),
  });
  const memories = useQuery({
    queryKey: ["vibe-memories", 2000],
    queryFn: () => fetchVibeMemories(2000),
  });

  const memorySessionSummaryByRawId = useMemo(() => {
    const map = new Map<string, VibeMemory[]>();
    for (const memory of memories.data ?? []) {
      const entries = map.get(memory.sessionId);
      if (entries) {
        entries.push(memory);
        continue;
      }
      map.set(memory.sessionId, [memory]);
    }
    const summaryByRawId = new Map<string, SessionSummary>();
    for (const [id, items] of map.entries()) {
      const summary = buildSessionSummary(id, items);
      const rawSessionId = rawSessionIdFromMemoryGroup(id, items);
      summaryByRawId.set(rawSessionId, summary);
    }
    return summaryByRawId;
  }, [memories.data]);

  const sessions = useMemo(() => {
    return (memoSessions.data ?? [])
      .map((item) =>
        buildSessionSummaryForMemoSession({
          item,
          memorySummary: memorySessionSummaryByRawId.get(rawSessionIdFromSessionId(item.sessionId)),
        }),
      )
      .sort((a, b) => b.lastCreatedAt.getTime() - a.lastCreatedAt.getTime());
  }, [memoSessions.data, memorySessionSummaryByRawId]);

  const resolvedSelectedSessionId = useMemo(
    () => resolveMemoSessionId(selectedSessionId, sessions),
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== null) setSelectedSessionId(null);
      return;
    }
    if (resolvedSelectedSessionId !== null) {
      if (selectedSessionId !== resolvedSelectedSessionId) {
        setSelectedSessionId(resolvedSelectedSessionId);
      }
      return;
    }
    if (selectedSessionId !== sessions[0].id) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [sessions, selectedSessionId, resolvedSelectedSessionId]);

  const activeSessionId = resolvedSelectedSessionId ?? sessions[0]?.id ?? "";

  const notes = useQuery({
    queryKey: ["session-memos", activeSessionId],
    queryFn: () => fetchSessionMemos(activeSessionId, { previewChars: 2000 }),
    enabled: activeSessionId.length > 0,
  });

  return (
    <div className="vibe-layout">
      <aside className="vibe-sidebar">
        <div className="sidebar-header">
          <h2>Vibe Sessions</h2>
        </div>
        <div className="session-list">
          {sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              className={`session-item ${activeSessionId === session.id ? "active" : ""}`}
              onClick={() => setSelectedSessionId(session.id)}
              title={session.id}
            >
              <div className="session-info">
                <div className="session-project-line">
                  <span className="session-project-name">
                    {session.firstMessage || session.projectName || "New Session"}
                  </span>
                  <span className="session-time-label">
                    {formatSessionTimeCompact(session.startedAt)}
                  </span>
                </div>
                <div className="session-meta-line">
                  <span className="session-meta-project">{session.projectName}</span>
                  <span>·</span>
                  <span>{session.sourceLabel}</span>
                  <span>·</span>
                  <span>{session.count} notes</span>
                </div>
              </div>
            </button>
          ))}
          {sessions.length === 0 && !memoSessions.isLoading ? (
            <div className="empty-state">No sessions with notes</div>
          ) : null}
        </div>
      </aside>
      <main className="vibe-main">
        <header className="vibe-content-header">
          <div className="header-title">
            <h1>Vibe Note</h1>
            <Badge variant="outline">{activeSessionId || "No Session"}</Badge>
          </div>
          <div className="header-meta">
            {activeSessionId ? (
              <a href={`/vibe-memory?sessionId=${encodeURIComponent(activeSessionId)}`}>
                Vibe Memoryへ
              </a>
            ) : null}
          </div>
        </header>
        {!activeSessionId ? <div className="vibe-empty-view">セッションがありません。</div> : null}
        <div className="vibe-note-content">
          <div className="vibe-history">
            {notes.data?.items?.length ? (
              notes.data.items.map((item) => {
                const slotNum = Number(item.slot);
                const kind = typeof item.kind === "string" ? item.kind : "scratch";
                const title =
                  typeof item.metadata?.title === "string" ? item.metadata.title : undefined;
                const score =
                  typeof item.metadata?.score === "number" ? item.metadata.score : undefined;
                const createdAtText = formatOptionalTimestamp(item.createdAt);
                const isCompileResult = kind === "compile_result";
                const bodyText = isCompileResult
                  ? (item.linkedOutputMarkdown ?? "参照先なし")
                  : String(item.preview ?? "");
                return (
                  <div key={slotNum} className="vibe-card">
                    <div className="vibe-card-header">
                      <Badge variant="secondary">slot {slotNum}</Badge>
                      <Badge variant="outline">{kind}</Badge>
                      {item.label ? <span>{String(item.label)}</span> : null}
                      {title ? <span>{title}</span> : null}
                      {score !== undefined ? (
                        <span className="vibe-note-score">score {score}</span>
                      ) : null}
                      {createdAtText ? <span>{createdAtText}</span> : null}
                    </div>
                    <div className="vibe-card-body">
                      <div className="chat-turn-content">
                        <MarkdownEditor
                          value={bodyText}
                          editable={false}
                          toolbarMode="hidden"
                          enableMermaid
                          mermaidLib={mermaid}
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="vibe-card">
                <div className="vibe-card-body">
                  <span className="vibe-muted-text">保存されたノート無し</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function formatOptionalTimestamp(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function resolveMemoSessionId(value: string | null, sessions: SessionSummary[]): string | null {
  if (!value) return null;
  if (sessions.some((session) => session.id === value)) return value;
  const rawSessionId = rawSessionIdFromSessionId(value);
  return sessions.some((session) => session.id === rawSessionId) ? rawSessionId : null;
}

function buildSessionSummaryForMemoSession(params: {
  item: SessionMemoSessionListItem;
  memorySummary?: SessionSummary;
}): SessionSummary {
  const memoUpdatedAt = new Date(params.item.lastUpdatedAt);
  const safeMemoUpdatedAt = Number.isNaN(memoUpdatedAt.getTime()) ? new Date(0) : memoUpdatedAt;

  if (!params.memorySummary) {
    return {
      id: params.item.sessionId,
      title: params.item.sessionId,
      firstMessage: undefined,
      sourceLabel: "session-memo",
      count: params.item.memoCount,
      projectName: "Unknown Project",
      startedAt: safeMemoUpdatedAt.toISOString(),
      lastCreatedAt: safeMemoUpdatedAt,
    };
  }

  return {
    ...params.memorySummary,
    id: params.item.sessionId,
    count: params.item.memoCount,
    lastCreatedAt: new Date(
      Math.max(params.memorySummary.lastCreatedAt.getTime(), safeMemoUpdatedAt.getTime()),
    ),
  };
}

function buildSessionSummary(id: string, items: VibeMemory[]): SessionSummary {
  const sortedItems = [...items].sort(
    (a, b) => resolveMemoryEventTime(a).getTime() - resolveMemoryEventTime(b).getTime(),
  );
  const lastCreatedAt =
    latestMetadataTime(items, "timestamp") ??
    new Date(Math.max(...items.map((item) => resolveMemoryEventTime(item).getTime())));
  const firstCreatedAt = new Date(
    Math.min(...items.map((item) => resolveMemoryEventTime(item).getTime())),
  );
  const projectName = firstMetadataString(items, "projectName") ?? "Unknown Project";
  const sourceLabel = firstMetadataString(items, "source") ?? "Agent";
  const startedAt = earliestMetadataTime(items, "sessionStartedAt") ?? firstCreatedAt.toISOString();

  let firstMessage: string | undefined;
  for (const item of sortedItems) {
    const turns = parseVibeMemoryTurns(item.content);
    const userTurn = turns.find((turn) => turn.role === "user" && !turn.isMetadata);
    if (userTurn?.content.trim()) {
      firstMessage = userTurn.content.trim().slice(0, 100);
      break;
    }
  }

  return {
    id,
    title: [projectName, formatSessionTime(startedAt), sourceLabel].join(" / "),
    firstMessage,
    sourceLabel,
    count: items.length,
    projectName,
    startedAt,
    lastCreatedAt,
  };
}

function rawSessionIdFromMemoryGroup(id: string, items: VibeMemory[]): string {
  for (const item of items) {
    const metadataSessionId = item.metadata?.sessionId;
    if (typeof metadataSessionId === "string" && metadataSessionId.trim().length > 0) {
      return metadataSessionId.trim();
    }
  }
  return rawSessionIdFromSessionId(id);
}

function rawSessionIdFromSessionId(value: string): string {
  return value.split(":").filter(Boolean).at(-1) ?? value;
}

function firstMetadataString(items: VibeMemory[], key: string): string | undefined {
  for (const item of items) {
    const value = item.metadata?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
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

function formatSessionTimeCompact(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function resolveMemoryEventTime(memory: {
  createdAt: string;
  metadata?: Record<string, unknown>;
}): Date {
  const timestamp = readString(memory.metadata?.timestamp);
  if (timestamp) {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const startedAt = readString(memory.metadata?.sessionStartedAt);
  if (startedAt) {
    const parsed = new Date(startedAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const createdAt = new Date(memory.createdAt);
  return Number.isNaN(createdAt.getTime()) ? new Date(0) : createdAt;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
