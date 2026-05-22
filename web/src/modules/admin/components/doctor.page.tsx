import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import {
  type DoctorReasonDetail,
  formatDoctorReasonDetail as formatDoctorReason,
} from "../../../../../src/shared/doctor/doctor-reasons";
import { fetchDoctorReport } from "../repositories/admin.repository";
import { DoctorCharts } from "./doctor-charts";

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

function formatCheckedAt(value: string | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value)}ms`;
}

function formatAgeMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  if (value < 60) return `${Math.round(value)} min`;
  if (value < 60 * 48) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 60 / 24).toFixed(1)} d`;
}

function launchAgentLabel(agent: { loaded: boolean; installed: boolean }): string {
  if (agent.loaded) return "loaded";
  if (agent.installed) return "installed";
  return "not installed";
}

function reasonBadgeVariant(
  severity: DoctorReasonDetail["severity"],
): "destructive" | "warning" | "secondary" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  return "secondary";
}

function uniqueNonEmpty(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
}

export function DoctorPage() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });
  const report = doctor.data;
  const status = report?.status ?? "degraded";
  const reasonDetails = report
    ? Array.isArray(report.reasonDetails) && report.reasonDetails.length > 0
      ? report.reasonDetails
      : report.reasons.map((reason) => formatDoctorReason(reason))
    : [];
  const nextActions = report
    ? uniqueNonEmpty([
        ...report.mcp.nextActions,
        ...report.agentLogSync.nextActions,
        ...report.vibeDistillation.nextActions,
        ...report.sourceDistillation.nextActions,
      ])
    : [];

  const queuePending = report
    ? report.vibeDistillation.jobs.queued + report.sourceDistillation.jobs.queued
    : null;
  const queueRunning = report
    ? report.vibeDistillation.jobs.running + report.sourceDistillation.jobs.running
    : null;
  const queuePaused = report
    ? report.vibeDistillation.jobs.paused + report.sourceDistillation.jobs.paused
    : null;
  const queueFailed = report
    ? report.vibeDistillation.jobs.failed + report.sourceDistillation.jobs.failed
    : null;
  const maxSyncAge = report
    ? report.agentLogSync.states.length > 0
      ? Math.max(...report.agentLogSync.states.map((item) => item.lastSyncedAgeMinutes ?? 0))
      : null
    : null;
  const syncStaleThresholdMinutes = report?.runs.freshnessThresholdMinutes ?? 720;
  const staleSyncCount = report
    ? report.agentLogSync.states.filter(
        (state) => (state.lastSyncedAgeMinutes ?? 0) > syncStaleThresholdMinutes,
      ).length
    : null;
  const usedKnowledge = report
    ? Math.max(
        0,
        report.knowledgeLifecycle.activeCount - report.knowledgeLifecycle.zeroUseActiveCount,
      )
    : null;
  const missingTables = report?.tables?.missing.length ?? 0;

  return (
    <div className="page-stack overview-layout doctor-layout">
      <section className="page-heading">
        <div>
          <h1>Doctor</h1>
          <p>Runtime、automation、compile、distillation の診断状態を確認します。</p>
        </div>
        <div className="overview-heading-actions">
          <span className="overview-checked-at">
            checkedAt {formatCheckedAt(report?.checkedAt)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void doctor.refetch();
            }}
            disabled={doctor.isFetching}
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

      {doctor.isError ? (
        <Card>
          <CardContent className="metric-card">
            <span className="metric-label text-red-600">Doctor API Error</span>
            <strong className="metric-value">/api/doctor response could not be loaded.</strong>
          </CardContent>
        </Card>
      ) : (
        <>
          <section className="metric-grid overview-metric-grid doctor-metric-grid">
            <Metric
              label="System Status"
              value={report?.status ?? "-"}
              hint={report ? `reasons ${report.reasons.length}` : undefined}
            />
            <Metric
              label="Compile Usable"
              value={formatPercent(report?.runs.usableRate)}
              hint={
                report
                  ? `usable ${formatNumber(report.runs.usableRuns)} / total ${formatNumber(report.runs.totalRuns)}`
                  : undefined
              }
            />
            <Metric
              label="Blocking Rate"
              value={formatPercent(report?.runs.blockingRate)}
              hint={
                report
                  ? `blocking ${formatNumber(report.runs.blockingRuns)} / degraded ${formatNumber(report.runs.degradedRuns)}`
                  : undefined
              }
            />
            <Metric
              label="DB Latency"
              value={formatDurationMs(report?.db.durationMs)}
              hint={
                report
                  ? `${report.db.reachable ? "reachable" : "unreachable"} / missing tables ${missingTables}`
                  : undefined
              }
            />
            <Metric
              label="Knowledge Usage"
              value={formatNumber(usedKnowledge)}
              hint={
                report
                  ? `unused active ${formatNumber(report.knowledgeLifecycle.zeroUseActiveCount)}`
                  : undefined
              }
            />
            <Metric
              label="HITL Drafts"
              value={formatNumber(report?.hitl.draftCount)}
              hint={
                report ? `oldest ${formatAgeMinutes(report.hitl.oldestDraftAgeMinutes)}` : undefined
              }
            />
            <Metric
              label="Queue Pending"
              value={report ? `${formatNumber(queuePending)} / ${formatNumber(queueRunning)}` : "-"}
              hint={
                report
                  ? `paused ${formatNumber(queuePaused)} / failed ${formatNumber(queueFailed)}`
                  : undefined
              }
            />
            <Metric
              label="Sync Freshness"
              value={formatAgeMinutes(maxSyncAge)}
              hint={report ? `stale states ${formatNumber(staleSyncCount)}` : undefined}
            />
          </section>

          {report ? <DoctorCharts report={report} /> : null}

          <section className="overview-health-grid doctor-health-grid">
            <Card>
              <CardHeader>
                <CardTitle>Runtime Matrix</CardTitle>
              </CardHeader>
              <CardContent className="runtime-list">
                <div>
                  <span>Database</span>
                  <strong>{report?.db.reachable ? "reachable" : "unknown"}</strong>
                </div>
                <div>
                  <span>Required tables</span>
                  <strong>
                    {report ? (missingTables > 0 ? `missing ${missingTables}` : "ok") : "-"}
                  </strong>
                </div>
                <div>
                  <span>pgvector</span>
                  <strong>{report?.vector.installed ? "installed" : "missing"}</strong>
                </div>
                <div>
                  <span>Embedding daemon</span>
                  <strong>{report?.embedding?.daemon.reachable ? "reachable" : "offline"}</strong>
                </div>
                <div>
                  <span>Embedding CLI</span>
                  <strong>{report?.embedding?.cli.usable ? "usable" : "unavailable"}</strong>
                </div>
                <div>
                  <span>Agentic LLM</span>
                  <strong>
                    {report?.agenticLlm?.reachable
                      ? "reachable"
                      : report?.agenticLlm?.configured
                        ? "offline"
                        : "unconfigured"}
                  </strong>
                </div>
                <div>
                  <span>MCP primary tools</span>
                  <strong>
                    {report
                      ? report.mcp.missingPrimaryTools.length > 0
                        ? `missing ${report.mcp.missingPrimaryTools.length}`
                        : "ok"
                      : "-"}
                  </strong>
                </div>
                <div>
                  <span>Compile latency</span>
                  <strong>
                    {report
                      ? `${formatDurationMs(report.runs.durationMsP50)} / ${formatDurationMs(report.runs.durationMsP95)}`
                      : "-"}
                  </strong>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Automation Matrix</CardTitle>
              </CardHeader>
              <CardContent className="runtime-list">
                <div>
                  <span>Log sync launch agent</span>
                  <strong>
                    {report ? launchAgentLabel(report.agentLogSync.launchAgent) : "-"}
                  </strong>
                </div>
                <div>
                  <span>Vibe distillation launch agent</span>
                  <strong>
                    {report ? launchAgentLabel(report.vibeDistillation.launchAgent) : "-"}
                  </strong>
                </div>
                <div>
                  <span>Source distillation launch agent</span>
                  <strong>
                    {report ? launchAgentLabel(report.sourceDistillation.launchAgent) : "-"}
                  </strong>
                </div>
                <div>
                  <span>Vibe pipeline lock</span>
                  <strong>
                    {report
                      ? report.vibeDistillation.queueHealth.lock.staleByCreatedAge
                        ? "stale"
                        : report.vibeDistillation.queueHealth.lock.exists
                          ? "held"
                          : "clear"
                      : "-"}
                  </strong>
                </div>
                <div>
                  <span>Source pipeline lock</span>
                  <strong>
                    {report
                      ? report.sourceDistillation.queueHealth.lock.staleByCreatedAge
                        ? "stale"
                        : report.sourceDistillation.queueHealth.lock.exists
                          ? "held"
                          : "clear"
                      : "-"}
                  </strong>
                </div>
                <div>
                  <span>Antigravity logs</span>
                  <strong>
                    {report?.agentLogSync.antigravity.configured
                      ? report.agentLogSync.antigravity.exists
                        ? "available"
                        : "missing"
                      : "not configured"}
                  </strong>
                </div>
                <div>
                  <span>Oldest vibe queue</span>
                  <strong>
                    {formatAgeMinutes(report?.vibeDistillation.queueHealth.oldestQueuedAgeMinutes)}
                  </strong>
                </div>
                <div>
                  <span>Oldest source queue</span>
                  <strong>
                    {formatAgeMinutes(
                      report?.sourceDistillation.queueHealth.oldestQueuedAgeMinutes,
                    )}
                  </strong>
                </div>
              </CardContent>
            </Card>
          </section>

          <section className="doctor-reason-grid">
            <Card>
              <CardHeader>
                <CardTitle>Doctor Signals</CardTitle>
              </CardHeader>
              <CardContent className="doctor-reason-list">
                {reasonDetails.length > 0 ? (
                  reasonDetails.map((reason) => (
                    <article key={reason.code} className="doctor-reason-card">
                      <div className="doctor-reason-head">
                        <Badge variant={reasonBadgeVariant(reason.severity)}>
                          {reason.severity}
                        </Badge>
                        <Badge variant="outline">{reason.area}</Badge>
                      </div>
                      <strong className="doctor-reason-title">{reason.label}</strong>
                      <p className="doctor-reason-body">{reason.description}</p>
                      <p className="doctor-reason-sub">影響: {reason.impact}</p>
                      <p className="doctor-reason-sub">対応: {reason.action}</p>
                      <p className="doctor-reason-code">{reason.code}</p>
                    </article>
                  ))
                ) : (
                  <p className="overview-reason-item">No degraded reasons</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Next Actions</CardTitle>
              </CardHeader>
              <CardContent className="overview-reason-list">
                {nextActions.length > 0 ? (
                  nextActions.map((action) => (
                    <p key={action} className="overview-next-action">
                      {action}
                    </p>
                  ))
                ) : (
                  <p className="overview-reason-item">No pending actions</p>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
