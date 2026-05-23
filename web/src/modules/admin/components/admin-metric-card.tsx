import { Card, CardContent } from "@/components/ui/card";

type AdminMetricCardProps = {
  label: string;
  value: string | number;
  hint?: string;
  size?: "sm" | "lg";
  icon?: React.ComponentType<{ className?: string }>;
  progress?: number;
  status?: "success" | "warning" | "destructive" | "normal";
  accent?: "emerald" | "cyan" | "violet" | "amber" | "slate";
};

export function AdminMetricCard({
  label,
  value,
  hint,
  size = "sm",
  icon: Icon,
  progress,
  status = "normal",
  accent = "slate",
}: AdminMetricCardProps) {
  const cardClasses = [
    "overview-metric-card",
    `size-${size}`,
    `accent-${accent}`,
    `status-${status}`,
    progress !== undefined ? "has-progress" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card className={cardClasses}>
      <CardContent className="metric-card overview-metric-content">
        <div className="metric-header-row">
          <span className="metric-label">{label}</span>
          {Icon && size === "lg" && <Icon className="metric-icon-lg" />}
        </div>
        <div className="metric-body-row">
          {Icon && size === "sm" && <Icon className="metric-icon-sm" />}
          <strong className="metric-value">{value}</strong>
        </div>
        {hint ? <span className="metric-hint">{hint}</span> : null}
        
        {progress !== undefined && (
          <div className="metric-progress-container">
            <div
              className="metric-progress-bar"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

