import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LandscapeTrajectoryResult } from "../repositories/admin.repository";

type TrajectoryPanelProps = {
  runId: string | null;
  trajectory: LandscapeTrajectoryResult | null | undefined;
  isLoading: boolean;
  onClose: () => void;
};

function rankLabel(value: number | null): string {
  return value === null ? "-" : String(value);
}

function scoreLabel(value: number | null): string {
  return value === null ? "-" : value.toFixed(3);
}

export function TrajectoryPanel(props: TrajectoryPanelProps) {
  if (!props.runId) return null;

  return (
    <div className="graph-trajectory-panel">
      <div className="graph-review-section-header">
        <span>Trajectory</span>
        <div className="graph-review-actions">
          <Badge variant="outline" className="h-5 border-sky-300 text-[11px] text-sky-100">
            run {props.runId}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={props.onClose}
          >
            Close
          </Button>
        </div>
      </div>

      {props.isLoading ? (
        <div className="graph-detail-empty">Loading trajectory...</div>
      ) : !props.trajectory ? (
        <div className="graph-detail-empty">Trajectory not found.</div>
      ) : (
        <>
          <div className="graph-community-summary-grid">
            <div className="graph-community-summary-item">
              <span>Goal</span>
              <p>{props.trajectory.run.goal}</p>
            </div>
            <div className="graph-community-summary-item">
              <span>Status</span>
              <p>
                {props.trajectory.run.status} / {props.trajectory.run.retrievalMode}
              </p>
            </div>
            <div className="graph-community-summary-item">
              <span>Stages</span>
              <p>
                text {props.trajectory.stageCounts.textHit} / vector{" "}
                {props.trajectory.stageCounts.vectorHit} / merged{" "}
                {props.trajectory.stageCounts.merged} / final{" "}
                {props.trajectory.stageCounts.finalRanked}
              </p>
            </div>
            <div className="graph-community-summary-item">
              <span>Selected</span>
              <p>
                {props.trajectory.stageCounts.selected} / suppressed{" "}
                {props.trajectory.stageCounts.suppressed}
              </p>
            </div>
          </div>

          {props.trajectory.warnings.length > 0 ? (
            <div className="graph-trajectory-warning-box">
              {props.trajectory.warnings.join(" / ")}
            </div>
          ) : null}

          <div className="graph-review-status-note">
            traceSaved={props.trajectory.diagnostics.candidateTraceSavedCount ?? "-"} limit=
            {props.trajectory.diagnostics.candidateTraceLimit ?? "-"} truncated=
            {String(props.trajectory.diagnostics.candidateTraceTruncated ?? false)}
          </div>

          {props.trajectory.candidates.length > 0 ? (
            <div className="graph-trajectory-table-wrap">
              <table className="graph-trajectory-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Text</th>
                    <th>Vector</th>
                    <th>Merged</th>
                    <th>Final</th>
                    <th>Selected</th>
                    <th>Suppressed</th>
                    <th>Community</th>
                  </tr>
                </thead>
                <tbody>
                  {props.trajectory.candidates.map((candidate) => (
                    <tr key={`${candidate.itemKind}:${candidate.itemId}`}>
                      <td>
                        <span className="graph-trajectory-item">{candidate.itemId}</span>
                      </td>
                      <td>
                        {rankLabel(candidate.textRank)} / {scoreLabel(candidate.textScore)}
                      </td>
                      <td>
                        {rankLabel(candidate.vectorRank)} / {scoreLabel(candidate.vectorScore)}
                      </td>
                      <td>
                        {rankLabel(candidate.mergedRank)} / {scoreLabel(candidate.mergedScore)}
                      </td>
                      <td>
                        {rankLabel(candidate.finalRank)} / {scoreLabel(candidate.finalScore)}
                      </td>
                      <td>{candidate.selected ? "yes" : "no"}</td>
                      <td>{candidate.suppressed ? (candidate.suppressionReason ?? "yes") : "-"}</td>
                      <td>{candidate.communityKey ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="graph-detail-empty">No candidate trace rows.</div>
          )}
        </>
      )}
    </div>
  );
}
