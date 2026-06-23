import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatDate as tzFormatDate, useTimezone } from "@/lib/timezone";
import { Plus, RefreshCw } from "lucide-react";
import type { ContextDecisionRunSummary } from "../repositories/context-decision.repository";

export type DecisionStatusFilter = "all" | ContextDecisionRunSummary["status"];
export type DecisionFeedbackFilter = "all" | "good" | "bad" | "none";

type Props = {
  runs: ContextDecisionRunSummary[];
  selectedRunId: string | null;
  statusFilter: DecisionStatusFilter;
  feedbackFilter: DecisionFeedbackFilter;
  isLoading: boolean;
  error: unknown;
  onNew: () => void;
  onRefresh: () => void;
  onSelectRun: (runId: string) => void;
  onStatusFilterChange: (value: DecisionStatusFilter) => void;
  onFeedbackFilterChange: (value: DecisionFeedbackFilter) => void;
};

const statusVariant = {
  completed: "success",
  degraded: "warning",
  failed: "destructive",
} as const;

const decisionVariant = {
  execute: "success",
  reject: "destructive",
  revise_and_execute: "warning",
  rollback: "warning",
  discard: "destructive",
  escalate: "secondary",
} as const;

export function DecisionStatusBadge({ status }: { status: ContextDecisionRunSummary["status"] }) {
  return <Badge variant={statusVariant[status]}>{status}</Badge>;
}

export function DecisionBadge({ decision }: { decision: ContextDecisionRunSummary["decision"] }) {
  return <Badge variant={decisionVariant[decision]}>{decision}</Badge>;
}

function formatDecisionRunDate(value: string, tz: string): string {
  if (value === new Date(0).toISOString()) return "-";
  return tzFormatDate(value, tz);
}

function DecisionRunListItem({
  run,
  active,
  onSelect,
}: {
  run: ContextDecisionRunSummary;
  active: boolean;
  onSelect: () => void;
}) {
  const tz = useTimezone();
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`compile-run-item${active ? " active" : ""}`}
      onClick={onSelect}
    >
      <div className="compile-run-item-top">
        <span className="compile-run-title" title={run.decisionPoint}>
          {run.decisionPoint}
        </span>
      </div>
      <div className="compile-run-meta">
        <DecisionStatusBadge status={run.status} />
        <DecisionBadge decision={run.decision} />
        <span>{run.humanFeedback ?? "no feedback"}</span>
        <time>{formatDecisionRunDate(run.createdAt, tz)}</time>
      </div>
    </button>
  );
}

export function ContextDecisionRunSidebar({
  runs,
  selectedRunId,
  statusFilter,
  feedbackFilter,
  isLoading,
  error,
  onNew,
  onRefresh,
  onSelectRun,
  onStatusFilterChange,
  onFeedbackFilterChange,
}: Props) {
  return (
    <aside className="compile-sidebar">
      <div className="compile-sidebar-header">
        <div>
          <h2>Recent Decisions</h2>
          <p>{runs.length} visible</p>
        </div>
        <div className="compile-sidebar-actions">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh decisions"
          >
            <RefreshCw size={16} />
          </Button>
          <Button type="button" size="sm" onClick={onNew}>
            <Plus size={16} />
            New
          </Button>
        </div>
      </div>

      <div className="compile-filter-row">
        <Select
          aria-label="Status filter"
          value={statusFilter}
          onChange={(event) =>
            onStatusFilterChange(event.currentTarget.value as DecisionStatusFilter)
          }
        >
          <option value="all">All status</option>
          <option value="completed">completed</option>
          <option value="degraded">degraded</option>
          <option value="failed">failed</option>
        </Select>
        <Select
          aria-label="Feedback filter"
          value={feedbackFilter}
          onChange={(event) =>
            onFeedbackFilterChange(event.currentTarget.value as DecisionFeedbackFilter)
          }
        >
          <option value="all">All feedback</option>
          <option value="good">good</option>
          <option value="bad">bad</option>
          <option value="none">none</option>
        </Select>
      </div>

      {isLoading ? <p className="compile-state-text">Loading...</p> : null}
      {error ? <p className="compile-state-text destructive">{String(error)}</p> : null}

      <div className="compile-run-list">
        {runs.map((run) => (
          <DecisionRunListItem
            key={run.id}
            run={run}
            active={run.id === selectedRunId}
            onSelect={() => onSelectRun(run.id)}
          />
        ))}
        {!isLoading && runs.length === 0 ? (
          <div className="compile-empty-state">No context decision runs match the filters.</div>
        ) : null}
      </div>
    </aside>
  );
}
