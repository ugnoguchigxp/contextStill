import type * as React from "react";
import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        "border-input text-primary focus-visible:ring-ring/50 size-4 shrink-0 rounded border bg-transparent shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Checkbox };
