import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { formatDate as tzFormatDate, useTimezone } from "@/lib/timezone";
import { Plus, RefreshCw } from "lucide-react";
import type { CompileRunSource, CompileRunSummary } from "../repositories/context-compiler.repository";

type StatusFilter = "all" | CompileRunSummary["status"];
type SourceFilter = "all" | CompileRunSource;

const statusVariant = {
  ok: "success",
  degraded: "warning",
  failed: "destructive",
} as const;

const sourceLabels: Record<CompileRunSource, string> = {
  ui: "UI",
  mcp: "MCP",
  cli: "CLI",
  unknown: "Unknown",
};

export function formatLatency(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

export function StatusBadge({ status }: { status: CompileRunSummary["status"] }) {
  return <Badge variant={statusVariant[status]}>{status}</Badge>;
}

export function SourceBadge({ source }: { source: CompileRunSource }) {
  return <Badge variant="secondary">{sourceLabels[source]}</Badge>;
}

function RunListItem({
  run,
  active,
  onSelect,
}: {
  run: CompileRunSummary;
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
        <span className="compile-run-title" title={run.goal}>
          {run.goal}
        </span>
      </div>
      <div className="compile-run-meta">
        <StatusBadge status={run.status} />
        <SourceBadge source={run.source} />
        <span>{run.retrievalMode}</span>
        <span>{formatLatency(run.durationMs)}</span>
      </div>
      <time>{tzFormatDate(run.createdAt, tz)}</time>
    </button>
  );
}

export function RunSidebar({
  runs,
  activeRunId,
  sourceFilter,
  statusFilter,
  isLoading,
  error,
  onNew,
  onRefresh,
  onSelect,
  onSourceFilterChange,
  onStatusFilterChange,
}: {
  runs: CompileRunSummary[];
  activeRunId: string | null;
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  isLoading: boolean;
  error: unknown;
  onNew: () => void;
  onRefresh: () => void;
  onSelect: (runId: string) => void;
  onSourceFilterChange: (value: SourceFilter) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
}) {
  return (
    <aside className="compile-sidebar">
      <div className="compile-sidebar-header">
        <div>
          <h2>Recent Runs</h2>
          <p>{runs.length} visible</p>
        </div>
        <div className="compile-sidebar-actions">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh runs"
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
          aria-label="Source filter"
          value={sourceFilter}
          onChange={(event) => onSourceFilterChange(event.currentTarget.value as SourceFilter)}
        >
          <option value="all">All sources</option>
          <option value="ui">UI</option>
          <option value="mcp">MCP</option>
          <option value="cli">CLI</option>
          <option value="unknown">Unknown</option>
        </Select>
        <Select
          aria-label="Status filter"
          value={statusFilter}
          onChange={(event) => onStatusFilterChange(event.currentTarget.value as StatusFilter)}
        >
          <option value="all">All status</option>
          <option value="ok">ok</option>
          <option value="degraded">degraded</option>
          <option value="failed">failed</option>
        </Select>
      </div>

      {isLoading ? <p className="compile-state-text">Loading...</p> : null}
      {error ? <p className="compile-state-text destructive">{String(error)}</p> : null}

      <div className="compile-run-list">
        {runs.map((run) => (
          <RunListItem
            key={run.id}
            run={run}
            active={activeRunId === run.id}
            onSelect={() => onSelect(run.id)}
          />
        ))}
        {!isLoading && runs.length === 0 ? (
          <div className="compile-empty-state">No compile runs match the filters.</div>
        ) : null}
      </div>
    </aside>
  );
}
