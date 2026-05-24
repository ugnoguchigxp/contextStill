import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type {
  LandscapeTrajectoryCandidate,
  LandscapeTrajectoryResult,
} from "../repositories/admin.repository";

export type TrajectoryStageFilter =
  | "all"
  | "text"
  | "vector"
  | "merged"
  | "final"
  | "selected"
  | "suppressed";

type TrajectoryPanelProps = {
  runId: string | null;
  trajectory: LandscapeTrajectoryResult | null | undefined;
  isLoading: boolean;
  stage: TrajectoryStageFilter;
  onStageChange: (next: TrajectoryStageFilter) => void;
  onClose: () => void;
};

function rankLabel(value: number | null): string {
  return value === null ? "-" : String(value);
}

function scoreLabel(value: number | null): string {
  return value === null ? "-" : value.toFixed(3);
}

function stageLabel(stage: TrajectoryStageFilter): string {
  switch (stage) {
    case "text":
      return "text";
    case "vector":
      return "vector";
    case "merged":
      return "merged";
    case "final":
      return "final";
    case "selected":
      return "selected";
    case "suppressed":
      return "suppressed";
    default:
      return "all";
  }
}

function matchesStage(
  candidate: LandscapeTrajectoryCandidate,
  stage: TrajectoryStageFilter,
): boolean {
  switch (stage) {
    case "text":
      return candidate.textRank !== null;
    case "vector":
      return candidate.vectorRank !== null;
    case "merged":
      return candidate.mergedRank !== null;
    case "final":
      return candidate.finalRank !== null;
    case "selected":
      return candidate.selected;
    case "suppressed":
      return candidate.suppressed;
    default:
      return true;
  }
}

function candidateEvidenceLabel(candidate: LandscapeTrajectoryCandidate): string {
  const evidence = candidate.evidence.candidateEvidence;
  if (!evidence) return "-";
  return [
    `text=${String(evidence.textMatched)}`,
    `vector=${String(evidence.vectorMatched)}`,
    `score=${evidence.vectorScore ?? "-"}`,
    `facet=${String(evidence.facetMatched)}`,
  ].join(" ");
}

function whySelectedLabel(candidate: LandscapeTrajectoryCandidate): string {
  if (!candidate.selected) return "-";
  return candidate.rankingReason ?? "selected";
}

function whySuppressedLabel(candidate: LandscapeTrajectoryCandidate): string {
  if (!candidate.suppressed) return "-";
  return candidate.suppressionReason ?? "suppressed";
}

export function TrajectoryPanel(props: TrajectoryPanelProps) {
  if (!props.runId) return null;

  const filteredCandidates = (props.trajectory?.candidates ?? []).filter((candidate) =>
    matchesStage(candidate, props.stage),
  );

  return (
    <div className="graph-trajectory-panel">
      <div className="graph-review-section-header">
        <span>Trajectory</span>
        <div className="graph-review-actions">
          <Badge variant="outline" className="h-5 border-sky-300 text-[11px] text-sky-100">
            run {props.runId}
          </Badge>
          <Select
            aria-label="trajectory-stage-filter"
            value={props.stage}
            className="h-7 text-[11px]"
            onChange={(event) => props.onStageChange(event.target.value as TrajectoryStageFilter)}
          >
            <option value="all">all stages</option>
            <option value="text">text</option>
            <option value="vector">vector</option>
            <option value="merged">merged</option>
            <option value="final">final</option>
            <option value="selected">selected</option>
            <option value="suppressed">suppressed</option>
          </Select>
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
                {props.trajectory.stageCounts.merged}/ final{" "}
                {props.trajectory.stageCounts.finalRanked}
              </p>
            </div>
            <div className="graph-community-summary-item">
              <span>Filter</span>
              <p>
                {stageLabel(props.stage)} ({filteredCandidates.length})
              </p>
            </div>
          </div>

          {props.trajectory.taskTrace ? (
            <div className="graph-review-status-note">
              task facets: retrieval={props.trajectory.taskTrace.retrievalMode} repo=
              {props.trajectory.taskTrace.repoKey ?? props.trajectory.taskTrace.repoPath ?? "-"} /
              tech={props.trajectory.taskTrace.technologies.join(",") || "-"} / change=
              {props.trajectory.taskTrace.changeTypes.join(",") || "-"} / domain=
              {props.trajectory.taskTrace.domains.join(",") || "-"} / embedding=
              {props.trajectory.taskTrace.embeddingStatus}
            </div>
          ) : null}

          {props.trajectory.taskSimilarity.length > 0 ? (
            <div className="graph-review-status-note">
              task similarity:{" "}
              {props.trajectory.taskSimilarity
                .slice(0, 3)
                .map((item) => `${item.runId}:${item.mode}:${item.similarity.toFixed(2)}`)
                .join(" / ")}
            </div>
          ) : props.trajectory.taskTrace ? (
            <div className="graph-review-status-note">task similarity: no comparable runs yet</div>
          ) : null}

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

          {filteredCandidates.length > 0 ? (
            <div className="graph-trajectory-table-wrap">
              <table className="graph-trajectory-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Text</th>
                    <th>Vector</th>
                    <th>Merged</th>
                    <th>Final</th>
                    <th>Why selected</th>
                    <th>Why suppressed</th>
                    <th>Agentic</th>
                    <th>Evidence</th>
                    <th>Community</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCandidates.map((candidate) => (
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
                      <td>{whySelectedLabel(candidate)}</td>
                      <td>{whySuppressedLabel(candidate)}</td>
                      <td>{candidate.agenticDecision}</td>
                      <td>{candidateEvidenceLabel(candidate)}</td>
                      <td>{candidate.communityKey ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="graph-detail-empty">
              No candidate rows for stage: {stageLabel(props.stage)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
