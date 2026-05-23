import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";

type AdminModalShellProps = {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  closeOnBackdrop?: boolean;
  overlayClassName?: string;
  panelClassName?: string;
  headerClassName?: string;
  bodyClassName?: string;
  closeAriaLabel?: string;
  ariaLabel?: string;
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
};

export function AdminModalShell({
  isOpen,
  onClose,
  title,
  children,
  closeOnBackdrop = false,
  overlayClassName,
  panelClassName,
  headerClassName,
  bodyClassName,
  closeAriaLabel = "Close modal",
  ariaLabel,
  headerLeading,
  headerTrailing,
}: AdminModalShellProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm",
        overlayClassName,
      )}
      onMouseDown={(event) => {
        if (!closeOnBackdrop) return;
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <Card
        className={cn(
          "w-full max-w-2xl max-h-[85vh] overflow-hidden border shadow-2xl animate-in zoom-in-95 duration-200",
          panelClassName,
        )}
        // biome-ignore lint/a11y/useSemanticElements: Card primitive renders <section>; modal dialog semantics are attached via ARIA attributes.
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onMouseDown={(event) => {
          if (!closeOnBackdrop) return;
          event.stopPropagation();
        }}
      >
        <div
          className={cn("flex items-center justify-between border-b px-6 py-4", headerClassName)}
        >
          <div className="flex min-w-0 items-center gap-3">
            {headerLeading}
            <div className="min-w-0">{title}</div>
          </div>
          <div className="flex items-center gap-2">
            {headerTrailing}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 rounded-full p-0"
              aria-label={closeAriaLabel}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className={cn("overflow-auto", bodyClassName)}>{children}</div>
      </Card>
    </div>
  );
}
