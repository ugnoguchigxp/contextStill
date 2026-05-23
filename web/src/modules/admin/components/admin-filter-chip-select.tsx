import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ComponentProps, ReactNode } from "react";

type AdminFilterChipSelectProps = Omit<ComponentProps<typeof Select>, "children"> & {
  label: string;
  children: ReactNode;
  containerClassName?: string;
  labelClassName?: string;
};

export function AdminFilterChipSelect({
  label,
  children,
  className,
  containerClassName,
  labelClassName,
  ...props
}: AdminFilterChipSelectProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border border-transparent bg-muted px-3 py-1",
        containerClassName,
      )}
    >
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-[10px] font-bold uppercase text-muted-foreground",
          labelClassName,
        )}
      >
        {label}
      </span>
      <Select
        className={cn(
          "h-7 border-0 bg-transparent px-1 py-0 text-xs font-medium shadow-none focus-visible:ring-0 focus-visible:ring-offset-0",
          className,
        )}
        {...props}
      >
        {children}
      </Select>
    </div>
  );
}
