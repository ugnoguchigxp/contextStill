import { Button } from "@/components/ui/button";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type CopyState = "idle" | "copied" | "failed";

type CopyableIdFieldProps = {
  label: string;
  value: string | null;
};

function shortenId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

export function CopyableIdField({ label, value }: CopyableIdFieldProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const hasValue = typeof value === "string" && value.trim().length > 0;
  const displayValue = useMemo(() => (hasValue ? shortenId(value) : "-"), [hasValue, value]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(
      () => setCopyState("idle"),
      copyState === "copied" ? 1200 : 1500,
    );
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const onCopy = async () => {
    if (!hasValue || !value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1">
      <span className="text-[11px] font-bold uppercase text-muted-foreground">{label}</span>
      <span
        className="min-w-0 truncate font-mono text-xs text-foreground"
        title={hasValue ? value : "-"}
      >
        {displayValue}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={onCopy}
        disabled={!hasValue}
        title={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
      >
        {copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </Button>
    </div>
  );
}
