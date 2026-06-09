import { useEffect, useMemo, useState } from "react";
import {
  useContextDecisionDetail,
  useContextDecisionFeedbackMutation,
  useContextDecisionRuns,
} from "../hooks/context-decision.hooks";
import { ContextDecisionRunSidebar } from "./context-decision.run-sidebar";

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="admin-code-block">{JSON.stringify(value, null, 2)}</pre>;
}

function groupByRole<T extends { role: string }>(items: T[]): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((groups, item) => {
    groups[item.role] = [...(groups[item.role] ?? []), item];
    return groups;
  }, {});
}

export function ContextDecisionPage() {
  const runsQuery = useContextDecisionRuns();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runs = runsQuery.data ?? [];

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);

  const detailQuery = useContextDecisionDetail(selectedRunId);
  const feedbackMutation = useContextDecisionFeedbackMutation();
  const detail = detailQuery.data;
  const evidenceByRole = useMemo(() => groupByRole(detail?.evidence ?? []), [detail?.evidence]);

  return (
    <section className="context-compiler-page">
      <ContextDecisionRunSidebar
        runs={runs}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
      />
      <div className="compile-main-panel">
        <header className="admin-page-header">
          <div>
            <h1>Decision</h1>
            <p>Autonomous context decisions, Knowledge evidence, coverage, and feedback effects.</p>
          </div>
        </header>

        {runsQuery.isLoading ? <p>Loading decisions...</p> : null}
        {!runsQuery.isLoading && runs.length === 0 ? (
          <div className="empty-state">No context decisions recorded yet.</div>
        ) : null}

        {detail ? (
          <div className="compile-result-grid">
            <section className="compile-card">
              <div className="section-heading-row">
                <h2>{detail.run.decisionPoint}</h2>
                <span className="status-pill">{detail.run.status}</span>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Decision</dt>
                  <dd>{detail.run.decision}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{detail.run.confidence}%</dd>
                </div>
                <div>
                  <dt>Feedback</dt>
                  <dd>{detail.run.humanFeedback ?? "none"}</dd>
                </div>
                <div>
                  <dt>Selected</dt>
                  <dd>{detail.run.selectedAction ?? "none"}</dd>
                </div>
              </dl>
              <p>{detail.run.agentMessage}</p>
              <p>{detail.run.mandate}</p>
              <div className="button-row">
                <button
                  type="button"
                  className="button"
                  disabled={feedbackMutation.isPending}
                  onClick={() =>
                    feedbackMutation.mutate({ decisionId: detail.run.id, value: "good" })
                  }
                >
                  Good
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={feedbackMutation.isPending}
                  onClick={() =>
                    feedbackMutation.mutate({ decisionId: detail.run.id, value: "bad" })
                  }
                >
                  Bad
                </button>
              </div>
            </section>

            <section className="compile-card">
              <h2>Confidence trace</h2>
              <JsonBlock value={detail.run.confidenceTrace} />
            </section>

            <section className="compile-card">
              <h2>Evidence</h2>
              {Object.entries(evidenceByRole).map(([role, items]) => (
                <div key={role} className="evidence-group">
                  <h3>{role}</h3>
                  {items.map((item) => (
                    <article key={item.id} className="evidence-item">
                      <strong>{item.weightAtDecision}%</strong>
                      <p>{item.summary}</p>
                      {item.sourceRefs.length > 0 ? (
                        <ul>
                          {item.sourceRefs.map((ref) => (
                            <li key={ref}>{ref}</li>
                          ))}
                        </ul>
                      ) : null}
                    </article>
                  ))}
                </div>
              ))}
            </section>

            <section className="compile-card">
              <h2>Coverage</h2>
              {detail.coverage.map((trace) => (
                <article key={trace.id} className="evidence-item">
                  <strong>
                    {trace.queryRole} · {trace.hitCount} hits
                  </strong>
                  <p>{trace.query}</p>
                  <p>{trace.reason}</p>
                </article>
              ))}
            </section>

            <section className="compile-card">
              <h2>Guardrails</h2>
              <JsonBlock value={detail.run.guardrails} />
            </section>

            <section className="compile-card">
              <h2>Feedback effects</h2>
              {detail.effects.length === 0 ? <p>No effects recorded.</p> : null}
              {detail.effects.map((effect) => (
                <article key={effect.id} className="evidence-item">
                  <strong>
                    {effect.effect} {effect.amount} · {effect.status}
                  </strong>
                  <p>{effect.reason}</p>
                </article>
              ))}
            </section>
          </div>
        ) : null}
      </div>
    </section>
  );
}
