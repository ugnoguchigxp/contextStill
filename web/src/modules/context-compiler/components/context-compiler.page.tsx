import { useMemo } from "react";
import { useForm } from "react-hook-form";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useCompilePack, useCompileRuns } from "../hooks/context-compiler.hooks";
import type {
  CompileIntent,
  CompileMode,
  CompileRunSummary,
} from "../repositories/context-compiler.repository";

type FormValues = {
  goal: string;
  intent: CompileIntent;
  retrievalMode: "" | CompileMode;
  includeDraft: boolean;
  filesCsv: string;
};

const columnHelper = createColumnHelper<CompileRunSummary>();

const columns = [
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => {
      const value = info.getValue();
      if (value === "ok") return <Badge variant="success">ok</Badge>;
      if (value === "degraded") return <Badge variant="warning">degraded</Badge>;
      return <Badge variant="destructive">failed</Badge>;
    },
  }),
  columnHelper.accessor("intent", {
    header: "Intent",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("retrievalMode", {
    header: "Mode",
    cell: (info) => info.getValue(),
  }),
  columnHelper.accessor("createdAt", {
    header: "Created",
    cell: (info) => new Date(info.getValue()).toLocaleString(),
  }),
];

export function ContextCompilerPage() {
  const { register, handleSubmit, formState } = useForm<FormValues>({
    defaultValues: {
      goal: "",
      intent: "edit",
      retrievalMode: "",
      includeDraft: false,
      filesCsv: "",
    },
  });
  const compile = useCompilePack();
  const runs = useCompileRuns(20);

  const table = useReactTable({
    data: runs.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const compileResult = useMemo(
    () => (compile.data ? JSON.stringify(compile.data, null, 2) : ""),
    [compile.data],
  );

  const onSubmit = handleSubmit(async (values) => {
    const files = values.filesCsv
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    await compile.mutateAsync({
      goal: values.goal,
      intent: values.intent,
      retrievalMode: values.retrievalMode || undefined,
      includeDraft: values.includeDraft,
      files: files.length > 0 ? files : undefined,
    });
  });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 md:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">memory-router</h1>
        <p className="text-muted-foreground text-sm">Context Compiler Control Plane</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Compile</CardTitle>
          <CardDescription>
            Generate a context pack from current knowledge, sources, and code context.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="goal">Goal</Label>
              <Textarea
                id="goal"
                rows={4}
                placeholder="Describe what you want the agent to do"
                {...register("goal", { required: true })}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="intent">Intent</Label>
                <Select id="intent" {...register("intent")}>
                  <option value="plan">plan</option>
                  <option value="edit">edit</option>
                  <option value="debug">debug</option>
                  <option value="review">review</option>
                  <option value="finish">finish</option>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="retrievalMode">Retrieval Mode</Label>
                <Select id="retrievalMode" {...register("retrievalMode")}>
                  <option value="">(auto)</option>
                  <option value="task_context">task_context</option>
                  <option value="review_context">review_context</option>
                  <option value="debug_context">debug_context</option>
                  <option value="architecture_context">architecture_context</option>
                  <option value="procedure_context">procedure_context</option>
                  <option value="learning_context">learning_context</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="files">Files (comma-separated)</Label>
              <Input id="files" placeholder="src/a.ts,src/b.ts" {...register("filesCsv")} />
            </div>
            <Label htmlFor="includeDraft" className="flex items-center gap-2">
              <Checkbox id="includeDraft" {...register("includeDraft")} />
              include draft knowledge
            </Label>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={compile.isPending || formState.isSubmitting}>
                {compile.isPending ? "Compiling..." : "Compile"}
              </Button>
              {compile.error ? (
                <p className="text-destructive text-sm">{String(compile.error)}</p>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Runs</CardTitle>
          <CardDescription>Latest context compile executions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {runs.isLoading ? <p className="text-muted-foreground text-sm">Loading...</p> : null}
          {runs.error ? <p className="text-destructive text-sm">{String(runs.error)}</p> : null}
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Last Compile Result</CardTitle>
          <CardDescription>JSON response from the latest compile action.</CardDescription>
        </CardHeader>
        <CardContent>
          {compileResult ? (
            <pre className="bg-muted overflow-auto rounded-lg p-3 text-xs">{compileResult}</pre>
          ) : (
            <p className="text-muted-foreground text-sm">No compile result yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
