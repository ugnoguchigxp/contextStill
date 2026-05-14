import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { deleteVibeMemory, fetchVibeMemories, fetchAiArtifacts } from "../repositories/admin.repository";
import { Link } from "@tanstack/react-router";

export function ActivityPage() {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const memories = useQuery({
    queryKey: ["vibe-memories", 200],
    queryFn: () => fetchVibeMemories(200),
  });

  const artifacts = useQuery({
    queryKey: ["ai-artifacts"],
    queryFn: () => fetchAiArtifacts(),
  });

  const remove = useMutation({
    mutationFn: deleteVibeMemory,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vibe-memories"] });
    },
  });

  // Group by session and sort by latest activity
  const sessionMap = memories.data?.reduce((acc, m) => {
    if (!acc[m.sessionId]) acc[m.sessionId] = [];
    acc[m.sessionId].push(m);
    return acc;
  }, {} as Record<string, typeof memories.data>) ?? {};

  const sessions = Object.entries(sessionMap)
    .map(([id, items]) => ({
      id,
      lastCreatedAt: new Date(Math.max(...items.map(i => new Date(i.createdAt).getTime()))),
      count: items.length
    }))
    .sort((a, b) => b.lastCreatedAt.getTime() - a.lastCreatedAt.getTime());

  // Default to the latest session
  const activeSessionId = selectedSessionId ?? sessions[0]?.id;
  const activeMemories = activeSessionId ? (sessionMap[activeSessionId] || []).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) : [];

  return (
    <div className="activity-layout">
      {/* Sidebar: Session List */}
      <aside className="activity-sidebar">
        <div className="sidebar-header">
          <h2>Sessions</h2>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <button
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
      <main className="activity-main">
        {activeSessionId ? (
          <>
            <header className="activity-content-header">
              <div className="header-title">
                <h1>Session: {activeSessionId}</h1>
                <Badge variant="outline">{activeMemories.length} records</Badge>
              </div>
            </header>
            <div className="vibe-history">
              {activeMemories.map((m) => (
                <div key={m.id} className={`vibe-card vibe-type-${m.memoryType}`}>
                  <div className="vibe-card-header">
                    <Badge variant="secondary" className="type-badge">{m.memoryType}</Badge>
                    <span className="vibe-timestamp">
                      {new Date(m.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="vibe-card-body">
                    {m.content}
                  </div>
                  {artifacts.data?.filter(a => a.vibeMemoryId === m.id).map(a => (
                    <div key={a.id} className="vibe-artifact-link">
                      <Link to="/artifacts" search={{ id: a.id }}>
                        <Badge variant="outline" className="cursor-pointer hover:bg-accent">
                          📦 Artifact: {a.filePath || a.artifactType}
                        </Badge>
                      </Link>
                    </div>
                  ))}
                  <div className="vibe-card-footer">
                    <button
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
          <div className="activity-empty-view">
            <p>セッションを選択してください</p>
          </div>
        )}
      </main>
    </div>
  );
}
