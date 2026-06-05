import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

function visiblePageNumbers(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 0) return [];
  if (totalPages <= 9) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, totalPages]);
  for (let pageNumber = currentPage - 2; pageNumber <= currentPage + 2; pageNumber += 1) {
    if (pageNumber >= 1 && pageNumber <= totalPages) pages.add(pageNumber);
  }

  const sortedPages = Array.from(pages).sort((a, b) => a - b);
  return sortedPages.flatMap((pageNumber, index) => {
    const previousPage = sortedPages[index - 1];
    return previousPage && pageNumber - previousPage > 1 ? ["ellipsis", pageNumber] : [pageNumber];
  });
}

type AdminPaginationFooterProps = {
  currentPage: number;
  totalPages: number;
  canPreviousPage: boolean;
  canNextPage: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onPageSelect: (pageNumber: number) => void;
  summaryItems: ReactNode[];
  keyPrefix: string;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
  disabled?: boolean;
};

export function AdminPaginationFooter({
  currentPage,
  totalPages,
  canPreviousPage,
  canNextPage,
  onPreviousPage,
  onNextPage,
  onPageSelect,
  summaryItems,
  keyPrefix,
  previousAriaLabel = "Previous page",
  nextAriaLabel = "Next page",
  disabled = false,
}: AdminPaginationFooterProps) {
  const pageNumbers = visiblePageNumbers(currentPage, totalPages);

  return (
    <div className="border-t bg-muted/10 px-4 py-1.5 flex flex-wrap items-center justify-between gap-3 text-[11px] leading-4">
      <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        {summaryItems.map((item, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: summary item count and order are fixed per page component
            key={`${keyPrefix}-pagination-summary-${index}`}
          >
            {item}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2"
          disabled={disabled || !canPreviousPage}
          onClick={onPreviousPage}
          aria-label={previousAriaLabel}
        >
          <ChevronLeft className="h-4 w-4" />
          Prev
        </Button>
        <div className="flex items-center gap-1">
          {pageNumbers.map((pageNumber, index) =>
            pageNumber === "ellipsis" ? (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: separator positions are derived from page windows
                key={`${keyPrefix}-page-ellipsis-${index}`}
                className="px-1 text-xs text-muted-foreground"
              >
                ...
              </span>
            ) : (
              <button
                key={`${keyPrefix}-page-${pageNumber}`}
                type="button"
                className={`h-7 min-w-7 rounded-md px-2 text-xs transition-colors ${
                  currentPage === pageNumber
                    ? "bg-primary font-bold text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
                disabled={disabled}
                onClick={() => onPageSelect(pageNumber)}
                aria-current={currentPage === pageNumber ? "page" : undefined}
              >
                {pageNumber}
              </button>
            ),
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2"
          disabled={disabled || !canNextPage}
          onClick={onNextPage}
          aria-label={nextAriaLabel}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
