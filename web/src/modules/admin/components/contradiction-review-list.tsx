import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { LandscapeReviewItem } from "../repositories/admin.repository";

type ContradictionReviewListProps = {
  items: LandscapeReviewItem[];
  isUpdating: boolean;
  onResolve: (id: string) => void;
  onDismiss: (id: string) => void;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ContradictionReviewList(props: ContradictionReviewListProps) {
  if (props.items.length === 0) {
    return <div className="graph-detail-empty">No contradiction review items</div>;
  }

  return (
    <div className="graph-review-list">
      {props.items.map((item) => {
        const payload = asRecord(item.payload);
        const breakdown = asRecord(payload.confidenceBreakdown);
        const leftKnowledgeId = asString(payload.leftKnowledgeId) || item.knowledgeId || "-";
        const rightKnowledgeId = asString(payload.rightKnowledgeId) || "-";
        const leftSnippet = asString(asRecord(payload.snippets).left);
        const rightSnippet = asString(asRecord(payload.snippets).right);
        const scope = asRecord(payload.overlap);

        return (
          <div className="graph-review-row" key={item.id}>
            <div className="graph-review-row-head">
              <Badge variant="outline" className="h-5 border-rose-300 text-[11px] text-rose-100">
                contradiction
              </Badge>
              <span>
                p{item.priority} / {item.confidence}
              </span>
            </div>
            <p>
              {leftKnowledgeId} vs {rightKnowledgeId}
            </p>
            <small>
              scope repoPath={String(Boolean(scope.repoPath))} repoKey=
              {String(Boolean(scope.repoKey))}
            </small>
            <small>
              confidence scope={asNumber(breakdown.scopeOverlap)?.toFixed(2) ?? "-"} neighbor=
              {asNumber(breakdown.semanticOrRelationNeighbor)?.toFixed(2) ?? "-"} polarity=
              {asNumber(breakdown.polarityConflict)?.toFixed(2) ?? "-"}
            </small>
            {leftSnippet ? <small>left: {leftSnippet}</small> : null}
            {rightSnippet ? <small>right: {rightSnippet}</small> : null}
            {item.evidence.length > 0 ? (
              <small>evidence: {item.evidence.slice(0, 2).join(" / ")}</small>
            ) : null}
            <div className="graph-review-row-actions">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={props.isUpdating}
                onClick={() => props.onResolve(item.id)}
              >
                Resolve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                disabled={props.isUpdating}
                onClick={() => props.onDismiss(item.id)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
