import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { fetchAgentDiffEntries, fetchVibeMemories } from "../repositories/admin.repository";

export function AgentDiffsPage() {
  const search = useSearch({ from: "/agent-diffs" }) as { id?: string };
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(search.id ?? null);

  const diffEntries = useQuery({
    queryKey: ["agent-diffs", 200],
    queryFn: () => fetchAgentDiffEntries(200),
  });

  const memories = useQuery({
    queryKey: ["vibe-memories"],
    queryFn: () => fetchVibeMemories(),
  });

  const activeEntry =
    diffEntries.data?.find((entry) => entry.id === selectedEntryId) ?? diffEntries.data?.[0];
  const relatedVibe = memories.data?.find((m) => m.id === activeEntry?.vibeMemoryId);
  const lineRange =
    activeEntry?.startLine != null && activeEntry?.endLine != null
      ? `L${activeEntry.startLine}-L${activeEntry.endLine}`
      : activeEntry?.startLine != null
        ? `L${activeEntry.startLine}`
        : null;

  return (
    <div className="vibe-layout">
      {/* Sidebar: Symbol List */}
      <aside className="vibe-sidebar">
        <div className="sidebar-header">
          <h2>Agent Diffs</h2>
        </div>
        <div className="session-list">
          {diffEntries.data?.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={`session-item ${activeEntry?.id === entry.id ? "active" : ""}`}
              onClick={() => setSelectedEntryId(entry.id)}
            >
              <div className="session-info">
                <span className="session-id-label">
                  {entry.symbolName ?? entry.filePath.split("/").pop()}
                </span>
                <span className="session-meta">
                  {entry.symbolKind ?? entry.changeType ?? "diff"} · {entry.filePath}
                </span>
              </div>
            </button>
          ))}
          {!diffEntries.isLoading && (diffEntries.data?.length ?? 0) === 0 && (
            <div className="empty-state">No agent diffs found</div>
          )}
        </div>
      </aside>

      {/* Main Content: Symbol Detail & Source */}
      <main className="vibe-main">
        {activeEntry ? (
          <>
            <header className="vibe-content-header">
              <div className="header-title">
                <h1>{activeEntry.symbolName ?? activeEntry.filePath.split("/").pop()}</h1>
                <Badge variant="outline">
                  {activeEntry.symbolKind ?? activeEntry.changeType ?? "diff"}
                </Badge>
              </div>
              <div className="header-meta">
                <span>File: {activeEntry.filePath}</span>
                {lineRange ? <span>Range: {lineRange}</span> : null}
                {relatedVibe && (
                  <div className="relation-link">
                    <Badge variant="secondary">From Vibe Memory</Badge>
                    <span className="vibe-ref">Session: {relatedVibe.sessionId}</span>
                  </div>
                )}
              </div>
            </header>
            <div className="vibe-history">
              <Card className="code-display-card">
                <div className="code-header">
                  <span className="file-path">{activeEntry.filePath}</span>
                </div>
                <pre className="code-block">
                  <code>{activeEntry.diffHunk}</code>
                </pre>
              </Card>

              {relatedVibe && (
                <div className="vibe-context-section">
                  <h3>Originating Context</h3>
                  <div className="vibe-card vibe-type-chat">
                    <div className="vibe-card-body">{relatedVibe.content}</div>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="vibe-empty-view">
            <p>diffを選択してください</p>
          </div>
        )}
      </main>
    </div>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`diff-card ${className}`}>{children}</div>;
}
