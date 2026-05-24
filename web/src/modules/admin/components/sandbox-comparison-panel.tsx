import { Badge } from "@/components/ui/badge";
import type { LandscapeReplayComparisonRun } from "../repositories/admin.repository";

type SandboxComparisonPanelProps = {
  run: LandscapeReplayComparisonRun | null;
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

function computeSandboxSets(run: LandscapeReplayComparisonRun) {
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

export function sandboxChangedKnowledgeIds(run: LandscapeReplayComparisonRun | null): string[] {
  if (!run) return [];
  const sets = computeSandboxSets(run);
  return unique([...sets.added, ...sets.removed]);
}

export function SandboxComparisonPanel(props: SandboxComparisonPanelProps) {
  if (!props.run) {
    return (
      <div className="graph-detail-empty">Select a run to compare baseline/current/sandbox.</div>
    );
  }

  const sets = computeSandboxSets(props.run);

  return (
    <div className="graph-landscape-card">
      <div className="graph-landscape-card-header">
        <span className="graph-detail-kicker">Sandbox Comparison</span>
        <Badge variant="outline" className="h-5 border-sky-300 text-[11px] text-sky-100">
          {props.run.runId}
        </Badge>
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
          <p>{Math.round(props.run.overlapRate * 100)}%</p>
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
    </div>
  );
}
