import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  deleteSessionMemo,
  fetchSessionMemos,
  fetchVibeMemories,
  upsertSessionMemo,
} from "../repositories/admin.repository";

type SessionSummary = {
  id: string;
  startedAt: string;
  count: number;
  projectName: string;
};

export function VibeNotePage() {
  const queryClient = useQueryClient();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const sessionIdFromQuery = useMemo(() => new URLSearchParams(search).get("sessionId") ?? "", [search]);
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
    const map = new Map<string, SessionSummary>();
    for (const memory of memories.data ?? []) {
      if (map.has(memory.sessionId)) {
        const entry = map.get(memory.sessionId)!;
        entry.count += 1;
        continue;
      }
      map.set(memory.sessionId, {
        id: memory.sessionId,
        startedAt: String(memory.metadata?.sessionStartedAt ?? memory.createdAt),
        count: 1,
        projectName: String(memory.metadata?.projectName ?? "Unknown Project"),
      });
    }
    return Array.from(map.values()).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }, [memories.data]);

  const activeSessionId = selectedSessionId ?? sessions[0]?.id ?? "";

  const notes = useQuery({
    queryKey: ["session-memos", activeSessionId],
    queryFn: () => fetchSessionMemos(activeSessionId, { includeEmpty: true }),
    enabled: activeSessionId.length > 0,
  });

  const save = useMutation({
    mutationFn: upsertSessionMemo,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-memos", activeSessionId] }),
  });
  const remove = useMutation({
    mutationFn: deleteSessionMemo,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-memos", activeSessionId] }),
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
                  <span className="session-project-name">{session.projectName}</span>
                  <span className="session-time-label">
                    {new Date(session.startedAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="session-meta-line">
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
              <a href={`/vibe-memory?sessionId=${encodeURIComponent(activeSessionId)}`}>Vibe Memoryへ</a>
            ) : null}
          </div>
        </header>
        {!activeSessionId ? (
          <div className="vibe-empty-view">セッションがありません。</div>
        ) : null}
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
          {(notes.data?.items ?? []).map((item) => {
            const slotNum = Number(item.slot);
            const empty = item.empty === true;
            return (
              <div key={slotNum} className="vibe-card">
                <div className="vibe-card-header">
                  <Badge variant="secondary">slot {slotNum}</Badge>
                  {item.label ? <span>{String(item.label)}</span> : null}
                </div>
                <div className="vibe-card-body">
                  {empty ? (
                    <span className="vibe-muted-text">(empty)</span>
                  ) : (
                    <pre>{String(item.preview ?? "")}</pre>
                  )}
                </div>
                {!empty ? (
                  <div className="vibe-card-footer">
                    <button
                      type="button"
                      className="vibe-delete-link"
                      onClick={() => remove.mutate({ sessionId: activeSessionId, slot: slotNum })}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {notes.data?.events?.length ? (
          <div className="vibe-card">
            <div className="vibe-card-header">
              <Badge variant="secondary">Events</Badge>
            </div>
            <div className="vibe-card-body">
              {notes.data.events.slice(0, 20).map((event) => (
                <div key={event.id} className="vibe-muted-text">
                  {event.action} / slot {event.slot ?? "-"} / {new Date(event.createdAt).toLocaleString()}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </main>
    </div>
  );
}
