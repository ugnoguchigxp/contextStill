import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  createEvidenceFragment,
  createEvidenceSource,
  deleteEvidenceFragment,
  deleteEvidenceSource,
  type EvidenceFragment,
  type EvidenceFragmentWriteInput,
  type EvidenceSource,
  type EvidenceSourceWriteInput,
  fetchEvidenceFragments,
  fetchEvidenceSources,
  updateEvidenceFragment,
  updateEvidenceSource,
} from "../repositories/admin.repository";

const emptySource: EvidenceSourceWriteInput = {
  sourceKind: "manual",
  uri: "",
  title: "",
  metadata: {},
};

const emptyFragment: EvidenceFragmentWriteInput = {
  sourceId: "",
  locator: "full",
  content: "",
  metadata: {},
};

export function EvidencePage() {
  const queryClient = useQueryClient();
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sourceForm, setSourceForm] = useState<EvidenceSourceWriteInput>(emptySource);
  const [fragmentId, setFragmentId] = useState<string | null>(null);
  const [fragmentForm, setFragmentForm] = useState<EvidenceFragmentWriteInput>(emptyFragment);
  const sources = useQuery({
    queryKey: ["evidence-sources", 120],
    queryFn: () => fetchEvidenceSources(120),
  });
  const fragments = useQuery({
    queryKey: ["evidence-fragments", 120],
    queryFn: () => fetchEvidenceFragments(120),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["evidence-sources"] });
    await queryClient.invalidateQueries({ queryKey: ["evidence-fragments"] });
    await queryClient.invalidateQueries({ queryKey: ["graph"] });
  };

  const saveSource = useMutation({
    mutationFn: () =>
      sourceId ? updateEvidenceSource(sourceId, sourceForm) : createEvidenceSource(sourceForm),
    onSuccess: async () => {
      setSourceId(null);
      setSourceForm(emptySource);
      await invalidate();
    },
  });
  const saveFragment = useMutation({
    mutationFn: () =>
      fragmentId
        ? updateEvidenceFragment(fragmentId, fragmentForm)
        : createEvidenceFragment(fragmentForm),
    onSuccess: async () => {
      setFragmentId(null);
      setFragmentForm(emptyFragment);
      await invalidate();
    },
  });
  const removeSource = useMutation({ mutationFn: deleteEvidenceSource, onSuccess: invalidate });
  const removeFragment = useMutation({ mutationFn: deleteEvidenceFragment, onSuccess: invalidate });

  const editSource = (source: EvidenceSource) => {
    setSourceId(source.id);
    setSourceForm({
      sourceKind: source.sourceKind,
      uri: source.uri,
      title: source.title ?? "",
      contentHash: source.contentHash,
      metadata: source.metadata ?? {},
    });
  };
  const editFragment = (fragment: EvidenceFragment) => {
    setFragmentId(fragment.id);
    setFragmentForm({
      sourceId: fragment.sourceId,
      locator: fragment.locator,
      content: fragment.content,
      metadata: fragment.metadata ?? {},
    });
  };

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Evidence</h1>
          <p>Instructionとは分離した証拠sourceとfragmentを作成・編集・削除します。</p>
        </div>
      </section>

      <div className="split-grid">
        <Card>
          <CardHeader>
            <CardTitle>Source Form</CardTitle>
          </CardHeader>
          <CardContent className="maintenance-form">
            <Select
              value={sourceForm.sourceKind}
              onChange={(event) => setSourceForm({ ...sourceForm, sourceKind: event.target.value })}
            >
              {["markdown", "session", "tool_output", "git", "web", "manual"].map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
            <Input
              placeholder="uri"
              value={sourceForm.uri}
              onChange={(event) => setSourceForm({ ...sourceForm, uri: event.target.value })}
            />
            <Input
              placeholder="title"
              value={sourceForm.title ?? ""}
              onChange={(event) => setSourceForm({ ...sourceForm, title: event.target.value })}
            />
            <div className="form-actions">
              <Button type="button" onClick={() => saveSource.mutate()}>
                {sourceId ? "Update Source" : "Create Source"}
              </Button>
              {sourceId ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setSourceId(null);
                    setSourceForm(emptySource);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fragment Form</CardTitle>
          </CardHeader>
          <CardContent className="maintenance-form">
            <Select
              value={fragmentForm.sourceId}
              onChange={(event) =>
                setFragmentForm({ ...fragmentForm, sourceId: event.target.value })
              }
            >
              <option value="">sourceを選択</option>
              {sources.data?.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title || source.uri}
                </option>
              ))}
            </Select>
            <Input
              placeholder="locator"
              value={fragmentForm.locator}
              onChange={(event) =>
                setFragmentForm({ ...fragmentForm, locator: event.target.value })
              }
            />
            <Textarea
              placeholder="content"
              value={fragmentForm.content}
              onChange={(event) =>
                setFragmentForm({ ...fragmentForm, content: event.target.value })
              }
            />
            <div className="form-actions">
              <Button type="button" onClick={() => saveFragment.mutate()}>
                {fragmentId ? "Update Fragment" : "Create Fragment"}
              </Button>
              {fragmentId ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setFragmentId(null);
                    setFragmentForm(emptyFragment);
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="split-grid">
        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
          </CardHeader>
          <CardContent className="table-panel">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>URI</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.data?.map((source) => (
                  <TableRow key={source.id}>
                    <TableCell>{source.sourceKind}</TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      {source.title || source.uri}
                    </TableCell>
                    <TableCell>{new Date(source.updatedAt).toLocaleString("ja-JP")}</TableCell>
                    <TableCell>
                      <div className="row-actions">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => editSource(source)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (confirm(`Delete source: ${source.title || source.uri}?`)) {
                              removeSource.mutate(source.id);
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fragments</CardTitle>
          </CardHeader>
          <CardContent className="table-panel">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Locator</TableHead>
                  <TableHead>Content</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fragments.data?.map((fragment) => (
                  <TableRow key={fragment.id}>
                    <TableCell>{fragment.locator}</TableCell>
                    <TableCell className="max-w-lg whitespace-normal">
                      <p className="row-subtext">{fragment.sourceUri}</p>
                      {fragment.content.slice(0, 220)}
                    </TableCell>
                    <TableCell>
                      <div className="row-actions">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => editFragment(fragment)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (confirm(`Delete fragment: ${fragment.locator}?`)) {
                              removeFragment.mutate(fragment.id);
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
