import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useMemo, useState } from "react";
import type { LandscapeReplayComparisonRun } from "../repositories/admin.repository";

export type SandboxDiffFilter = "all" | "added" | "removed" | "retained";

type SandboxComparisonPanelProps = {
  runs: LandscapeReplayComparisonRun[];
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  diffFilter: SandboxDiffFilter;
  onDiffFilterChange: (next: SandboxDiffFilter) => void;
  onSelectKnowledgeId?: (knowledgeId: string) => void;
};

type SandboxSets = {
  baseline: string[];
  current: string[];
  sandbox: string[];
  retained: string[];
  added: string[];
  removed: string[];
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function diff(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function computeSandboxSets(run: LandscapeReplayComparisonRun): SandboxSets {
  const baseline = unique(run.baselineSelectedKnowledgeIds);
  const current = unique(run.currentRetrievedKnowledgeIds);
  const sandbox = unique([...current, ...run.usedBaselineLostKnowledgeIds]);
  return {
    baseline,
    current,
    sandbox,
    retained: intersect(baseline, sandbox),
    added: diff(sandbox, baseline),
    removed: diff(baseline, sandbox),
  };
}

export function sandboxChangedKnowledgeIds(
  run: LandscapeReplayComparisonRun | null,
  filter: SandboxDiffFilter = "all",
): string[] {
  if (!run) return [];
  const sets = computeSandboxSets(run);
  if (filter === "added") return sets.added;
  if (filter === "removed") return sets.removed;
  if (filter === "retained") return sets.retained;
  return unique([...sets.added, ...sets.removed]);
}

function replayComparisonLabel(value: LandscapeReplayComparisonRun["comparison"]): string {
  if (value === "stable") return "stable";
  if (value === "drifted") return "drifted";
  if (value === "lost_baseline") return "lost baseline";
  if (value === "new_only") return "new only";
  return "no current match";
}

function idsForFilter(sets: SandboxSets, filter: SandboxDiffFilter): string[] {
  if (filter === "added") return sets.added;
  if (filter === "removed") return sets.removed;
  if (filter === "retained") return sets.retained;
  return unique([...sets.added, ...sets.removed]);
}

function runLabel(run: LandscapeReplayComparisonRun): string {
  return `${run.runId} (${replayComparisonLabel(run.comparison)}, ${Math.round(run.overlapRate * 100)}%)`;
}

export function SandboxComparisonPanel(props: SandboxComparisonPanelProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const selectedRun = props.selectedRunId
    ? (props.runs.find((run) => run.runId === props.selectedRunId) ?? null)
    : null;

  const sets = useMemo(() => (selectedRun ? computeSandboxSets(selectedRun) : null), [selectedRun]);
  const filteredIds = useMemo(
    () => (sets ? idsForFilter(sets, props.diffFilter) : []),
    [props.diffFilter, sets],
  );

  if (props.runs.length === 0) {
    return <div className="graph-detail-empty">No risky run available for sandbox comparison.</div>;
  }

  if (!selectedRun || !sets) {
    return (
      <div className="graph-landscape-card">
        <div className="graph-landscape-card-header">
          <span className="graph-detail-kicker">Sandbox Comparison</span>
          <Badge variant="outline" className="h-5 border-slate-300 text-[11px] text-slate-100">
            not selected
          </Badge>
        </div>
        <div className="graph-review-actions">
          <Select
            aria-label="sandbox-run-selector"
            value=""
            className="h-7 text-[11px]"
            onChange={(event) => props.onSelectRun(event.target.value || null)}
          >
            <option value="">select run</option>
            {props.runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {runLabel(run)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="sandbox-diff-filter"
            value={props.diffFilter}
            className="h-7 text-[11px]"
            onChange={(event) => props.onDiffFilterChange(event.target.value as SandboxDiffFilter)}
            disabled
          >
            <option value="all">all changed</option>
            <option value="added">added only</option>
            <option value="removed">removed only</option>
            <option value="retained">retained only</option>
          </Select>
          <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled>
            Copy JSON
          </Button>
        </div>
        <div className="graph-detail-empty">Select a run to compare baseline/current/sandbox.</div>
      </div>
    );
  }

  const copySummary = async () => {
    const payload = {
      runId: selectedRun.runId,
      comparison: selectedRun.comparison,
      overlapRate: selectedRun.overlapRate,
      replacementRate: selectedRun.replacementRate,
      filter: props.diffFilter,
      counts: {
        baseline: sets.baseline.length,
        current: sets.current.length,
        sandbox: sets.sandbox.length,
        retained: sets.retained.length,
        added: sets.added.length,
        removed: sets.removed.length,
        filtered: filteredIds.length,
      },
      filteredKnowledgeIds: filteredIds,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1500);
    }
  };

  return (
    <div className="graph-landscape-card">
      <div className="graph-landscape-card-header">
        <span className="graph-detail-kicker">Sandbox Comparison</span>
        <Badge variant="outline" className="h-5 border-sky-300 text-[11px] text-sky-100">
          {selectedRun.runId}
        </Badge>
      </div>

      <div className="graph-review-actions">
        <Select
          aria-label="sandbox-run-selector"
          value={selectedRun.runId}
          className="h-7 text-[11px]"
          onChange={(event) => props.onSelectRun(event.target.value || null)}
        >
          <option value="">select run</option>
          {props.runs.map((run) => (
            <option key={run.runId} value={run.runId}>
              {runLabel(run)}
            </option>
          ))}
        </Select>
        <Select
          aria-label="sandbox-diff-filter"
          value={props.diffFilter}
          className="h-7 text-[11px]"
          onChange={(event) => props.onDiffFilterChange(event.target.value as SandboxDiffFilter)}
        >
          <option value="all">all changed</option>
          <option value="added">added only</option>
          <option value="removed">removed only</option>
          <option value="retained">retained only</option>
        </Select>
        <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={copySummary}>
          {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy JSON"}
        </Button>
      </div>

      <div className="graph-community-summary-grid">
        <div className="graph-community-summary-item">
          <span>Baseline</span>
          <p>{sets.baseline.length}</p>
        </div>
        <div className="graph-community-summary-item">
          <span>Current</span>
          <p>{sets.current.length}</p>
        </div>
        <div className="graph-community-summary-item">
          <span>Sandbox</span>
          <p>{sets.sandbox.length}</p>
        </div>
        <div className="graph-community-summary-item">
          <span>Overlap</span>
          <p>{Math.round(selectedRun.overlapRate * 100)}%</p>
        </div>
      </div>

      <div className="graph-sandbox-diff-grid">
        <div className="graph-sandbox-diff-col removed">
          <strong>Removed ({sets.removed.length})</strong>
          <div className="graph-sandbox-id-list">
            {sets.removed.slice(0, 8).map((knowledgeId) => (
              <span key={`removed-${knowledgeId}`}>{knowledgeId}</span>
            ))}
            {sets.removed.length === 0 ? <span>-</span> : null}
          </div>
        </div>
        <div className="graph-sandbox-diff-col retained">
          <strong>Retained ({sets.retained.length})</strong>
          <div className="graph-sandbox-id-list">
            {sets.retained.slice(0, 8).map((knowledgeId) => (
              <span key={`retained-${knowledgeId}`}>{knowledgeId}</span>
            ))}
            {sets.retained.length === 0 ? <span>-</span> : null}
          </div>
        </div>
        <div className="graph-sandbox-diff-col added">
          <strong>Added ({sets.added.length})</strong>
          <div className="graph-sandbox-id-list">
            {sets.added.slice(0, 8).map((knowledgeId) => (
              <span key={`added-${knowledgeId}`}>{knowledgeId}</span>
            ))}
            {sets.added.length === 0 ? <span>-</span> : null}
          </div>
        </div>
      </div>

      <div className="graph-review-section">
        <div className="graph-review-section-header">
          <span>Filtered IDs</span>
          <strong>{filteredIds.length}</strong>
        </div>
        {filteredIds.length > 0 ? (
          <div className="graph-review-list">
            {filteredIds.slice(0, 12).map((knowledgeId) => (
              <div key={`filtered-${knowledgeId}`} className="graph-review-row">
                <p>{knowledgeId}</p>
                <div className="graph-review-row-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => props.onSelectKnowledgeId?.(knowledgeId)}
                  >
                    Focus Node
                  </Button>
                  <a
                    href={`/candidates?query=${encodeURIComponent(knowledgeId)}`}
                    className="inline-flex h-7 items-center rounded-md border border-sky-300 px-2 text-[11px] text-sky-100 hover:bg-sky-500/15"
                  >
                    Candidate Search
                  </a>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="graph-detail-empty">No IDs for current filter.</div>
        )}
      </div>
    </div>
  );
}
