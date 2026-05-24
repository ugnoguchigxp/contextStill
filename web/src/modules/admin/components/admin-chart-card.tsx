import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type AdminChartCardProps = {
  title: string;
  children: ReactNode;
  className?: string;
};

export function AdminChartCard({ title, children, className }: AdminChartCardProps) {
  return (
    <div className={cn("flex flex-col gap-2 border-t border-slate-100/60 pt-4", className)}>
      <span className="text-[10.5px] font-bold text-slate-700 uppercase tracking-wide">
        {title}
      </span>
      <div className="w-full">{children}</div>
    </div>
  );
}
