import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import {
  deleteVibeMemory,
  fetchAgentDiffEntries,
  fetchVibeMemories,
} from "../repositories/admin.repository";
import { Link } from "@tanstack/react-router";

export function VibeMemoryPage() {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const memories = useQuery({
    queryKey: ["vibe-memories", 200],
    queryFn: () => fetchVibeMemories(200),
  });

  const diffEntries = useQuery({
    queryKey: ["agent-diffs"],
    queryFn: () => fetchAgentDiffEntries(),
  });

  const remove = useMutation({
    mutationFn: deleteVibeMemory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vibe-memories"] });
    },
  });

  // Group by session and sort by latest vibe memory.
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
    .map(([id, items]) => ({
      id,
      lastCreatedAt: new Date(Math.max(...items.map((i) => new Date(i.createdAt).getTime()))),
      count: items.length,
    }))
    .sort((a, b) => b.lastCreatedAt.getTime() - a.lastCreatedAt.getTime());

  // Default to the latest session
  const activeSessionId = selectedSessionId ?? sessions[0]?.id;
  const activeMemories = activeSessionId
    ? (sessionMap[activeSessionId] || []).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
    : [];

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
            >
              <div className="session-info">
                <span className="session-id-label">{s.id}</span>
                <span className="session-meta">
                  {s.lastCreatedAt.toLocaleDateString()} · {s.count} vibes
                </span>
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
                <h1>Vibe Session: {activeSessionId}</h1>
                <Badge variant="outline">{activeMemories.length} records</Badge>
              </div>
            </header>
            <div className="vibe-history">
              {activeMemories.map((m) => (
                <div key={m.id} className={`vibe-card vibe-type-${m.memoryType}`}>
                  <div className="vibe-card-header">
                    <Badge variant="secondary" className="type-badge">
                      {m.memoryType}
                    </Badge>
                    <span className="vibe-timestamp">{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <div className="vibe-card-body">{m.content}</div>
                  {diffEntries.data
                    ?.filter((entry) => entry.vibeMemoryId === m.id)
                    .map((entry) => (
                      <div key={entry.id} className="vibe-diff-link">
                        <Link to="/agent-diffs" search={{ id: entry.id }}>
                          <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                            Agent Diff: {entry.symbolName ?? entry.filePath}
                          </Badge>
                        </Link>
                      </div>
                    ))}
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
              ))}
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
