import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type AdminChartCardProps = {
  title: string;
  children: ReactNode;
  className?: string;
};

export function AdminChartCard({ title, children, className }: AdminChartCardProps) {
  return (
    <Card className={cn("overview-chart-card", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
