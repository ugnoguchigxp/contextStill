import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchDoctorReport } from "../repositories/admin.repository";

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
    </div>
  );
}
