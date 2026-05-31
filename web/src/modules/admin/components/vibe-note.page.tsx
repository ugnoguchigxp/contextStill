import { Badge } from "@/components/ui/badge";
import {
  formatDateTime,
  formatDateTimeCompact,
  formatDateTimeShort,
  useTimezone,
} from "@/lib/timezone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import {
  AlertTriangle,
  Check,
  CheckCircle,
  Clock,
  FileText,
  HelpCircle,
  Info,
  MapPin,
  MessageSquare,
  Shield,
  Tag,
  Zap,
} from "lucide-react";
import { MarkdownEditor } from "markdown-wysiwyg-editor";
import mermaid from "mermaid";
import { useEffect, useMemo, useState } from "react";
import {
  type VibeGoal,
  type VibeMemoryCapsule,
  fetchVibeGoals,
  fetchVibeMemoryContext,
  postMarkVibeMemory,
} from "../repositories/admin.repository";

mermaid.initialize({ startOnLoad: false });

export function VibeNotePage() {
  const tz = useTimezone();
  const queryClient = useQueryClient();
  const search = useRouterState({ select: (state) => state.location.searchStr });

  // Resolve goalId from query string if present
  const goalIdFromQuery = useMemo(() => new URLSearchParams(search).get("goalId") ?? "", [search]);

  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(goalIdFromQuery || null);

  // Agent profiles check-state for wants filtering
  const [selectedProfiles, setSelectedProfiles] = useState<string[]>([
    "code-review",
    "implementation",
    "testing",
  ]);

  // Tab state: "brief" | "checkpoints" | "timeline"
  const [activeTab, setActiveTab] = useState<"brief" | "checkpoints" | "timeline">("brief");
  const [isBriefExpanded, setIsBriefExpanded] = useState(true);

  // Load Goal list
  const goalsQuery = useQuery({
    queryKey: ["vibe-goals"],
    queryFn: fetchVibeGoals,
  });

  const activeGoalId = selectedGoalId ?? goalsQuery.data?.[0]?.id ?? "";

  // Load Goal Room context
  const contextQuery = useQuery({
    queryKey: ["vibe-memory-context", activeGoalId, selectedProfiles],
    queryFn: () => fetchVibeMemoryContext(activeGoalId, selectedProfiles),
    enabled: activeGoalId.length > 0,
  });

  // Safe mutations to add marks
  const addMarkMutation = useMutation({
    mutationFn: postMarkVibeMemory,
    onSuccess: () => {
      // Invalidate query to live refresh the UI
      queryClient.invalidateQueries({ queryKey: ["vibe-memory-context", activeGoalId] });
    },
  });

  useEffect(() => {
    if (goalsQuery.data && goalsQuery.data.length > 0 && !selectedGoalId) {
      setSelectedGoalId(goalsQuery.data[0].id);
    }
  }, [goalsQuery.data, selectedGoalId]);

  const activeGoal = useMemo(() => {
    return goalsQuery.data?.find((g) => g.id === activeGoalId);
  }, [goalsQuery.data, activeGoalId]);

  const toggleProfile = (prof: string) => {
    setSelectedProfiles((prev) =>
      prev.includes(prof) ? prev.filter((p) => p !== prof) : [...prev, prof],
    );
  };

  const handleMarkAction = (targetMemoryId: string, mark: string) => {
    if (!activeGoalId) return;
    const note = prompt(`Enter optional note for mark "${mark}":`);
    if (note === null) return; // cancelled

    addMarkMutation.mutate({
      goalId: activeGoalId,
      targetMemoryId,
      mark,
      note: note.trim() || undefined,
      actorId: "human-ui",
    });
  };

  const parseFileName = (uri: string) => {
    try {
      const parts = uri.split("/");
      return parts.filter(Boolean).pop() ?? uri;
    } catch {
      return uri;
    }
  };

  // Helper to render proper icon per intent
  const getIntentIcon = (intent: string) => {
    switch (intent) {
      case "ask":
        return <Zap className="vibe-icon text-amber-500" />;
      case "question":
        return <HelpCircle className="vibe-icon text-blue-500" />;
      case "review":
        return <Shield className="vibe-icon text-red-500" />;
      case "patch":
        return <FileText className="vibe-icon text-green-500" />;
      case "verify":
        return <CheckCircle className="vibe-icon text-emerald-500" />;
      case "risk":
        return <AlertTriangle className="vibe-icon text-rose-500" />;
      case "warning":
        return <AlertTriangle className="vibe-icon text-amber-500" />;
      case "decision":
        return <Check className="vibe-icon text-indigo-500" />;
      default:
        return <Info className="vibe-icon text-slate-500" />;
    }
  };

  return (
    <div className="vibe-layout">
      {/* Sidebar: Goal Rooms */}
      <aside className="vibe-sidebar">
        <div className="sidebar-header">
          <h2>Goal Rooms</h2>
        </div>
        <div className="session-list">
          {goalsQuery.data?.map((g) => {
            const fileName = parseFileName(g.goalAnchorRef);
            return (
              <button
                type="button"
                key={g.id}
                className={`session-item ${activeGoalId === g.id ? "active" : ""}`}
                onClick={() => setSelectedGoalId(g.id)}
                title={g.goalUri}
              >
                <div className="session-info">
                  <div className="session-project-line">
                    <span className="session-project-name">
                      {g.title || fileName || "Goal Room"}
                    </span>
                    <span className="session-time-label">
                      {formatDateTimeCompact(new Date(g.createdAt), tz)}
                    </span>
                  </div>
                  <div className="session-meta-line">
                    <span className="session-meta-project" style={{ wordBreak: "break-all" }}>
                      {fileName}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
          {goalsQuery.data?.length === 0 && !goalsQuery.isLoading ? (
            <div className="empty-state">No Goal Rooms found</div>
          ) : null}
        </div>
      </aside>

      {/* Main Panel */}
      <main className="vibe-main">
        {activeGoalId ? (
          <>
            <header
              className="vibe-content-header"
              style={{ flexDirection: "column", alignItems: "flex-start", gap: "10px" }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                  alignItems: "center",
                }}
              >
                <div className="header-title">
                  <h1>{activeGoal?.title ?? "Goal Room Dashboard"}</h1>
                  <Badge variant="outline" className="vibe-hash-badge">
                    goal: {activeGoalId.slice(0, 10)}...
                  </Badge>
                </div>
                <div className="header-meta">
                  <a
                    href={`/vibe-memory?goalId=${encodeURIComponent(activeGoalId)}`}
                    className="vibe-link-btn"
                  >
                    Vibe Memoryへ
                  </a>
                </div>
              </div>

              {/* Profile Capability Filter Selecors */}
              <div className="vibe-profile-selectors">
                <span className="vibe-profile-label">Capabilities Profile:</span>
                {["code-review", "implementation", "testing", "documentation", "architect"].map(
                  (prof) => (
                    <button
                      key={prof}
                      type="button"
                      className={`vibe-profile-btn ${selectedProfiles.includes(prof) ? "selected" : ""}`}
                      onClick={() => toggleProfile(prof)}
                    >
                      {prof}
                    </button>
                  ),
                )}
              </div>

              {/* Tabs Selector */}
              <div className="vibe-tabs-selector">
                <button
                  type="button"
                  className={`vibe-tab-btn ${activeTab === "brief" ? "active" : ""}`}
                  onClick={() => setActiveTab("brief")}
                >
                  Brief & Open Loops
                </button>
                <button
                  type="button"
                  className={`vibe-tab-btn ${activeTab === "checkpoints" ? "active" : ""}`}
                  onClick={() => setActiveTab("checkpoints")}
                >
                  Checkpoints & Decisions (
                  {(contextQuery.data?.pinned?.length ?? 0) +
                    (contextQuery.data?.decisions?.length ?? 0)}
                  )
                </button>
                <button
                  type="button"
                  className={`vibe-tab-btn ${activeTab === "timeline" ? "active" : ""}`}
                  onClick={() => setActiveTab("timeline")}
                >
                  Raw Timeline ({contextQuery.data?.openLoops?.length ?? 0} unresolved)
                </button>
              </div>
            </header>

            {/* Tab 1: Brief & Open Loops */}
            {activeTab === "brief" && (
              <div
                className={`vibe-tab-content vertical-brief-kanban ${isBriefExpanded ? "brief-open" : "brief-closed"}`}
              >
                {/* Top: Dynamic Brief text inside Accordion */}
                <div
                  className="vibe-brief-accordion-container"
                  style={{ width: "100%", marginBottom: "0.5rem" }}
                >
                  <button
                    type="button"
                    className="vibe-brief-accordion-header"
                    onClick={() => setIsBriefExpanded(!isBriefExpanded)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      width: "100%",
                      padding: "0.85rem 1.25rem",
                      background: "rgba(15, 23, 42, 0.03)",
                      border: "1px solid var(--border)",
                      borderRadius: isBriefExpanded ? "0.75rem 0.75rem 0 0" : "0.75rem",
                      cursor: "pointer",
                      transition: "all 0.2s ease",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        fontWeight: "600",
                        fontSize: "0.9rem",
                        color: "var(--foreground)",
                      }}
                    >
                      📄 Room Brief & Goal Room Information
                    </span>
                    <span
                      style={{
                        transform: isBriefExpanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 0.2s ease",
                        color: "var(--muted-foreground)",
                        fontWeight: "bold",
                        fontSize: "1.1rem",
                        lineHeight: "1",
                      }}
                    >
                      ›
                    </span>
                  </button>

                  {isBriefExpanded && (
                    <div
                      className="vibe-brief-accordion-content"
                      style={{
                        border: "1px solid var(--border)",
                        borderTop: "none",
                        borderRadius: "0 0 0.75rem 0.75rem",
                        padding: "1.25rem",
                        background: "var(--card)",
                        boxShadow: "0 4px 15px -3px rgba(0,0,0,0.05)",
                      }}
                    >
                      {/* Goal Metadata Sub-line inside Accordion */}
                      <div
                        className="vibe-goal-subline"
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "15px",
                          marginBottom: "12px",
                          paddingBottom: "10px",
                          borderBottom: "1px solid rgba(15, 23, 42, 0.08)",
                        }}
                      >
                        <div
                          className="vibe-goal-meta-item"
                          style={{ fontSize: "0.8rem", color: "var(--muted-foreground)" }}
                        >
                          <strong>URI:</strong>{" "}
                          <code
                            className="vibe-code"
                            style={{
                              background: "rgba(15, 23, 42, 0.04)",
                              padding: "2px 6px",
                              borderRadius: "4px",
                            }}
                          >
                            {activeGoal?.goalUri}
                          </code>
                        </div>
                        <div
                          className="vibe-goal-meta-item"
                          style={{ fontSize: "0.8rem", color: "var(--muted-foreground)" }}
                        >
                          <strong>Anchor Path:</strong>{" "}
                          <code
                            className="vibe-code"
                            style={{
                              background: "rgba(15, 23, 42, 0.04)",
                              padding: "2px 6px",
                              borderRadius: "4px",
                            }}
                          >
                            {activeGoal?.goalAnchorRef}
                          </code>
                        </div>
                      </div>

                      {/* Brief text editor */}
                      <div className="vibe-pane-body brief-editor-pane">
                        <MarkdownEditor
                          value={contextQuery.data?.brief ?? "Brief compiling..."}
                          editable={false}
                          toolbarMode="hidden"
                          enableMermaid
                          mermaidLib={mermaid}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Middle: Non-loop agent memos */}
                <div className="vibe-kanban-section">
                  <div className="vibe-pane-header" style={{ marginBottom: "5px" }}>
                    <h3>Agent Memos ({contextQuery.data?.agentMemos?.length ?? 0})</h3>
                  </div>
                  <div className="vibe-pane-body timeline-stream">
                    {contextQuery.data?.agentMemos?.map((memo) => (
                      <div key={memo.id} className="timeline-card">
                        <div className="card-header">
                          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            {getIntentIcon(memo.intent)}
                            <strong>{memo.actorId}</strong>
                            <Badge variant="outline">{memo.intent}</Badge>
                          </div>
                          <span className="time">
                            {formatDateTimeCompact(new Date(memo.createdAt), tz)}
                          </span>
                        </div>
                        <p className="text">{memo.text}</p>
                        {memo.subject ? (
                          <div className="loop-meta-item">
                            <span className="meta-lbl">Subject:</span> <span>{memo.subject}</span>
                          </div>
                        ) : null}
                        {memo.refs?.length > 0 ? (
                          <div className="refs-bar">
                            <span>Refs:</span>
                            {memo.refs.map((r) => (
                              <code key={r} className="ref-node" title={r}>
                                {parseFileName(r)}
                              </code>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {(contextQuery.data?.agentMemos?.length ?? 0) === 0 ? (
                      <span className="vibe-muted-text">No agent memos yet.</span>
                    ) : null}
                  </div>
                </div>

                {/* Bottom: Kanban Board for Open Loops & Capsules */}
                <div className="vibe-kanban-section">
                  <div className="vibe-pane-header" style={{ marginBottom: "5px" }}>
                    <h3>📋 Goal Room Kanban Board</h3>
                  </div>

                  {/* Dynamic Kanban classification */}
                  {(() => {
                    const openLoops = contextQuery.data?.openLoops ?? [];
                    const issues = openLoops.filter((l: any) =>
                      ["ask", "question", "risk", "warning"].includes(l.intent),
                    );
                    const patches = openLoops.filter((l: any) =>
                      ["review", "patch"].includes(l.intent),
                    );
                    const decisions = openLoops.filter((l: any) =>
                      ["decision", "verify", "checkpoint", "result"].includes(l.intent),
                    );

                    const renderKanbanCard = (loop: any) => {
                      const isUnverified = loop.evidenceStatus === "ungrounded";
                      return (
                        <div
                          key={loop.id}
                          className={`vibe-loop-card ${loop.score >= 100 ? "highlight-match" : ""}`}
                        >
                          {/* Card Header */}
                          <div className="loop-card-header">
                            <div className="intent-line">
                              {getIntentIcon(loop.intent)}
                              <Badge variant="secondary">{loop.intent.toUpperCase()}</Badge>
                              {loop.score >= 100 ? (
                                <Badge className="badge-match-glow">🔥 MATCH</Badge>
                              ) : null}
                            </div>

                            {/* Interactive Mark dropdown buttons */}
                            <div className="mark-actions">
                              <button
                                type="button"
                                className="action-mark-btn"
                                onClick={() => handleMarkAction(loop.id, "resolved")}
                                title="Resolve this loop"
                              >
                                Resolve
                              </button>
                              <button
                                type="button"
                                className="action-mark-btn mark-stale-btn"
                                onClick={() => handleMarkAction(loop.id, "stale")}
                                title="Mark as obsolete/stale"
                              >
                                Stale
                              </button>
                            </div>
                          </div>

                          {/* Card Body */}
                          <div className="loop-card-body">
                            <p className="loop-text">{loop.text}</p>
                            {loop.subject ? (
                              <div className="loop-meta-item">
                                <span className="meta-lbl">Subject:</span>{" "}
                                <span>{loop.subject}</span>
                              </div>
                            ) : null}

                            {loop.wants?.length > 0 ? (
                              <div className="loop-meta-item">
                                <span className="meta-lbl">Wants:</span>
                                <div className="labels-row">
                                  {loop.wants.map((w: string) => (
                                    <span key={w} className="meta-badge-wants">
                                      {w}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ) : null}

                            {loop.refs?.length > 0 ? (
                              <div className="loop-meta-item">
                                <span className="meta-lbl">Refs:</span>
                                <div className="labels-row-refs">
                                  {loop.refs.map((r: string) => (
                                    <code key={r} className="meta-ref-code" title={r}>
                                      {parseFileName(r)}
                                    </code>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>

                          {/* Card Footer */}
                          <div className="loop-card-footer">
                            <div className="actor-time">
                              <span className="author">by {loop.actorId}</span>
                              <span className="bullet">·</span>
                              <span className="time">
                                {formatDateTimeCompact(new Date(loop.createdAt), tz)}
                              </span>
                            </div>

                            {/* Evidence Status Label */}
                            <Badge
                              variant={isUnverified ? "destructive" : "default"}
                              className="evidence-badge-lbl"
                            >
                              {isUnverified ? "未検証" : `Evidence: ${loop.evidenceStatus}`}
                            </Badge>
                          </div>

                          {/* Marks sub-row */}
                          {loop.marks && loop.marks.length > 0 ? (
                            <div className="loop-card-marks-subrow">
                              {loop.marks.map((m: any) => (
                                <span key={m.id} className="badge-sub-mark" title={m.note}>
                                  [{m.mark}] {m.actorId}: {m.note ?? ""}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    };

                    return (
                      <div className="vibe-kanban-board">
                        {/* Column 1: Issues & Risks */}
                        <div className="vibe-kanban-column">
                          <div className="column-header header-issues">
                            <h4>🚨 Issues & Risks ({issues.length})</h4>
                          </div>
                          <div className="column-cards-container">
                            {issues.map(renderKanbanCard)}
                            {issues.length === 0 && (
                              <div className="empty-column-msg">No active issues</div>
                            )}
                          </div>
                        </div>

                        {/* Column 2: Reviews & Patches */}
                        <div className="vibe-kanban-column">
                          <div className="column-header header-patches">
                            <h4>🔧 Reviews & Patches ({patches.length})</h4>
                          </div>
                          <div className="column-cards-container">
                            {patches.map(renderKanbanCard)}
                            {patches.length === 0 && (
                              <div className="empty-column-msg">No active patches</div>
                            )}
                          </div>
                        </div>

                        {/* Column 3: Decisions & Verifications */}
                        <div className="vibe-kanban-column">
                          <div className="column-header header-decisions">
                            <h4>🎯 Decisions ({decisions.length})</h4>
                          </div>
                          <div className="column-cards-container">
                            {decisions.map(renderKanbanCard)}
                            {decisions.length === 0 && (
                              <div className="empty-column-msg">No active decisions</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Tab 2: Checkpoints & Decisions */}
            {activeTab === "checkpoints" && (
              <div className="vibe-tab-content grid-checkpoints">
                {/* Checkpoints */}
                <div className="vibe-pane-left">
                  <div className="vibe-pane-header">
                    <h3>📌 Pinned Checkpoints</h3>
                  </div>
                  <div className="vibe-pane-body checkpoints-list">
                    {contextQuery.data?.pinned?.map((pin: any) => (
                      <div key={pin.id} className="checkpoint-card">
                        <div className="card-lbl">
                          <MapPin className="pin-symbol" />
                          <span className="author">{pin.actorId} pinned checkpoint</span>
                          <span className="time">
                            {formatDateTimeShort(new Date(pin.createdAt), tz)}
                          </span>
                        </div>
                        <p className="body-text">{pin.text}</p>
                        {pin.refs?.length > 0 ? (
                          <div className="refs-row">
                            {pin.refs.map((r: string) => (
                              <code key={r} className="meta-ref-code">
                                {parseFileName(r)}
                              </code>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {contextQuery.data?.pinned?.length === 0 ? (
                      <span className="vibe-muted-text">No checkpoints pinned yet.</span>
                    ) : null}
                  </div>
                </div>

                {/* Decisions */}
                <div className="vibe-pane-right">
                  <div className="vibe-pane-header">
                    <h3>✓ Verified Decisions</h3>
                  </div>
                  <div className="vibe-pane-body decisions-list">
                    {contextQuery.data?.decisions?.map((dec: any) => (
                      <div key={dec.id} className="decision-card">
                        <div className="card-lbl">
                          <CheckCircle className="check-symbol" />
                          <span className="author">Verified Decision by {dec.actorId}</span>
                          <span className="time">
                            {formatDateTimeShort(new Date(dec.createdAt), tz)}
                          </span>
                        </div>
                        <p className="body-text">{dec.text}</p>
                        {dec.refs?.length > 0 ? (
                          <div className="refs-row">
                            {dec.refs.map((r: string) => (
                              <code key={r} className="meta-ref-code">
                                {parseFileName(r)}
                              </code>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                    {contextQuery.data?.decisions?.length === 0 ? (
                      <span className="vibe-muted-text">No verified decisions recorded yet.</span>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {/* Tab 3: Capsule Timeline */}
            {activeTab === "timeline" && (
              <div className="vibe-tab-content timeline-vertical-pane">
                <div className="vibe-pane-header">
                  <h3>🕒 Capsule History Stream</h3>
                </div>
                <div className="vibe-pane-body timeline-stream">
                  {(contextQuery.data?.recentTimeline ?? contextQuery.data?.openLoops ?? []).map(
                    (cap) => (
                      <div key={cap.id} className="timeline-item-row">
                        <div className="timeline-dot-connector">
                          <div className="dot" />
                          <div className="connector" />
                        </div>
                        <div className="timeline-card">
                          <div className="card-header">
                            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                              {getIntentIcon(cap.intent)}
                              <strong>{cap.actorId}</strong>
                              <Badge variant="outline">{cap.intent}</Badge>
                            </div>
                            <span className="time">
                              {formatDateTime(new Date(cap.createdAt), tz)}
                            </span>
                          </div>
                          <p className="text">{cap.text}</p>
                          {cap.refs?.length > 0 ? (
                            <div className="refs-bar">
                              <span>Refs:</span>
                              {cap.refs.map((r) => (
                                <code key={r} className="ref-node" title={r}>
                                  {parseFileName(r)}
                                </code>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ),
                  )}
                  {(contextQuery.data?.recentTimeline ?? contextQuery.data?.openLoops ?? [])
                    .length === 0 ? (
                    <span className="vibe-muted-text">No Capsule logs yet.</span>
                  ) : null}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="vibe-empty-view">
            <p>Goal Room を選択してください</p>
          </div>
        )}
      </main>
    </div>
  );
}
