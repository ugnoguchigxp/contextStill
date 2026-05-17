import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchDoctorReport,
  type DoctorReport,
  type SkippedRunReason,
} from "../repositories/admin.repository";

function formatReasonCounts(reasons: SkippedRunReason[] | undefined): string {
  if (!reasons || reasons.length === 0) return "-";
  return reasons.map((item) => `${item.reason}: ${item.count}`).join(" / ");
}

function sortedReasonCounts(reasons: SkippedRunReason[] | undefined): SkippedRunReason[] {
  return [...(reasons ?? [])].sort((left, right) => right.count - left.count);
}

function formatAgeMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  if (value < 60) return `${Math.round(value)} min`;
  if (value < 60 * 48) return `${(value / 60).toFixed(1)} h`;
  return `${(value / 60 / 24).toFixed(1)} d`;
}

function outcomeLabel(reason: string): string {
  const labels: Record<string, string> = {
    candidate_rejected: "Rejected",
    invalid_candidate: "Invalid candidate",
    knowledge_created: "Created",
    knowledge_deduped: "Deduped",
    llm_empty_response: "Empty response",
    llm_provider_error: "LLM provider",
    llm_timeout: "LLM timeout",
    llm_unparseable: "Unparseable",
    missing_external_evidence: "Evidence missing",
    missing_verification_tool_evidence: "Tool evidence missing",
    mixed_candidate_rejections: "Mixed rejection",
    no_candidate: "No candidate",
    processing_error: "Processing error",
    verification_no_candidate: "Verification empty",
  };
  return labels[reason] ?? reason;
}

function outcomeFocus(reason: string): string {
  const focus: Record<string, string> = {
    candidate_rejected: "candidate value",
    invalid_candidate: "candidate shape",
    knowledge_created: "review draft",
    knowledge_deduped: "dedupe",
    llm_empty_response: "runtime",
    llm_provider_error: "provider",
    llm_timeout: "timeout",
    llm_unparseable: "parser",
    missing_external_evidence: "evidence",
    missing_verification_tool_evidence: "tool use",
    mixed_candidate_rejections: "mixed",
    no_candidate: "source fit",
    processing_error: "runtime",
    verification_no_candidate: "verification",
  };
  return focus[reason] ?? "inspect";
}

function outcomeVariant(
  reason: string,
): "default" | "secondary" | "outline" | "success" | "warning" | "destructive" {
  if (reason === "knowledge_created" || reason === "knowledge_deduped") return "success";
  if (reason === "no_candidate") return "outline";
  if (
    reason === "llm_provider_error" ||
    reason === "llm_timeout" ||
    reason === "processing_error" ||
    reason === "missing_verification_tool_evidence"
  ) {
    return "destructive";
  }
  if (
    reason === "verification_no_candidate" ||
    reason === "missing_external_evidence" ||
    reason === "invalid_candidate" ||
    reason === "mixed_candidate_rejections" ||
    reason === "llm_empty_response" ||
    reason === "llm_unparseable"
  ) {
    return "warning";
  }
  return "secondary";
}

function launchAgentLabel(distillation: DoctorReport["vibeDistillation"] | undefined): string {
  if (!distillation) return "-";
  if (distillation.launchAgent.loaded) return "loaded";
  if (distillation.launchAgent.installed) return "installed";
  return "not installed";
}

function DistillationPanel({
  title,
  distillation,
}: {
  title: string;
  distillation: DoctorReport["vibeDistillation"] | undefined;
}) {
  const runs = distillation?.runs;
  const outcomes = sortedReasonCounts(runs?.outcomeKindCounts);

  return (
    <Card>
      <CardHeader className="doctor-card-header">
        <CardTitle>{title}</CardTitle>
        <Badge variant={distillation?.launchAgent.loaded ? "success" : "warning"}>
          {launchAgentLabel(distillation)}
        </Badge>
      </CardHeader>
      <CardContent className="doctor-distillation-panel">
        <div className="doctor-run-strip">
          <div>
            <span>Total</span>
            <strong>{runs?.totalRuns ?? 0}</strong>
          </div>
          <div>
            <span>OK</span>
            <strong>{runs?.okRuns ?? 0}</strong>
          </div>
          <div>
            <span>Skipped</span>
            <strong>{runs?.skippedRuns ?? 0}</strong>
          </div>
          <div>
            <span>Failed</span>
            <strong>{runs?.failedRuns ?? 0}</strong>
          </div>
        </div>

        <Table className="doctor-outcome-table">
          <TableHeader>
            <TableRow>
              <TableHead>Outcome</TableHead>
              <TableHead>Focus</TableHead>
              <TableHead className="doctor-count-cell">Count</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outcomes.length > 0 ? (
              outcomes.map((item) => (
                <TableRow key={item.reason}>
                  <TableCell className="doctor-outcome-cell">
                    <Badge variant={outcomeVariant(item.reason)}>{outcomeLabel(item.reason)}</Badge>
                    <span>{item.reason}</span>
                  </TableCell>
                  <TableCell className="doctor-focus-cell">{outcomeFocus(item.reason)}</TableCell>
                  <TableCell className="doctor-count-cell">{item.count}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3} className="state-cell">
                  No outcome data
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="doctor-meta-grid">
          <div>
            <span>Last run</span>
            <strong>{formatAgeMinutes(runs?.lastRunAgeMinutes)}</strong>
          </div>
          <div>
            <span>Last OK</span>
            <strong>{formatAgeMinutes(runs?.lastOkRunAgeMinutes)}</strong>
          </div>
          <div>
            <span>Legacy skip</span>
            <strong>{formatReasonCounts(runs?.skippedRunReasons)}</strong>
          </div>
        </div>
      </CardContent>
    </Card>
  );
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

      <div className="doctor-distillation-grid">
        <DistillationPanel title="Vibe Distillation" distillation={report?.vibeDistillation} />
        <DistillationPanel title="Source Distillation" distillation={report?.sourceDistillation} />
      </div>

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
