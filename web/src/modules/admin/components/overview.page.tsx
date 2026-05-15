import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchDoctorReport,
  fetchGraphSnapshot,
  fetchKnowledgeItems,
  fetchSourceTree,
  fetchVibeMemories,
} from "../repositories/admin.repository";

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
    <Card>
      <CardContent className="metric-card">
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
        {hint ? <span className="metric-hint">{hint}</span> : null}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const knowledge = useQuery({ queryKey: ["knowledge", 80], queryFn: () => fetchKnowledgeItems() });
  const sources = useQuery({
    queryKey: ["page-tree"],
    queryFn: () => fetchSourceTree(),
  });
  const vibeMemories = useQuery({
    queryKey: ["vibe-memories", 120],
    queryFn: () => fetchVibeMemories(),
  });
  const graph = useQuery({ queryKey: ["graph", 120], queryFn: () => fetchGraphSnapshot() });
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: () => fetchDoctorReport() });

  const status = doctor.data?.status ?? "degraded";
  const hitl = doctor.data?.hitl;
  const hitlBacklogWarning =
    Boolean(hitl) &&
    ((hitl?.draftCount ?? 0) > (hitl?.backlogThresholdCount ?? Number.POSITIVE_INFINITY) ||
      (hitl?.oldestDraftAgeMinutes !== null &&
        hitl?.oldestDraftAgeMinutes !== undefined &&
        hitl.oldestDraftAgeMinutes >
          (hitl?.backlogThresholdAgeMinutes ?? Number.POSITIVE_INFINITY)));

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Overview</h1>
          <p>Context pack生成に必要な知識、ソース、vibe memory、診断状態を確認します。</p>
        </div>
        <Badge
          variant={status === "ok" ? "success" : status === "failed" ? "destructive" : "warning"}
        >
          {status}
        </Badge>
      </section>

      <section className="metric-grid">
        <Metric label="Knowledge" value={knowledge.data?.length ?? "-"} hint="rules / procedures" />
        <Metric label="Sources" value={sources.data?.items.length ?? "-"} hint="wiki pages" />
        <Metric
          label="Vibe Memory"
          value={vibeMemories.data?.length ?? "-"}
          hint="agent session history"
        />
        <Metric
          label="Graph Nodes"
          value={graph.data?.nodes.length ?? "-"}
          hint="knowledge graph"
        />
        <Metric
          label="Draft Knowledge"
          value={hitl?.draftCount ?? "-"}
          hint={`threshold ${hitl?.backlogThresholdCount ?? "-"}`}
        />
        <Metric
          label="Oldest Draft (min)"
          value={hitl?.oldestDraftAgeMinutes ?? "-"}
          hint={`threshold ${hitl?.backlogThresholdAgeMinutes ?? "-"}`}
        />
      </section>

      {hitlBacklogWarning ? (
        <Card>
          <CardContent className="metric-card">
            <span className="metric-label text-amber-400">HITL Warning</span>
            <strong className="metric-value">
              draft backlog is above threshold. Review and activate/deprecate drafts in Knowledge.
            </strong>
          </CardContent>
        </Card>
      ) : null}

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
    </div>
  );
}
