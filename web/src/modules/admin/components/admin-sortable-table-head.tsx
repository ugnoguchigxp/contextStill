import { TableHead } from "@/components/ui/table";
import { type Header, flexRender } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

type AdminSortableTableHeadProps<TData> = {
  header: Header<TData, unknown>;
  className?: string;
  buttonClassName?: string;
};

export function AdminSortableTableHead<TData>({
  header,
  className,
  buttonClassName = "flex cursor-pointer select-none items-center gap-2 transition-colors hover:text-foreground",
}: AdminSortableTableHeadProps<TData>) {
  return (
    <TableHead className={className}>
      {header.isPlaceholder ? null : header.column.getCanSort() ? (
        <button
          type="button"
          className={buttonClassName}
          onClick={header.column.getToggleSortingHandler()}
        >
          {flexRender(header.column.columnDef.header, header.getContext())}
          <span className="w-4">
            {{
              asc: <ArrowUp size={12} />,
              desc: <ArrowDown size={12} />,
            }[header.column.getIsSorted() as string] ?? (
              <ArrowUpDown size={12} className="opacity-30" />
            )}
          </span>
        </button>
      ) : (
        <div>{flexRender(header.column.columnDef.header, header.getContext())}</div>
      )}
    </TableHead>
  );
}
