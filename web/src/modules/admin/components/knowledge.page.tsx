import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  fetchKnowledgeItems,
  type KnowledgeItem,
  type KnowledgeType,
  type KnowledgeWriteInput,
  updateKnowledgeItem,
} from "../repositories/admin.repository";

const knowledgeTypes: KnowledgeType[] = ["rule", "procedure"];

const emptyForm: KnowledgeWriteInput = {
  type: "rule",
  status: "draft",
  scope: "repo",
  title: "",
  body: "",
  confidence: 0.7,
  importance: 0.7,
  metadata: {},
};

const normalizeKnowledgeType = (type: string): KnowledgeType =>
  knowledgeTypes.includes(type as KnowledgeType) ? (type as KnowledgeType) : "rule";

export function KnowledgePage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<KnowledgeWriteInput>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const knowledge = useQuery({
    queryKey: ["knowledge", 120],
    queryFn: () => fetchKnowledgeItems(120),
  });
  const save = useMutation({
    mutationFn: () =>
      editingId ? updateKnowledgeItem(editingId, form) : createKnowledgeItem(form),
    onSuccess: async () => {
      setForm(emptyForm);
      setEditingId(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
    onError: (mutationError) => {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteKnowledgeItem(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });

  const edit = (item: KnowledgeItem) => {
    setEditingId(item.id);
    setForm({
      type: normalizeKnowledgeType(item.type),
      status: item.status,
      scope: item.scope,
      title: item.title,
      body: item.body,
      confidence: item.confidence,
      importance: item.importance,
      metadata: item.metadata ?? {},
    });
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Knowledge</h1>
          <p>エージェントの行動に効く rule / procedure と lifecycle 状態を管理します。</p>
        </div>
      </section>

      <Card>
        <CardContent className="maintenance-form">
          <Input
            placeholder="title"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <Textarea
            placeholder="body"
            value={form.body}
            onChange={(event) => setForm({ ...form, body: event.target.value })}
          />
          <div className="form-grid">
            <Select
              value={form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value as KnowledgeType })}
            >
              {knowledgeTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
            <Select
              value={form.status}
              onChange={(event) => setForm({ ...form, status: event.target.value })}
            >
              {["draft", "active", "deprecated"].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
            <Select
              value={form.scope}
              onChange={(event) => setForm({ ...form, scope: event.target.value })}
            >
              {["repo", "global"].map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </Select>
            <Input
              type="number"
              min="0"
              max="1"
              step="0.05"
              value={form.importance}
              onChange={(event) => setForm({ ...form, importance: Number(event.target.value) })}
            />
          </div>
          <div className="form-actions">
            <Button type="button" onClick={() => save.mutate()} disabled={save.isPending}>
              {editingId ? "Update" : "Create"}
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
            {error ? <span className="form-error">{error}</span> : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="table-panel">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {knowledge.data?.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="max-w-md whitespace-normal">
                    <strong>{item.title}</strong>
                    <p className="row-subtext">{item.body.slice(0, 140)}</p>
                  </TableCell>
                  <TableCell>
                    {knowledgeTypes.includes(item.type as KnowledgeType) ? (
                      item.type
                    ) : (
                      <Badge variant="warning">legacy: {item.type}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={item.status === "active" ? "success" : "secondary"}>
                      {item.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{item.scope}</TableCell>
                  <TableCell>
                    {item.importance.toFixed(2)} / {item.confidence.toFixed(2)}
                  </TableCell>
                  <TableCell>{new Date(item.updatedAt).toLocaleString("ja-JP")}</TableCell>
                  <TableCell>
                    <div className="row-actions">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => edit(item)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (confirm(`Delete knowledge item: ${item.title}?`)) {
                            remove.mutate(item.id);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!knowledge.isLoading && (knowledge.data?.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="state-cell">
                    knowledge itemはまだありません。
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
