import type {
  DistillationTargetState,
  QueueDashboardStats,
} from "../repositories/admin.repository";

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCooldownCountdown(cooldownUntil: string | null, nowMs: number): string {
  if (!cooldownUntil) return "ready";
  const untilMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(untilMs)) return "unknown";
  const remainingMs = Math.max(0, untilMs - nowMs);
  if (remainingMs <= 0) return "ready";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return `${hours}h ${restMinutes}m`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatLaunchCountdown(cooldownUntil: string | null, nowMs: number): string {
  if (!cooldownUntil) return "launch in 0 sec";
  const untilMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(untilMs)) return "launch pending";
  const remainingMs = Math.max(0, untilMs - nowMs);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  return `launch in ${totalSeconds} sec`;
}

export function formatFindCandidateReason(
  reason: QueueDashboardStats["findCandidate"]["reason"],
): string {
  switch (reason) {
    case "provider_cooldown":
      return "provider cooldown";
    case "recent_interactive_compile":
      return "recent compile";
    case "interactive_pressure":
      return "interactive pressure";
    case "parallel_lane_busy":
      return "parallel lane busy";
    case "next_retry":
      return "retry scheduled";
    case "no_target":
      return "no target";
    default:
      return reason.replaceAll("_", " ");
  }
}

export function formatFindCandidateTarget(
  targetKind: QueueDashboardStats["findCandidate"]["targetKind"],
): string {
  if (!targetKind) return "queue idle";
  return targetKind.replace("_", " ");
}

export const STEPS_IN_PIPELINE = [
  { key: "selected", label: "Target Selected" },
  { key: "reading", label: "Reading Content" },
  { key: "researching_source", label: "Researching Source" },
  { key: "writing_source", label: "Writing Source Markdown" },
  { key: "finding_candidate", label: "Finding Candidates" },
  { key: "covering_evidence", label: "Covering Evidence" },
  { key: "finalizing", label: "Finalizing States" },
  { key: "stored", label: "Stored in Registry" },
] as const;

export const PHASE_MAP: Record<string, { label: string }> = {
  selected: { label: "Target Selected" },
  reading: { label: "Reading Content" },
  researching_source: { label: "Researching Source" },
  writing_source: { label: "Writing Source Markdown" },
  finding_candidate: { label: "Finding Candidates" },
  covering_evidence: { label: "Covering Evidence" },
  finalizing: { label: "Finalizing States" },
  stored: { label: "Stored in Registry" },
};

export function statusBadgeStyle(item: DistillationTargetState): {
  className: string;
  label: string;
} {
  let className = "bg-slate-50 text-slate-600 border-slate-200/60";
  let label: string = item.status;

  if (item.status === "completed") {
    className =
      "bg-emerald-50 text-emerald-700 border-emerald-300/30 font-bold shadow-sm shadow-emerald-500/5";
  } else if (item.status === "failed") {
    className = "bg-rose-50 text-rose-700 border-rose-300/30 font-bold shadow-sm shadow-rose-500/5";
  } else if (item.status === "running") {
    className =
      "bg-amber-50 text-amber-700 border-amber-300/30 font-bold shadow-sm shadow-amber-500/5 animate-pulse";
    label = "Active";
  } else if (item.status === "paused") {
    className = "bg-violet-50 text-violet-700 border-violet-300/20 font-bold";
  } else if (item.status === "pending") {
    className = "bg-sky-50/50 text-sky-700 border-sky-200/20";
  }

  return { className, label };
}

export function kindBadgeStyle(targetKind: DistillationTargetState["targetKind"]): string {
  if (targetKind === "wiki_file") {
    return "bg-sky-50/80 text-sky-700 border-sky-200/30";
  }
  if (targetKind === "web_ingest") {
    return "bg-indigo-50/80 text-indigo-700 border-indigo-200/30";
  }
  if (targetKind === "vibe_memory") {
    return "bg-emerald-50/80 text-emerald-700 border-emerald-200/30";
  }
  if (targetKind === "knowledge_candidate") {
    return "bg-violet-50/80 text-violet-700 border-violet-200/30";
  }
  return "bg-slate-50 text-slate-600 border-slate-200/50";
}
