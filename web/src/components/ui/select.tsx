import { cn } from "@/lib/utils";
import type * as React from "react";

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "border-input bg-background ring-offset-background focus-visible:ring-ring/50 h-9 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
