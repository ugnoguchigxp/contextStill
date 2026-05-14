import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { fetchArtifactSymbols, fetchAiArtifacts, fetchVibeMemories } from "../repositories/admin.repository";

export function ArtifactsPage() {
  const search = useSearch({ from: "/artifacts" }) as { id?: string };
  const [selectedSymbolId, setSelectedSymbolId] = useState<string | null>(search.id ?? null);

  const symbols = useQuery({
    queryKey: ["artifact-symbols", 200],
    queryFn: () => fetchArtifactSymbols(200),
  });

  const artifacts = useQuery({
    queryKey: ["ai-artifacts"],
    queryFn: () => fetchAiArtifacts(),
  });

  const memories = useQuery({
    queryKey: ["vibe-memories"],
    queryFn: () => fetchVibeMemories(),
  });

  const activeSymbol = symbols.data?.find(s => s.id === selectedSymbolId) ?? symbols.data?.[0];
  const activeArtifact = artifacts.data?.find(a => a.id === activeSymbol?.artifactId);
  const relatedVibe = memories.data?.find(m => m.id === activeArtifact?.vibeMemoryId);

  return (
    <div className="activity-layout">
      {/* Sidebar: Symbol List */}
      <aside className="activity-sidebar">
        <div className="sidebar-header">
          <h2>Code Symbols</h2>
        </div>
        <div className="session-list">
          {symbols.data?.map((s) => (
            <button
              key={s.id}
              className={`session-item ${activeSymbol?.id === s.id ? "active" : ""}`}
              onClick={() => setSelectedSymbolId(s.id)}
            >
              <div className="session-info">
                <span className="session-id-label">{s.symbolName}</span>
                <span className="session-meta">
                  {s.symbolKind} · {activeArtifact?.filePath?.split('/').pop() ?? 'Snippet'}
                </span>
              </div>
            </button>
          ))}
          {!symbols.isLoading && (symbols.data?.length ?? 0) === 0 && (
            <div className="empty-state">No symbols found</div>
          )}
        </div>
      </aside>

      {/* Main Content: Symbol Detail & Source */}
      <main className="activity-main">
        {activeSymbol ? (
          <>
            <header className="activity-content-header">
              <div className="header-title">
                <h1>{activeSymbol.symbolName}</h1>
                <Badge variant="outline">{activeSymbol.symbolKind}</Badge>
              </div>
              <div className="header-meta">
                <span>File: {activeArtifact?.filePath ?? "Internal Snippet"}</span>
                {relatedVibe && (
                  <div className="relation-link">
                    <Badge variant="secondary">Generated from Vibe</Badge>
                    <span className="vibe-ref">Session: {relatedVibe.sessionId}</span>
                  </div>
                )}
              </div>
            </header>
            <div className="vibe-history">
              <Card className="code-display-card">
                <div className="code-header">
                  <span className="file-path">{activeArtifact?.filePath}</span>
                </div>
                <pre className="code-block">
                  <code>{activeSymbol.content || activeArtifact?.content}</code>
                </pre>
              </Card>

              {relatedVibe && (
                <div className="vibe-context-section">
                  <h3>Originating Context</h3>
                  <div className="vibe-card vibe-type-chat">
                    <div className="vibe-card-body">
                      {relatedVibe.content}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="activity-empty-view">
            <p>シンボルを選択してください</p>
          </div>
        )}
      </main>
    </div>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`artifact-card ${className}`}>{children}</div>;
}
