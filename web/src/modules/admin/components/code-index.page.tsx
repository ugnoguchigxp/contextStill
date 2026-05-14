import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createCodeSymbol,
  type CodeSymbol,
  type CodeSymbolWriteInput,
  deleteCodeSymbol,
  fetchCodeSymbols,
  updateCodeSymbol,
} from "../repositories/admin.repository";

const emptyForm: CodeSymbolWriteInput = {
  repoPath: "/Users/y.noguchi/Code/memoryRouter",
  filePath: "",
  symbolName: "",
  symbolKind: "function",
  signature: "",
  startLine: null,
  endLine: null,
  active: true,
  metadata: {},
};

export function CodeIndexPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CodeSymbolWriteInput>(emptyForm);
  const symbols = useQuery({
    queryKey: ["code-symbols", 200],
    queryFn: () => fetchCodeSymbols(200),
  });
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["code-symbols"] });
    await queryClient.invalidateQueries({ queryKey: ["graph"] });
  };
  const save = useMutation({
    mutationFn: () => (editingId ? updateCodeSymbol(editingId, form) : createCodeSymbol(form)),
    onSuccess: async () => {
      setEditingId(null);
      setForm(emptyForm);
      await invalidate();
    },
  });
  const remove = useMutation({ mutationFn: deleteCodeSymbol, onSuccess: invalidate });

  const edit = (symbol: CodeSymbol) => {
    setEditingId(symbol.id);
    setForm({
      repoPath: symbol.repoPath,
      filePath: symbol.filePath,
      symbolName: symbol.symbolName,
      symbolKind: symbol.symbolKind,
      signature: symbol.signature ?? "",
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      active: symbol.active,
      metadata: symbol.metadata ?? {},
    });
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Code Index</h1>
          <p>GitNexus型の構造理解に向けたsymbol indexを作成・編集・削除します。</p>
        </div>
      </section>

      <Card>
        <CardContent className="maintenance-form">
          <div className="form-grid">
            <Input
              placeholder="repo path"
              value={form.repoPath}
              onChange={(event) => setForm({ ...form, repoPath: event.target.value })}
            />
            <Input
              placeholder="file path"
              value={form.filePath}
              onChange={(event) => setForm({ ...form, filePath: event.target.value })}
            />
            <Input
              placeholder="symbol name"
              value={form.symbolName}
              onChange={(event) => setForm({ ...form, symbolName: event.target.value })}
            />
            <Input
              placeholder="symbol kind"
              value={form.symbolKind}
              onChange={(event) => setForm({ ...form, symbolKind: event.target.value })}
            />
          </div>
          <Input
            placeholder="signature"
            value={form.signature ?? ""}
            onChange={(event) => setForm({ ...form, signature: event.target.value })}
          />
          <div className="form-grid">
            <Input
              type="number"
              placeholder="start line"
              value={form.startLine ?? ""}
              onChange={(event) =>
                setForm({
                  ...form,
                  startLine: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
            <Input
              type="number"
              placeholder="end line"
              value={form.endLine ?? ""}
              onChange={(event) =>
                setForm({
                  ...form,
                  endLine: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
            <label className="inline-check" htmlFor="code-symbol-active">
              <Checkbox
                id="code-symbol-active"
                checked={form.active}
                onChange={(event) => setForm({ ...form, active: event.currentTarget.checked })}
              />
              active
            </label>
          </div>
          <div className="form-actions">
            <Button type="button" onClick={() => save.mutate()}>
              {editingId ? "Update Symbol" : "Create Symbol"}
            </Button>
            {editingId ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditingId(null);
                  setForm(emptyForm);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="table-panel">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Lines</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {symbols.data?.map((symbol) => (
                <TableRow key={symbol.id}>
                  <TableCell>
                    <strong>{symbol.symbolName}</strong>
                    {symbol.signature ? <p className="row-subtext">{symbol.signature}</p> : null}
                  </TableCell>
                  <TableCell>{symbol.symbolKind}</TableCell>
                  <TableCell className="max-w-md whitespace-normal">{symbol.filePath}</TableCell>
                  <TableCell>
                    {symbol.startLine
                      ? `${symbol.startLine}-${symbol.endLine ?? symbol.startLine}`
                      : "-"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={symbol.active ? "success" : "secondary"}>
                      {symbol.active ? "active" : "inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="row-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => edit(symbol)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm(`Delete symbol: ${symbol.symbolName}?`)) {
                            remove.mutate(symbol.id);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!symbols.isLoading && (symbols.data?.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="state-cell">
                    code symbolはまだindexされていません。
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
