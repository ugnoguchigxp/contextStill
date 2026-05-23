import { Badge } from "@/components/ui/badge";
import {
  type DoctorReasonDetail,
  formatDoctorReasonDetail as formatDoctorReason,
} from "../../../../../src/shared/doctor/doctor-reasons";
import type { DoctorReport } from "../repositories/admin.repository";

function reasonBadgeVariant(
  severity: DoctorReasonDetail["severity"],
): "destructive" | "warning" | "secondary" {
  if (severity === "critical") return "destructive";
  if (severity === "warning") return "warning";
  return "secondary";
}

function impactBadgeVariant(
  impactLevel: DoctorReasonDetail["impactLevel"],
): "destructive" | "warning" | "secondary" {
  if (impactLevel === "blocking") return "destructive";
  if (impactLevel === "degraded") return "warning";
  return "secondary";
}

function uniqueNonEmpty(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter((item) => item.length > 0))];
}

export function getDoctorReasonDetails(
  report: Pick<DoctorReport, "reasonDetails" | "reasons"> | null | undefined,
): DoctorReasonDetail[] {
  if (!report) return [];
  if (Array.isArray(report.reasonDetails) && report.reasonDetails.length > 0) {
    return report.reasonDetails;
  }
  return report.reasons.map((reason) => formatDoctorReason(reason));
}

export function getDoctorNextActions(report: DoctorReport | null | undefined): string[] {
  if (!report) return [];
  return uniqueNonEmpty([
    ...(report.mcp?.nextActions ?? []),
    ...(report.agentLogSync?.nextActions ?? []),
    ...(report.vibeDistillation?.nextActions ?? []),
    ...(report.sourceDistillation?.nextActions ?? []),
  ]);
}

export function DoctorReasonList({ reasons }: { reasons: DoctorReasonDetail[] }) {
  if (reasons.length === 0) {
    return <p className="overview-reason-item">No degraded reasons</p>;
  }

  return (
    <>
      {reasons.map((reason) => (
        <article key={reason.code} className="doctor-reason-card">
          <div className="doctor-reason-head">
            <Badge variant={reasonBadgeVariant(reason.severity)}>{reason.severity}</Badge>
            {reason.impactLevel ? (
              <Badge variant={impactBadgeVariant(reason.impactLevel)}>{reason.impactLevel}</Badge>
            ) : null}
            <Badge variant="outline">{reason.area}</Badge>
          </div>
          <strong className="doctor-reason-title">{reason.label}</strong>
          <p className="doctor-reason-body">{reason.description}</p>
          <p className="doctor-reason-sub">影響: {reason.impact}</p>
          <p className="doctor-reason-sub">対応: {reason.action}</p>
          <p className="doctor-reason-code">{reason.code}</p>
        </article>
      ))}
    </>
  );
}

export function DoctorNextActionList({ actions }: { actions: string[] }) {
  if (actions.length === 0) {
    return <p className="overview-reason-item">No pending actions</p>;
  }

  return (
    <>
      {actions.map((action) => (
        <p key={action} className="overview-next-action">
          {action}
        </p>
      ))}
    </>
  );
}
