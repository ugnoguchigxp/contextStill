import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCheckedAt, formatNumber } from "@/lib/admin-formatters";
import { useQuery } from "@tanstack/react-query";
import { fetchDoctorReport } from "../repositories/admin.repository";
import { AdminMetricCard } from "./admin-metric-card";
import { AdminPageHeader } from "./admin-page-header";
import {
  DoctorNextActionList,
  DoctorReasonList,
  getDoctorNextActions,
  getDoctorReasonDetails,
} from "./doctor-signals";

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

export function DoctorPage() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });
  const report = doctor.data;
  const status = report?.status ?? "degraded";
  const reasonDetails = getDoctorReasonDetails(report);
  const nextActions = getDoctorNextActions(report);

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
  const missingTables = report?.tables?.missing.length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Doctor"
        checkedAtText={formatCheckedAt(report?.checkedAt)}
        onRefresh={() => {
          void doctor.refetch();
        }}
        refreshDisabled={doctor.isFetching}
        status={status}
      />

      <div className="page-stack min-h-0 flex-1 overflow-y-auto p-4">
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
              <AdminMetricCard
                label="System Status"
                value={report?.status ?? "-"}
                hint={
                  report
                    ? `blocking ${formatNumber(report.summary?.blocking ?? 0)} / degraded ${formatNumber(report.summary?.degraded ?? 0)} / maintenance ${formatNumber(report.summary?.maintenance ?? 0)}`
                    : undefined
                }
              />
              <AdminMetricCard
                label="DB Latency"
                value={formatDurationMs(report?.db.durationMs)}
                hint={
                  report
                    ? `${report.db.reachable ? "reachable" : "unreachable"} / missing tables ${missingTables}`
                    : undefined
                }
              />
              <AdminMetricCard
                label="Queue Pending"
                value={
                  report ? `${formatNumber(queuePending)} / ${formatNumber(queueRunning)}` : "-"
                }
                hint={
                  report
                    ? `paused ${formatNumber(queuePaused)} / failed ${formatNumber(queueFailed)}`
                    : undefined
                }
              />
              <AdminMetricCard
                label="Sync Freshness"
                value={formatAgeMinutes(maxSyncAge)}
                hint={report ? `stale states ${formatNumber(staleSyncCount)}` : undefined}
              />
            </section>

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
                        ? `avg ${formatDurationMs(report.runs.durationMsAvg)} / p95 ${formatDurationMs(report.runs.durationMsP95)}`
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
                      {formatAgeMinutes(
                        report?.vibeDistillation.queueHealth.oldestQueuedAgeMinutes,
                      )}
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
                  <DoctorReasonList reasons={reasonDetails} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Next Actions</CardTitle>
                </CardHeader>
                <CardContent className="overview-reason-list">
                  <DoctorNextActionList actions={nextActions} />
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
