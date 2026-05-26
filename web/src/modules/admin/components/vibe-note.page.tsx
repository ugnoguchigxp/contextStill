import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  type VibeMemory,
  deleteSessionMemo,
  fetchSessionMemos,
  fetchVibeMemories,
  upsertSessionMemo,
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

export function VibeNotePage() {
  const queryClient = useQueryClient();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const sessionIdFromQuery = useMemo(
    () => new URLSearchParams(search).get("sessionId") ?? "",
    [search],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    sessionIdFromQuery || null,
  );
  const [slot, setSlot] = useState("");
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");

  const memories = useQuery({
    queryKey: ["vibe-memories", 200],
    queryFn: () => fetchVibeMemories(200),
  });
  const sessions = useMemo(() => {
    const map = new Map<string, VibeMemory[]>();
    for (const memory of memories.data ?? []) {
      if (map.has(memory.sessionId)) {
        const entry = map.get(memory.sessionId);
        if (!entry) continue;
        entry.push(memory);
        continue;
      }
      map.set(memory.sessionId, [memory]);
    }
    return Array.from(map.entries())
      .map(([id, items]) => buildSessionSummary(id, items))
      .sort((a, b) => b.lastCreatedAt.getTime() - a.lastCreatedAt.getTime());
  }, [memories.data]);

  const activeSessionId = selectedSessionId ?? sessions[0]?.id ?? "";

  const notes = useQuery({
    queryKey: ["session-memos", activeSessionId],
    queryFn: () => fetchSessionMemos(activeSessionId),
    enabled: activeSessionId.length > 0,
  });

  const save = useMutation({
    mutationFn: upsertSessionMemo,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["session-memos", activeSessionId] }),
  });
  const remove = useMutation({
    mutationFn: deleteSessionMemo,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["session-memos", activeSessionId] }),
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
                  <span>{session.count} vibes</span>
                </div>
              </div>
            </button>
          ))}
          {sessions.length === 0 && !memories.isLoading ? (
            <div className="empty-state">No sessions found</div>
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
        <div className="vibe-card">
          <div className="vibe-card-body" style={{ display: "grid", gap: 8 }}>
            <Input
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
              placeholder="slot (optional)"
            />
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional)"
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="memo body"
            />
            <Button
              onClick={() =>
                save.mutate({
                  sessionId: activeSessionId,
                  slot: slot.trim() ? Number(slot) : undefined,
                  label: label.trim() || undefined,
                  body,
                })
              }
              disabled={!body.trim() || !activeSessionId}
            >
              Save
            </Button>
          </div>
        </div>
        <div className="vibe-history">
          {notes.data?.items?.length ? (
            notes.data.items.map((item) => {
              const slotNum = Number(item.slot);
              const kind = typeof item.kind === "string" ? item.kind : "scratch";
              const title =
                typeof item.metadata?.title === "string" ? item.metadata.title : undefined;
              const score =
                typeof item.metadata?.score === "number" ? item.metadata.score : undefined;
              return (
                <div key={slotNum} className="vibe-card">
                  <div className="vibe-card-header">
                    <Badge variant="secondary">slot {slotNum}</Badge>
                    <Badge variant="outline">{kind}</Badge>
                    {item.label ? <span>{String(item.label)}</span> : null}
                    {title ? <span>{title}</span> : null}
                    {score !== undefined ? <span>score: {score}</span> : null}
                  </div>
                  <div className="vibe-card-body">
                    <pre>{String(item.preview ?? "")}</pre>
                  </div>
                  <div className="vibe-card-footer">
                    <button
                      type="button"
                      className="vibe-delete-link"
                      onClick={() => remove.mutate({ sessionId: activeSessionId, slot: slotNum })}
                    >
                      Delete
                    </button>
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
        {notes.data?.events?.length ? (
          <div className="vibe-card">
            <div className="vibe-card-header">
              <Badge variant="secondary">Events</Badge>
            </div>
            <div className="vibe-card-body">
              {notes.data.events.slice(0, 20).map((event) => (
                <div key={event.id} className="vibe-muted-text">
                  {event.action} / slot {event.slot ?? "-"} /{" "}
                  {new Date(event.createdAt).toLocaleString()}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
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
      firstMessage = stripRolePrefix(userTurn.content).slice(0, 100);
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

function stripRolePrefix(value: string): string {
  return value.replace(/^\s*(USER|ASSISTANT|SYSTEM)\s*:\s*/i, "").trim();
}

function resolveMemoryEventTime(memory: {
  createdAt: string;
  metadata?: Record<string, unknown>;
}): Date {
  const timestamp = memory.metadata?.timestamp;
  if (typeof timestamp === "string" && timestamp.trim()) {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const created = new Date(memory.createdAt);
  if (!Number.isNaN(created.getTime())) return created;
  return new Date(0);
}
