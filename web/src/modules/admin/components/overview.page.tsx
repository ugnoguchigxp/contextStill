import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type OverviewDashboard,
  fetchDoctorReport,
  fetchOverviewDashboard,
} from "../repositories/admin.repository";
import {
  DoctorNextActionList,
  DoctorReasonList,
  getDoctorNextActions,
  getDoctorReasonDetails,
} from "./doctor-signals";
import { OverviewCharts } from "./overview-charts";

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

function formatJpy(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: value < 1 ? 2 : 0,
  }).format(value);
}

function formatJpyPerMillionTokens(value: number): string {
  return `${formatJpy(value)}/1M`;
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

function formatCountdown(cooldownUntil: string | null, nowMs: number): string {
  if (!cooldownUntil) return "unknown";
  const untilMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(untilMs)) return "unknown";
  const remainingSeconds = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  if (days > 0) {
    const hours = Math.floor((remainingSeconds % 86_400) / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
  }
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatRefreshTime(cooldownUntil: string | null): string {
  if (!cooldownUntil) return "-";
  const date = new Date(cooldownUntil);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function SearchApiStatusCard({
  label,
  state,
  nowMs,
}: {
  label: string;
  state: OverviewDashboard["searchApiStatus"]["brave"];
  nowMs: number;
}) {
  const isCooldown = state.status === "cooldown";
  const hasRefreshTime = Boolean(state.cooldownUntil);

  return (
    <Card className={`search-status-card ${isCooldown ? "cooldown" : "ok"}`}>
      <CardContent className="search-status-content">
        <div className="search-status-main">
          <span className="metric-label">{label}</span>
          <Badge variant={isCooldown ? "destructive" : "success"}>
            <span className="search-status-dot" />
            {isCooldown ? "cooldown" : "active"}
          </Badge>
        </div>
        <strong className="search-status-value">
          {isCooldown ? formatCountdown(state.cooldownUntil, nowMs) : "Ready"}
        </strong>
        <span className="metric-hint">
          {isCooldown
            ? hasRefreshTime
              ? `refresh ${formatRefreshTime(state.cooldownUntil)}`
              : "refresh time unknown"
            : (state.lastError ?? "no active cooldown")}
        </span>
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const overview = useQuery({
    queryKey: ["overview-dashboard"],
    queryFn: () => fetchOverviewDashboard(),
  });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const dashboard = overview.data;
  const doctorReport = doctor.data;
  const status = doctorReport?.status ?? "degraded";
  const reasonDetails = getDoctorReasonDetails(doctorReport);
  const nextActions = getDoctorNextActions(doctorReport);
  const overviewErrorMessage =
    overview.error instanceof Error
      ? overview.error.message
      : "/api/overview response could not be loaded.";
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
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <section className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-6 py-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold">Overview</h1>
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

      <div className="page-stack min-h-0 flex-1 overflow-y-auto p-4">
        {overview.isError ? (
          <Card>
            <CardContent className="metric-card">
              <span className="metric-label text-red-600">Overview API Error</span>
              <strong className="metric-value">{overviewErrorMessage}</strong>
              <span className="metric-hint">
                Existing dashboard data remains visible when it is available.
              </span>
            </CardContent>
          </Card>
        ) : null}

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
            label="Local LLM 30d"
            value={dashboard ? formatNumber(dashboard.llmUsage.kpis.localTokensTotal30d) : "-"}
            hint={
              dashboard
                ? `in ${formatNumber(dashboard.llmUsage.kpis.localPromptTokens30d)} / out ${formatNumber(dashboard.llmUsage.kpis.localCompletionTokens30d)}`
                : undefined
            }
          />
          <Metric
            label="Cloud LLM 30d"
            value={dashboard ? formatNumber(dashboard.llmUsage.kpis.cloudTokensTotal30d) : "-"}
            hint={
              dashboard
                ? `in ${formatNumber(dashboard.llmUsage.kpis.cloudPromptTokens30d)} / out ${formatNumber(dashboard.llmUsage.kpis.cloudCompletionTokens30d)}`
                : undefined
            }
          />
          <Metric
            label="Cloud LLM Cost 30d"
            value={dashboard ? formatJpy(dashboard.llmUsage.kpis.cloudCostJpyTotal30d) : "-"}
            hint={
              dashboard
                ? `${dashboard.llmUsage.kpis.cloudModel} / in ${formatJpyPerMillionTokens(dashboard.llmUsage.kpis.cloudInputCostJpyPerMTokens)} / out ${formatJpyPerMillionTokens(dashboard.llmUsage.kpis.cloudOutputCostJpyPerMTokens)}`
                : undefined
            }
          />
          <Metric
            label="LLM Measured Ratio 30d"
            value={
              dashboard ? `${dashboard.llmUsage.kpis.measuredCoveragePercent30d.toFixed(1)}%` : "-"
            }
            hint={
              dashboard
                ? `calls ${formatNumber(dashboard.llmUsage.kpis.measuredCalls30d)} measured / ${formatNumber(dashboard.llmUsage.kpis.estimatedCalls30d)} estimated`
                : undefined
            }
          />
          <Metric
            label="Estimated Tokens 30d"
            value={dashboard ? formatNumber(dashboard.llmUsage.kpis.estimatedTokensTotal30d) : "-"}
            hint={
              dashboard
                ? `measured ${formatNumber(dashboard.llmUsage.kpis.measuredTokensTotal30d)} / total calls ${formatNumber(dashboard.llmUsage.kpis.totalCalls30d)}`
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

        {dashboard ? (
          <section className="search-status-grid">
            <SearchApiStatusCard
              label="Brave Search"
              state={dashboard.searchApiStatus.brave}
              nowMs={nowMs}
            />
            <SearchApiStatusCard
              label="Exa Search"
              state={dashboard.searchApiStatus.exa}
              nowMs={nowMs}
            />
          </section>
        ) : null}

        {dashboard ? (
          <Card>
            <CardHeader>
              <CardTitle>LLM Activity Sources (30d, JST)</CardTitle>
            </CardHeader>
            <CardContent className="runtime-list">
              {dashboard.llmUsage.bySource.length > 0 ? (
                dashboard.llmUsage.bySource.map((item) => (
                  <div key={item.source}>
                    <span>{item.source}</span>
                    <strong>
                      {formatNumber(item.calls)} calls / {formatNumber(item.totalTokens)} tokens /{" "}
                      {toPercent(item.measuredCalls, item.calls)} measured
                    </strong>
                  </div>
                ))
              ) : (
                <div>
                  <span>no llm activity</span>
                  <strong>-</strong>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        {dashboard ? <OverviewCharts dashboard={dashboard} /> : null}

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
                <strong>
                  {doctor.data?.embedding?.daemon.reachable ? "reachable" : "offline"}
                </strong>
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
            <CardContent className="doctor-reason-list">
              <DoctorReasonList reasons={reasonDetails} />
              <div className="overview-next-action-group">
                <span className="metric-label">Next Actions</span>
                <DoctorNextActionList actions={nextActions} />
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
