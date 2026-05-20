import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { OverviewCharts } from "./overview-charts";
import { fetchDoctorReport, fetchOverviewDashboard } from "../repositories/admin.repository";

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="overview-metric-card">
      <CardContent className="metric-card overview-metric-content">
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
        {hint ? <span className="metric-hint">{hint}</span> : null}
      </CardContent>
    </Card>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCheckedAt(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function toPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0.0%";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

export function OverviewPage() {
  const overview = useQuery({
    queryKey: ["overview-dashboard"],
    queryFn: () => fetchOverviewDashboard(),
  });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });

  const dashboard = overview.data;
  const status = doctor.data?.status ?? "degraded";
  const compileRuns = dashboard?.kpis.compileRuns ?? 0;
  const compileDegradedRuns = dashboard?.kpis.compileDegradedRuns ?? 0;
  const activeKnowledge = dashboard?.kpis.activeKnowledge ?? 0;
  const zeroUseActiveKnowledge = dashboard?.kpis.zeroUseActiveKnowledge ?? 0;
  const usedActiveKnowledge = Math.max(0, activeKnowledge - zeroUseActiveKnowledge);
  const queueTotals = (dashboard?.charts.distillationQueue ?? []).reduce(
    (acc, item) => ({
      pending: acc.pending + item.pending,
      running: acc.running + item.running,
      completed: acc.completed + item.completed,
      failed: acc.failed + item.failed,
    }),
    { pending: 0, running: 0, completed: 0, failed: 0 },
  );

  return (
    <div className="page-stack overview-layout">
      <section className="page-heading">
        <div>
          <h1>Overview</h1>
          <p>DB実態のKPIとチャートを確認し、runtime healthはdoctor情報を参照します。</p>
        </div>
        <div className="overview-heading-actions">
          <span className="overview-checked-at">
            checkedAt {formatCheckedAt(dashboard?.checkedAt)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void Promise.all([overview.refetch(), doctor.refetch()]);
            }}
            disabled={overview.isFetching || doctor.isFetching}
          >
            <RefreshCcw size={14} />
            Refresh
          </Button>
          <Badge
            variant={status === "ok" ? "success" : status === "failed" ? "destructive" : "warning"}
          >
            {status}
          </Badge>
        </div>
      </section>

      {overview.isError ? (
        <Card>
          <CardContent className="metric-card">
            <span className="metric-label text-red-600">Overview API Error</span>
            <strong className="metric-value">/api/overview response could not be loaded.</strong>
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="metric-grid overview-metric-grid">
            <Metric
              label="Knowledge Items"
              value={dashboard ? formatNumber(dashboard.kpis.knowledgeTotal) : "-"}
              hint={
                dashboard
                  ? `active ${formatNumber(dashboard.kpis.activeKnowledge)} / draft ${formatNumber(dashboard.kpis.draftKnowledge)} / deprecated ${formatNumber(dashboard.kpis.deprecatedKnowledge)}`
                  : undefined
              }
            />
            <Metric
              label="Knowledge Types"
              value={dashboard ? formatNumber(dashboard.kpis.rules) : "-"}
              hint={dashboard ? `procedures ${formatNumber(dashboard.kpis.procedures)}` : undefined}
            />
            <Metric
              label="Usage Coverage"
              value={dashboard ? formatNumber(usedActiveKnowledge) : "-"}
              hint={
                dashboard
                  ? `unused active ${formatNumber(dashboard.kpis.zeroUseActiveKnowledge)}`
                  : undefined
              }
            />
            <Metric
              label="Wiki Pages"
              value={dashboard ? formatNumber(dashboard.kpis.wikiPages) : "-"}
              hint={
                dashboard
                  ? `indexed ${formatNumber(dashboard.kpis.indexedSources)} / fragments ${formatNumber(dashboard.kpis.sourceFragments)}`
                  : undefined
              }
            />
            <Metric
              label="Vibe Records"
              value={dashboard ? formatNumber(dashboard.kpis.vibeRecords) : "-"}
              hint={
                dashboard
                  ? `sessions ${formatNumber(dashboard.kpis.vibeSessions)} / with diffs ${formatNumber(dashboard.kpis.vibeRecordsWithDiffs)}`
                  : undefined
              }
            />
            <Metric
              label="Compile Health"
              value={dashboard ? toPercent(compileDegradedRuns, compileRuns) : "-"}
              hint={
                dashboard
                  ? `ok ${formatNumber(dashboard.kpis.compileOkRuns)} / degraded ${formatNumber(compileDegradedRuns)} / failed ${formatNumber(dashboard.kpis.compileFailedRuns)}`
                  : undefined
              }
            />
            <Metric
              label="Source Coverage"
              value={dashboard ? formatNumber(dashboard.kpis.linkedKnowledge) : "-"}
              hint={
                dashboard ? `unlinked ${formatNumber(dashboard.kpis.unlinkedKnowledge)}` : undefined
              }
            />
            <Metric
              label="Distillation Queue"
              value={
                dashboard
                  ? `${formatNumber(queueTotals.pending)} / ${formatNumber(queueTotals.running)}`
                  : "-"
              }
              hint={
                dashboard
                  ? `completed ${formatNumber(queueTotals.completed)} / failed ${formatNumber(queueTotals.failed)}`
                  : undefined
              }
            />
          </section>

          {dashboard ? <OverviewCharts dashboard={dashboard} /> : null}
        </>
      )}

      <section className="overview-health-grid">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
          </CardHeader>
          <CardContent className="runtime-list">
            <div>
              <span>Database</span>
              <strong>{doctor.data?.db.reachable ? "reachable" : "unknown"}</strong>
            </div>
            <div>
              <span>pgvector</span>
              <strong>{doctor.data?.vector.installed ? "installed" : "missing"}</strong>
            </div>
            <div>
              <span>Embedding daemon</span>
              <strong>{doctor.data?.embedding?.daemon.reachable ? "reachable" : "offline"}</strong>
            </div>
            <div>
              <span>Embedding CLI</span>
              <strong>{doctor.data?.embedding?.cli.usable ? "usable" : "unavailable"}</strong>
            </div>
            <div>
              <span>Agentic LLM</span>
              <strong>
                {doctor.data?.agenticLlm?.reachable
                  ? "reachable"
                  : doctor.data?.agenticLlm?.configured
                    ? "offline"
                    : "unconfigured"}
              </strong>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Doctor Signals</CardTitle>
          </CardHeader>
          <CardContent className="overview-reason-list">
            {(doctor.data?.reasons ?? []).length > 0 ? (
              doctor.data?.reasons.map((reason) => (
                <p key={reason} className="overview-reason-item">
                  {reason}
                </p>
              ))
            ) : (
              <p className="overview-reason-item">No degraded reasons</p>
            )}
            {(doctor.data?.mcp.nextActions ?? []).map((action) => (
              <p key={action} className="overview-next-action">
                {action}
              </p>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
