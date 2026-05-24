import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkUpdateKnowledgeStatus,
  createKnowledgeItem,
  createSourceFolder,
  createSourcePage,
  deleteKnowledgeItem,
  deleteSourceFolder,
  deleteSourcePage,
  deleteVibeMemory,
  fetchAgentDiffEntries,
  fetchAuditLogs,
  fetchCandidateItems,
  fetchDoctorReport,
  fetchGraphCommunityLabels,
  fetchLandscapeSnapshot,
  fetchGraphNodeDetail,
  fetchGraphSnapshot,
  fetchKnowledgeItems,
  fetchOverviewDashboard,
  fetchRuntimeSettings,
  fetchSourceDiff,
  fetchSourceHealth,
  fetchSourceHistory,
  fetchSourcePage,
  fetchSourceTree,
  fetchVibeMemories,
  reloadRuntimeSettingsCache,
  renameSourceFolder,
  runSourceReindex,
  searchSourcePages,
  queueWebSourceUrl,
  queueWebSourceUrlsBulk,
  queueWebSourceUrlsUpload,
  sendKnowledgeFeedback,
  testRuntimeProvider,
  updateGraphCommunityLabel,
  updateKnowledgeItem,
  updateRuntimeSettings,
  updateSourcePage,
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

    it("requestJson should prioritize reason/message from error payload", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ reason: "invalid url" }),
      } as unknown as Response);
      await expect(queueWebSourceUrl({ url: "bad" })).rejects.toThrow("invalid url");
    });

    it("requestForm should prioritize reason/message from error payload", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ reason: "no url found in upload file" }),
      } as unknown as Response);
      const file = new File(["not a url"], "urls.csv", { type: "text/csv" });
      await expect(queueWebSourceUrlsUpload({ file })).rejects.toThrow(
        "no url found in upload file",
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

    it("fetchGraphSnapshot with community view", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 80,
        status: "all",
        view: "community",
        relationAxes: ["project", "source"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=80&status=all&view=community&relationAxes=project%2Csource",
      );
    });

    it("fetchGraphSnapshot with community supernode mode", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 60,
        status: "active",
        view: "community",
        communityDisplay: "supernode",
        relationAxes: ["session"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=60&status=active&view=community&communityDisplay=supernode&relationAxes=session",
      );
    });

    it("fetchGraphSnapshot with evidence view and sourceNodeLimit", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ nodes: [], edges: [] }),
      } as Response);
      await fetchGraphSnapshot({
        limit: 120,
        status: "all",
        view: "evidence",
        sourceNodeLimit: 300,
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph?limit=120&status=all&view=evidence&sourceNodeLimit=300",
      );
    });

    it("fetchLandscapeSnapshot default params", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ communities: [] }),
      } as Response);
      await fetchLandscapeSnapshot();
      expect(spy).toHaveBeenCalledWith(
        "/api/graph/landscape?windowDays=30&limit=1000&status=active&format=full&relationAxes=session%2Cproject%2Csource",
      );
    });

    it("fetchLandscapeSnapshot with custom params", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ communities: [] }),
      } as Response);
      await fetchLandscapeSnapshot({
        windowDays: 14,
        limit: 120,
        status: "all",
        relationAxes: ["project", "source"],
        minSelectedCount: 5,
        minFeedbackCount: 7,
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph/landscape?windowDays=14&limit=120&status=all&format=full&relationAxes=project%2Csource&minSelectedCount=5&minFeedbackCount=7",
      );
    });

    it("fetchGraphCommunityLabels", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ labels: [] }),
      } as Response);
      await fetchGraphCommunityLabels({
        limit: 100,
        status: "all",
        relationAxes: ["project", "source"],
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/graph/community-labels?limit=100&status=all&relationAxes=project%2Csource",
      );
    });

    it("updateGraphCommunityLabel", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          label: {
            communityKey: "a".repeat(64),
            label: "Data Quality",
            note: null,
            updatedAt: "2026-05-23T00:00:00.000Z",
          },
        }),
      } as Response);
      await updateGraphCommunityLabel({
        communityKey: "a".repeat(64),
        label: "Data Quality",
      });
      expect(spy).toHaveBeenCalledWith(`/api/graph/community-labels/${"a".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Data Quality", note: "" }),
      });
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

    it("queueWebSourceUrl", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, item: {} }),
      } as Response);
      const payload = { url: "https://example.com/a" };
      await queueWebSourceUrl(payload);
      expect(spy).toHaveBeenCalledWith("/api/sources/web", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });

    it("queueWebSourceUrlsBulk", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          total: 1,
          queued: 1,
          invalid: 0,
          duplicateInRequest: 0,
          items: [],
        }),
      } as Response);
      const payload = { urls: ["https://example.com/a", "https://example.com/b"] };
      await queueWebSourceUrlsBulk(payload);
      expect(spy).toHaveBeenCalledWith("/api/sources/web/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });

    it("queueWebSourceUrlsUpload", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          total: 1,
          queued: 1,
          invalid: 0,
          duplicateInRequest: 0,
          items: [],
          file: { name: "urls.csv", size: 12, extractedUrls: 1 },
        }),
      } as Response);
      const file = new File(["https://example.com/a"], "urls.csv", { type: "text/csv" });
      await queueWebSourceUrlsUpload({ file });
      expect(spy).toHaveBeenCalledWith("/api/sources/web/upload", {
        method: "POST",
        body: expect.any(FormData),
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
        sortBy: "candidateTitle",
        sortDir: "asc",
      });
      expect(spy).toHaveBeenCalledWith(
        "/api/candidates?page=1&limit=20&query=candidate&targetKind=wiki_file&outcome=stored&hasKnowledge=yes&targetStateId=state-1&sortBy=candidateTitle&sortDir=asc",
      );
    });
  });

  describe("settings", () => {
    it("fetchRuntimeSettings", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: {},
          effective: {},
          sources: {},
          revision: 1,
          loadedAt: null,
        }),
      } as Response);
      await fetchRuntimeSettings();
      expect(spy).toHaveBeenCalledWith("/api/settings");
    });

    it("updateRuntimeSettings", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          settings: {},
          effective: {},
          sources: {},
          revision: 2,
          loadedAt: null,
        }),
      } as Response);
      const payload = {
        settings: {
          providers: {
            openai: { enabled: true, apiBaseUrl: "https://api.openai.com/v1", model: "5.4mini" },
            "azure-openai": {
              enabled: false,
              apiBaseUrl: "",
              apiPath: "/openai/deployments",
              apiVersion: "2025-04-01-preview",
              model: "",
            },
            bedrock: {
              enabled: false,
              region: "us-east-1",
              profile: "",
              model: "anthropic.claude-3-5-haiku-20241022-v1:0",
            },
            "local-llm": {
              enabled: true,
              apiBaseUrl: "http://127.0.0.1:44448",
              model: "gemma-4-e4b-it",
            },
          },
          taskRouting: {
            findCandidate: {
              source: { provider: "openai", model: "5.4mini", fallback: [] },
              vibe: { provider: "openai", model: "5.4mini", fallback: [] },
            },
            coverEvidence: {
              sourceSupport: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
              externalEvidence: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
              mcpEvidence: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
            },
            finalizeDistille: { provider: "local-llm", model: "gemma-4-e4b-it", fallback: [] },
            agenticCompile: {
              enabled: true,
              provider: "openai",
              model: "5.4mini",
              fallback: ["local-llm"],
              timeoutMs: 15000,
              maxTokens: 4000,
            },
          },
          search: {
            providerOrder: ["brave", "exa", "duckduckgo"],
            maxProviderAttempts: 2,
            resultCount: 3,
            timeoutMs: 10000,
            rateLimitCooldownSeconds: 3600,
            providers: {
              brave: { enabled: true },
              exa: { enabled: true },
              duckduckgo: { enabled: true },
            },
          },
          embedding: {
            provider: "daemon",
            daemonUrl: "http://127.0.0.1:44512",
            openaiModel: "text-embedding-3-small",
            timeoutMs: 30000,
          },
          distillationRuntime: {
            timeoutMs: 30000,
            candidateTimeoutMs: 15000,
            maxToolRounds: 4,
            toolTimeoutMs: 10000,
            toolResultMaxChars: 12000,
            failureRetryDelaySeconds: 90,
            readerMaxReads: 12,
            readerMaxCharsPerRead: 12000,
            lowImportanceRejectThreshold: 40,
          },
          advanced: {
            pipelineLockStaleSeconds: 1200,
            lockTtlSeconds: 1800,
            continuousIdleSleepMs: 5000,
            continuousErrorSleepMs: 12000,
            inventoryRefreshIntervalMs: 30000,
            doctorFreshnessThresholdMinutes: 720,
            doctorDegradedRateThreshold: 0.5,
            doctorKnowledgeZeroUseWarningMinActiveCount: 10,
          },
        },
      };

      await updateRuntimeSettings(payload as any);
      expect(spy).toHaveBeenCalledWith("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    });

    it("testRuntimeProvider", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ provider: "openai", health: { configured: true, reachable: true } }),
      } as Response);
      await testRuntimeProvider("openai");
      expect(spy).toHaveBeenCalledWith("/api/settings/providers/openai/test", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });

    it("reloadRuntimeSettingsCache", async () => {
      const spy = vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, reloadedAt: "2026-05-23T00:00:00.000Z" }),
      } as Response);
      await reloadRuntimeSettingsCache();
      expect(spy).toHaveBeenCalledWith("/api/settings/reload-runtime-cache", {
        method: "POST",
        headers: undefined,
        body: undefined,
      });
    });
  });
});
