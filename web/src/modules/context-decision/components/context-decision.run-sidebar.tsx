import type { ContextDecisionRunSummary } from "../repositories/context-decision.repository";

type Props = {
  runs: ContextDecisionRunSummary[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ContextDecisionRunSidebar({ runs, selectedRunId, onSelectRun }: Props) {
  return (
    <aside className="run-sidebar">
      <div className="run-sidebar-header">
        <h2>Decision runs</h2>
        <span>{runs.length}</span>
      </div>
      <div className="run-list">
        {runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={`run-list-item ${run.id === selectedRunId ? "active" : ""}`}
            onClick={() => onSelectRun(run.id)}
          >
            <span className="run-list-title">{run.decisionPoint}</span>
            <span className="run-list-meta">
              {run.decision} · {run.confidence}% · {run.status}
            </span>
            <span className="run-list-meta">
              {run.humanFeedback ?? "no feedback"} · {formatDate(run.createdAt)}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
