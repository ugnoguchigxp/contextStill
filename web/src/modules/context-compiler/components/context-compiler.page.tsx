import { useMemo } from "react";
import { useForm } from "react-hook-form";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
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
  includeTrial: boolean;
  filesCsv: string;
};

const columnHelper = createColumnHelper<CompileRunSummary>();

const columns = [
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => info.getValue(),
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
      includeTrial: false,
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
      includeTrial: values.includeTrial,
      files: files.length > 0 ? files : undefined,
    });
  });

  return (
    <div className="page">
      <h1>memory-router</h1>
      <p className="subtitle">Context Compiler Control Plane</p>

      <section className="panel">
        <h2>Compile</h2>
        <form className="form" onSubmit={onSubmit}>
          <label>
            Goal
            <textarea
              rows={4}
              placeholder="Describe what you want the agent to do"
              {...register("goal", { required: true })}
            />
          </label>
          <div className="row">
            <label>
              Intent
              <select {...register("intent")}>
                <option value="plan">plan</option>
                <option value="edit">edit</option>
                <option value="debug">debug</option>
                <option value="review">review</option>
                <option value="finish">finish</option>
              </select>
            </label>
            <label>
              Retrieval Mode
              <select {...register("retrievalMode")}>
                <option value="">(auto)</option>
                <option value="task_context">task_context</option>
                <option value="review_context">review_context</option>
                <option value="debug_context">debug_context</option>
                <option value="architecture_context">architecture_context</option>
                <option value="skill_context">skill_context</option>
                <option value="learning_context">learning_context</option>
              </select>
            </label>
          </div>
          <label>
            Files (comma-separated)
            <input placeholder="src/a.ts,src/b.ts" {...register("filesCsv")} />
          </label>
          <label className="checkbox">
            <input type="checkbox" {...register("includeTrial")} />
            include trial knowledge
          </label>
          <button type="submit" disabled={compile.isPending || formState.isSubmitting}>
            {compile.isPending ? "Compiling..." : "Compile"}
          </button>
          {compile.error ? <p className="error">{String(compile.error)}</p> : null}
        </form>
      </section>

      <section className="panel">
        <h2>Recent Runs</h2>
        {runs.isLoading ? <p>Loading...</p> : null}
        {runs.error ? <p className="error">{String(runs.error)}</p> : null}
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Last Compile Result</h2>
        {compileResult ? <pre>{compileResult}</pre> : <p>No compile result yet.</p>}
      </section>
    </div>
  );
}
