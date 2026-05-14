import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import {
  fetchArtifactSymbols,
  fetchAiArtifacts,
  fetchVibeMemories,
} from "../repositories/admin.repository";

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

  const symbolArtifactIds = new Set(symbols.data?.map((s) => s.artifactId) ?? []);
  const artifactOnlyItems = artifacts.data?.filter((a) => !symbolArtifactIds.has(a.id)) ?? [];
  const artifactFromSelection = artifacts.data?.find((a) => a.id === selectedSymbolId);
  const activeSymbol =
    symbols.data?.find((s) => s.id === selectedSymbolId) ??
    (artifactFromSelection
      ? symbols.data?.find((s) => s.artifactId === artifactFromSelection.id)
      : undefined) ??
    symbols.data?.[0];
  const activeArtifact =
    artifactFromSelection ??
    artifacts.data?.find((a) => a.id === activeSymbol?.artifactId) ??
    (activeSymbol ? undefined : artifacts.data?.[0]);
  const relatedVibe = memories.data?.find((m) => m.id === activeArtifact?.vibeMemoryId);
  const symbolLineRange =
    activeSymbol?.startLine != null && activeSymbol?.endLine != null
      ? `L${activeSymbol.startLine}-L${activeSymbol.endLine}`
      : activeSymbol?.startLine != null
        ? `L${activeSymbol.startLine}`
        : null;

  return (
    <div className="activity-layout">
      {/* Sidebar: Symbol List */}
      <aside className="activity-sidebar">
        <div className="sidebar-header">
          <h2>Artifact Symbols</h2>
        </div>
        <div className="session-list">
          {symbols.data?.map((s) => (
            <button
              type="button"
              key={s.id}
              className={`session-item ${activeSymbol?.id === s.id ? "active" : ""}`}
              onClick={() => setSelectedSymbolId(s.id)}
            >
              <div className="session-info">
                <span className="session-id-label">{s.symbolName}</span>
                <span className="session-meta">
                  {s.symbolKind} ·{" "}
                  {artifacts.data
                    ?.find((a) => a.id === s.artifactId)
                    ?.filePath?.split("/")
                    .pop() ?? "Snippet"}
                </span>
              </div>
            </button>
          ))}
          {artifactOnlyItems.map((artifact) => (
            <button
              type="button"
              key={artifact.id}
              className={`session-item ${activeArtifact?.id === artifact.id ? "active" : ""}`}
              onClick={() => setSelectedSymbolId(artifact.id)}
            >
              <div className="session-info">
                <span className="session-id-label">{artifact.filePath.split("/").pop()}</span>
                <span className="session-meta">{artifact.language ?? "artifact"}</span>
              </div>
            </button>
          ))}
          {!symbols.isLoading &&
            !artifacts.isLoading &&
            (symbols.data?.length ?? 0) === 0 &&
            artifactOnlyItems.length === 0 && <div className="empty-state">No artifacts found</div>}
        </div>
      </aside>

      {/* Main Content: Symbol Detail & Source */}
      <main className="activity-main">
        {activeSymbol || activeArtifact ? (
          <>
            <header className="activity-content-header">
              <div className="header-title">
                <h1>{activeSymbol?.symbolName ?? activeArtifact?.filePath.split("/").pop()}</h1>
                <Badge variant="outline">{activeSymbol?.symbolKind ?? "artifact"}</Badge>
              </div>
              <div className="header-meta">
                <span>File: {activeArtifact?.filePath ?? "Internal Snippet"}</span>
                {symbolLineRange ? <span>Range: {symbolLineRange}</span> : null}
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
                  <code>{activeSymbol?.content || activeArtifact?.content}</code>
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
