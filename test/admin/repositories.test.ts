import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchKnowledgeItems,
  createKnowledgeItem,
  updateKnowledgeItem,
  deleteKnowledgeItem,
  bulkUpdateKnowledgeStatus,
  sendKnowledgeFeedback,
  fetchVibeMemories,
  deleteVibeMemory,
  fetchAgentDiffEntries,
  fetchDoctorReport,
  fetchOverviewDashboard,
  fetchGraphSnapshot,
  fetchGraphNodeDetail,
  fetchSourceTree,
  fetchSourceHealth,
  fetchSourcePage,
  createSourcePage,
  updateSourcePage,
  deleteSourcePage,
  createSourceFolder,
  renameSourceFolder,
  deleteSourceFolder,
  fetchSourceHistory,
  fetchSourceDiff,
  searchSourcePages,
  runSourceReindex,
  fetchAuditLogs,
  fetchCandidateItems,
} from "../../web/src/modules/admin/repositories/admin.repository.js";

describe("Admin Repository", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("error handling of getJson and requestJson", () => {
    it("getJson should throw error if response is not ok", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
      } as unknown as Response);
      await expect(fetchDoctorReport()).rejects.toThrow("/api/doctor failed: 500");
    });

    it("requestJson should throw custom error payload if response has outcome", async () => {
      const payload = { outcome: "invalid", message: "something wrong" };
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => payload,
      } as unknown as Response);
      await expect(deleteVibeMemory("123")).rejects.toThrow(JSON.stringify(payload));
    });

    it("requestJson should throw simple error message if response json fails or has no outcome", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => {
          throw new Error("not json");
        },
      } as unknown as Response);
      await expect(deleteVibeMemory("123")).rejects.toThrow(
        "DELETE /api/vibe-memory/123 failed: 400",
      );
    });
  });

  describe("knowledge management", () => {
    it("fetchKnowledgeItems default limit", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      } as Response);
      await fetchKnowledgeItems();
      expect(spy).toHaveBeenCalledWith("/api/knowledge?limit=80");
    });

    it("fetchKnowledgeItems with number", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      } as Response);
      await fetchKnowledgeItems(10);
      expect(spy).toHaveBeenCalledWith("/api/knowledge?limit=10");
    });

    it("fetchKnowledgeItems with object", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      } as Response);
      await fetchKnowledgeItems({
        limit: 20,
        page: 2,
        status: "active",
        query: "test",
        sortBy: "title",
        sortDir: "asc",
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/knowledge?limit=20&page=2&status=active&query=test&sortBy=title&sortDir=asc",
      );
    });

    it("createKnowledgeItem", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      const input = {
        type: "rule" as const,
        status: "active",
        scope: "global",
        title: "Rule title",
        body: "Rule body",
        confidence: 0.9,
        importance: 0.8,
      };
      await createKnowledgeItem(input);
      expect(spy).toHaveBeenCalledWith("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });

    it("updateKnowledgeItem", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await updateKnowledgeItem("k-1", { title: "New title" });
      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "New title" }),
      });
    });

    it("deleteKnowledgeItem", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await deleteKnowledgeItem("k-1");
      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });

    it("bulkUpdateKnowledgeStatus with ids", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      const req = { ids: ["k-1"], status: "deprecated" as const };
      await bulkUpdateKnowledgeStatus(req);
      expect(spy).toHaveBeenCalledWith("/api/knowledge/bulk-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    });

    it("sendKnowledgeFeedback", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ feedback: { id: "f-1" } }),
      } as Response);
      const input = { direction: "up" as const, reason: "good" };
      const res = await sendKnowledgeFeedback("k-1", input);
      expect(res).toEqual({ id: "f-1" });
      expect(spy).toHaveBeenCalledWith("/api/knowledge/k-1/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });
  });

  describe("vibe memories", () => {
    it("fetchVibeMemories default", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ memories: [] }),
      } as Response);
      await fetchVibeMemories();
      expect(spy).toHaveBeenCalledWith("/api/vibe-memory?limit=120");
    });

    it("deleteVibeMemory", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await deleteVibeMemory("v-1");
      expect(spy).toHaveBeenCalledWith("/api/vibe-memory/v-1", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });
  });

  describe("agent diffs", () => {
    it("fetchAgentDiffEntries", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ entries: [] }),
      } as Response);
      await fetchAgentDiffEntries(50, {
        id: "d-1",
        vibeMemoryId: "v-1",
        vibeMemoryIds: ["v-1", "v-2"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/agent-diffs?limit=50&id=d-1&vibeMemoryId=v-1&vibeMemoryIds=v-1%2Cv-2",
      );
    });
  });

  describe("doctor and overview", () => {
    it("fetchDoctorReport", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      } as Response);
      const res = await fetchDoctorReport();
      expect(res).toEqual({ status: "ok" });
      expect(spy).toHaveBeenCalledWith("/api/doctor");
    });

    it("fetchOverviewDashboard", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ checkedAt: "now" }),
      } as Response);
      const res = await fetchOverviewDashboard();
      expect(res).toEqual({ checkedAt: "now" });
      expect(spy).toHaveBeenCalledWith("/api/overview");
    });
  });

  describe("graph", () => {
    it("fetchGraphSnapshot with number", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot(500);
      expect(spy).toHaveBeenCalledWith("/api/graph?limit=500");
    });

    it("fetchGraphSnapshot with object", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 100,
        status: "active",
        view: "semantic",
        relationAxes: ["session", "source"],
        minSimilarity: 0.5,
        semanticTopK: 5,
        maxContextEdgesPerNode: 3,
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=100&status=active&view=semantic&relationAxes=session%2Csource&minSimilarity=0.5&semanticTopK=5&maxContextEdgesPerNode=3",
      );
    });

    it("fetchGraphNodeDetail success", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ id: "node-1" }),
      } as Response);
      const res = await fetchGraphNodeDetail("node-1");
      expect(res).toEqual({ id: "node-1" });
      expect(spy).toHaveBeenCalledWith("/api/graph/nodes/node-1");
    });

    it("fetchGraphNodeDetail failure returns null", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
      } as Response);
      const res = await fetchGraphNodeDetail("node-1");
      expect(res).toBeNull();
    });
  });

  describe("sources and pages", () => {
    it("fetchSourceTree", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], folders: [] }),
      } as Response);
      await fetchSourceTree();
      expect(spy).toHaveBeenCalledWith("/api/sources/tree");
    });

    it("fetchSourceHealth", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ app: "test" }),
      } as Response);
      await fetchSourceHealth();
      expect(spy).toHaveBeenCalledWith("/api/sources/health");
    });

    it("fetchSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ slug: "a/b" }),
      } as Response);
      await fetchSourcePage("a/b");
      expect(spy).toHaveBeenCalledWith("/api/sources/pages/a/b");
    });

    it("createSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      const input = { slug: "new-slug", title: "New Page", body: "Hello" };
      await createSourcePage(input);
      expect(spy).toHaveBeenCalledWith("/api/sources/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });

    it("updateSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      const input = { body: "Updated body" };
      await updateSourcePage("a/b", input);
      expect(spy).toHaveBeenCalledWith("/api/sources/pages/a/b", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    });

    it("deleteSourcePage", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await deleteSourcePage("a/b");
      expect(spy).toHaveBeenCalledWith("/api/sources/pages/a/b", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });

    it("createSourceFolder", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await createSourceFolder("folder-a");
      expect(spy).toHaveBeenCalledWith("/api/sources/folders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "folder-a" }),
      });
    });

    it("renameSourceFolder", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await renameSourceFolder("folder-a", "folder-b");
      expect(spy).toHaveBeenCalledWith("/api/sources/folders/folder-a", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "folder-b" }),
      });
    });

    it("deleteSourceFolder", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await deleteSourceFolder("folder-a");
      expect(spy).toHaveBeenCalledWith("/api/sources/folders/folder-a", {
        method: "DELETE",
        headers: undefined,
        body: undefined,
      });
    });

    it("fetchSourceHistory", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ slug: "a", items: [] }),
      } as Response);
      await fetchSourceHistory("a/b");
      expect(spy).toHaveBeenCalledWith("/api/sources/history/a/b");
    });

    it("fetchSourceDiff", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ diff: "diff-content" }),
      } as Response);
      await fetchSourceDiff("a/b", "c1", "c2");
      expect(spy).toHaveBeenCalledWith("/api/sources/diff/a/b?from=c1&to=c2");
    });

    it("searchSourcePages", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await searchSourcePages("query content");
      expect(spy).toHaveBeenCalledWith("/api/sources/search?q=query%20content");
    });

    it("runSourceReindex", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response);
      await runSourceReindex();
      expect(spy).toHaveBeenCalledWith("/api/sources/reindex", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });
  });

  describe("audit logs and candidates", () => {
    it("fetchAuditLogs", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await fetchAuditLogs({ page: 2, limit: 10, eventType: "create", actor: "agent" });
      expect(spy).toHaveBeenCalledWith(
        "/api/audit-logs?page=2&limit=10&eventType=create&actor=agent",
      );
    });

    it("fetchCandidateItems", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await fetchCandidateItems({
        page: 1,
        limit: 20,
        query: "candidate",
        targetKind: "wiki_file",
        outcome: "stored",
        hasKnowledge: "yes",
        targetStateId: "state-1",
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/candidates?page=1&limit=20&query=candidate&targetKind=wiki_file&outcome=stored&hasKnowledge=yes&targetStateId=state-1",
      );
    });
  });
});
