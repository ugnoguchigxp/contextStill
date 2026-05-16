import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchDoctorReport, type SkippedRunReason } from "../repositories/admin.repository";

function formatSkippedRunReasons(reasons: SkippedRunReason[] | undefined): string {
  if (!reasons || reasons.length === 0) return "-";
  return reasons.map((item) => `${item.reason}: ${item.count}`).join(" / ");
}

export function DoctorPage() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });
  const report = doctor.data;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Doctor</h1>
          <p>DB、pgvector、embedding provider、compile run healthを確認します。</p>
        </div>
        {report ? (
          <Badge
            variant={
              report.status === "ok"
                ? "success"
                : report.status === "failed"
                  ? "destructive"
                  : "warning"
            }
          >
            {report.status}
          </Badge>
        ) : null}
      </section>

      <div className="split-grid">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
          </CardHeader>
          <CardContent className="runtime-list">
            <div>
              <span>Database</span>
              <strong>{report?.db.reachable ? "reachable" : "unknown"}</strong>
            </div>
            <div>
              <span>DB latency</span>
              <strong>{report ? `${report.db.durationMs}ms` : "-"}</strong>
            </div>
            <div>
              <span>pgvector</span>
              <strong>{report?.vector.installed ? "installed" : "missing"}</strong>
            </div>
            <div>
              <span>degraded rate</span>
              <strong>{report ? report.runs.degradedRate.toFixed(2) : "-"}</strong>
            </div>
            <div>
              <span>compile latency p50</span>
              <strong>
                {report?.runs.durationMsP50 !== null && report?.runs.durationMsP50 !== undefined
                  ? `${Math.round(report.runs.durationMsP50)}ms`
                  : "-"}
              </strong>
            </div>
            <div>
              <span>compile latency p95</span>
              <strong>
                {report?.runs.durationMsP95 !== null && report?.runs.durationMsP95 !== undefined
                  ? `${Math.round(report.runs.durationMsP95)}ms`
                  : "-"}
              </strong>
            </div>
            <div>
              <span>compile latency avg</span>
              <strong>
                {report?.runs.durationMsAvg !== null && report?.runs.durationMsAvg !== undefined
                  ? `${Math.round(report.runs.durationMsAvg)}ms`
                  : "-"}
              </strong>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Embedding</CardTitle>
          </CardHeader>
          <CardContent className="runtime-list">
            <div>
              <span>Provider</span>
              <strong>{report?.embedding?.provider ?? "-"}</strong>
            </div>
            <div>
              <span>Daemon</span>
              <strong>{report?.embedding?.daemon.reachable ? "reachable" : "offline"}</strong>
            </div>
            <div>
              <span>CLI fallback</span>
              <strong>{report?.embedding?.cli.usable ? "usable" : "unavailable"}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong className="truncate-text">{report?.embedding?.cli.modelDir ?? "-"}</strong>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent Log Sync</CardTitle>
        </CardHeader>
        <CardContent className="runtime-list">
          <div>
            <span>Codex sessions</span>
            <strong>{report?.agentLogSync.codex.sessionDirExists ? "available" : "missing"}</strong>
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
            <span>LaunchAgent</span>
            <strong>
              {report?.agentLogSync.launchAgent.loaded
                ? "loaded"
                : report?.agentLogSync.launchAgent.installed
                  ? "installed"
                  : "not installed"}
            </strong>
          </div>
          <div>
            <span>Sync states</span>
            <strong>{report?.agentLogSync.states.length ?? 0}</strong>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Vibe Distillation</CardTitle>
        </CardHeader>
        <CardContent className="runtime-list">
          <div>
            <span>LaunchAgent</span>
            <strong>
              {report?.vibeDistillation.launchAgent.loaded
                ? "loaded"
                : report?.vibeDistillation.launchAgent.installed
                  ? "installed"
                  : "not installed"}
            </strong>
          </div>
          <div>
            <span>Runs</span>
            <strong>{report?.vibeDistillation.runs.totalRuns ?? 0}</strong>
          </div>
          <div>
            <span>OK / skipped</span>
            <strong>
              {report
                ? `${report.vibeDistillation.runs.okRuns} / ${report.vibeDistillation.runs.skippedRuns}`
                : "-"}
            </strong>
          </div>
          <div>
            <span>Skipped reasons</span>
            <strong>
              {report
                ? formatSkippedRunReasons(report.vibeDistillation.runs.skippedRunReasons)
                : "-"}
            </strong>
          </div>
          <div>
            <span>Failed</span>
            <strong>{report?.vibeDistillation.runs.failedRuns ?? 0}</strong>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Source Distillation</CardTitle>
        </CardHeader>
        <CardContent className="runtime-list">
          <div>
            <span>LaunchAgent</span>
            <strong>
              {report?.sourceDistillation.launchAgent.loaded
                ? "loaded"
                : report?.sourceDistillation.launchAgent.installed
                  ? "installed"
                  : "not installed"}
            </strong>
          </div>
          <div>
            <span>Runs</span>
            <strong>{report?.sourceDistillation.runs.totalRuns ?? 0}</strong>
          </div>
          <div>
            <span>OK / skipped</span>
            <strong>
              {report
                ? `${report.sourceDistillation.runs.okRuns} / ${report.sourceDistillation.runs.skippedRuns}`
                : "-"}
            </strong>
          </div>
          <div>
            <span>Skipped reasons</span>
            <strong>
              {report
                ? formatSkippedRunReasons(report.sourceDistillation.runs.skippedRunReasons)
                : "-"}
            </strong>
          </div>
          <div>
            <span>Failed</span>
            <strong>{report?.sourceDistillation.runs.failedRuns ?? 0}</strong>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reasons</CardTitle>
        </CardHeader>
        <CardContent>
          {report?.reasons.length ? (
            <ul className="reason-list">
              {report.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="row-subtext">degraded reasonはありません。</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>HITL Backlog</CardTitle>
        </CardHeader>
        <CardContent className="runtime-list">
          <div>
            <span>Draft count</span>
            <strong>{report?.hitl.draftCount ?? 0}</strong>
          </div>
          <div>
            <span>Oldest draft age</span>
            <strong>
              {report?.hitl.oldestDraftAgeMinutes !== null &&
              report?.hitl.oldestDraftAgeMinutes !== undefined
                ? `${report.hitl.oldestDraftAgeMinutes} min`
                : "-"}
            </strong>
          </div>
          <div>
            <span>Draft from source distillation</span>
            <strong>{report?.hitl.draftFromSourceDistillationCount ?? 0}</strong>
          </div>
          <div>
            <span>Draft from vibe distillation</span>
            <strong>{report?.hitl.draftFromVibeDistillationCount ?? 0}</strong>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
