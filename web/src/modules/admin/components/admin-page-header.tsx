import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCcw } from "lucide-react";
import type { ReactNode } from "react";

type AdminPageHeaderProps = {
  title: string;
  titleClassName?: string;
  checkedAtText?: string;
  refreshDisabled?: boolean;
  onRefresh?: () => void;
  refreshLabel?: string;
  status?: "ok" | "degraded" | "failed";
  statusLabel?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
};

function statusVariant(
  status: "ok" | "degraded" | "failed",
): "success" | "warning" | "destructive" {
  if (status === "ok") return "success";
  if (status === "failed") return "destructive";
  return "warning";
}

export function AdminPageHeader({
  title,
  titleClassName = "text-lg font-bold",
  checkedAtText,
  refreshDisabled = false,
  onRefresh,
  refreshLabel = "Refresh",
  status,
  statusLabel,
  leftSlot,
  rightSlot,
}: AdminPageHeaderProps) {
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-6 py-2">
      <div className="flex items-center gap-3">
        <h1 className={titleClassName}>{title}</h1>
        {leftSlot}
      </div>
      <div className="overview-heading-actions">
        {checkedAtText ? (
          <span className="overview-checked-at">checkedAt {checkedAtText}</span>
        ) : null}
        {onRefresh ? (
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshDisabled}>
            <RefreshCcw size={14} />
            {refreshLabel}
          </Button>
        ) : null}
        {status ? <Badge variant={statusVariant(status)}>{statusLabel ?? status}</Badge> : null}
        {rightSlot}
      </div>
    </section>
  );
}
