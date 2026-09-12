import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildGraphSnapshot,
  fetchGraphNodeDetail,
  listGraphCommunityLabels,
  upsertGraphCommunityLabel,
} from "../src/modules/graph/graph.repository.js";

const SHARED_SESSION = "session-shared";
const SHARED_SOURCE = "file:///workspace/context-still/shared.md";
const PROJECT_ROOT = "/workspace/context-still";
const LONG_BODY = "Graph node detail preview text. ".repeat(12);

const mocks = vi.hoisted(() => ({
  backendKind: "sqlite" as "sqlite" | "postgres",
  knowledgeRows: [] as any[],
  detailRow: null as any,
  embeddedRows: [] as any[],
  vibeRows: [] as any[],
  communityLabelRows: [] as any[],
  sourceLinkRows: [] as any[],
  evidenceRows: [] as any[],
  insertRun: vi.fn(),
  lastInsertValues: null as any,
  lastConflictUpdate: null as any,
  pgStatsRows: [] as any[],
  pgSourceLinks: [] as any[],
  pgSourceRefCountRows: [{ sourceRefCount: 0 }] as any[],
  pgVibeRows: [] as any[],
  pgCommunityLabels: [] as any[],
  throwCommunityLabels: false,
  executeRows: [] as any[],
  findFirst: vi.fn(async (..._args: unknown[]) => null as any),
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: () =>
    Promise.resolve({
      db: {
        query: (sql: string) => {
          const text = String(sql);
          const all = (...params: string[]) => {
            if (text.includes("knowledge_items_vec_fallback")) return mocks.embeddedRows;
            if (text.includes("vibe_memories")) return mocks.vibeRows;
            if (text.includes("knowledge_community_labels")) {
              return mocks.communityLabelRows.length > 0
                ? mocks.communityLabelRows
                : params.map((community_key) => ({
                    community_key,
                    label: "Named Cluster",
                    note: "sqlite-note",
                    updated_at: "unix-ms:not-a-number",
                  }));
            }
            if (text.includes("knowledge_source_links") && text.includes("group by")) {
              return mocks.evidenceRows;
            }
            if (text.includes("knowledge_source_links")) return mocks.sourceLinkRows;
            return [];
          };
          return {
            all,
            get: (...params: string[]) => {
              const rows = all(...params);
              return Array.isArray(rows) ? (rows[0] ?? null) : rows;
            },
          };
        },
      },
      orm: {
        select: () => ({
          from: () => ({
            all: () => mocks.knowledgeRows,
            where: () => ({
              limit: () => ({
                get: () => mocks.detailRow,
              }),
            }),
          }),
        }),
        insert: () => ({
          values: (input: unknown) => {
            mocks.lastInsertValues = input;
            return {
              onConflictDoUpdate: (conflict: unknown) => {
                mocks.lastConflictUpdate = conflict;
                return { run: (...args: unknown[]) => mocks.insertRun(...args) };
              },
            };
          },
        }),
      },
    }),
}));

const makeChain = (result: unknown) => {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    values: vi.fn((input: unknown) => {
      mocks.lastInsertValues = input;
      return chain;
    }),
    onConflictDoUpdate: vi.fn((conflict: unknown) => {
      mocks.lastConflictUpdate = conflict;
      return chain;
    }),
    then: (onfulfilled: any, onrejected?: any) =>
      Promise.resolve(result).then(onfulfilled, onrejected),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

const makeRejectingChain = (error: Error) => {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    then: (onfulfilled: any, onrejected?: any) =>
      Promise.reject(error).then(onfulfilled, onrejected),
    catch: (onrejected: any) => Promise.reject(error).catch(onrejected),
  };
  return chain;
};

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (columns?: Record<string, unknown>) => {
      const keys = new Set(Object.keys(columns ?? {}));
      if (mocks.throwCommunityLabels && keys.has("communityKey") && keys.has("note")) {
        return makeRejectingChain(new Error("knowledge_community_labels missing"));
      }
      if (keys.has("embedded") || (keys.has("title") && keys.has("appliesTo"))) {
        return makeChain(mocks.knowledgeRows);
      }
      if (keys.has("totalKnowledgeCount")) return makeChain(mocks.pgStatsRows);
      if (keys.has("knowledgeId") && keys.has("sourceId")) return makeChain(mocks.pgSourceLinks);
      if (keys.has("sourceRefCount")) return makeChain(mocks.pgSourceRefCountRows);
      if (keys.has("sessionId")) return makeChain(mocks.pgVibeRows);
      if (keys.has("communityKey")) return makeChain(mocks.pgCommunityLabels);
      return makeChain([]);
    },
    insert: () => makeChain(undefined),
    execute: vi.fn(async () => ({ rows: mocks.executeRows })),
    query: {
      knowledgeItems: {
        findFirst: (...args: unknown[]) => mocks.findFirst(...args),
      },
    },
  },
}));

function communityKeyFor(ids: string[]): string {
  return createHash("sha256")
    .update([...ids].sort().join(","))
    .digest("hex");
}

function skippedSourceMetadata(extra: Record<string, unknown> = {}) {
  return {
    sourceRefs: ["cover-evidence-result://skip-me", "agent://skip-me", SHARED_SOURCE],
    candidateSourceRefs: ["file:///workspace/context-still/candidate.md"],
    sourceDocumentUri: "file:///workspace/context-still/doc.md",
    sourceUri: "file:///workspace/context-still/uri.md",
    references: [
      { uri: "file:///workspace/context-still/ref.md#L10" },
      { uri: "cover-evidence-result://nested" },
    ],
    coverEvidenceResultId: "cover-shared",
    ...extra,
  };
}

function sqliteFixtureRows() {
  return [
    {
      id: "k1",
      title: "Alpha",
      type: "rule",
      status: "active",
      scope: "repo",
      importance: 90,
      compileSelectCount: 2,
      lastVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      appliesTo: {},
      metadata: skippedSourceMetadata({ sourceSessionId: SHARED_SESSION }),
      confidence: 80,
      body: "alpha body",
    },
    {
      id: "k2",
      title: "Beta",
      type: "procedure",
      status: "active",
      scope: "global",
      importance: 80,
      compileSelectCount: "1",
      lastVerifiedAt: null,
      updatedAt: "2026-08-01 12:30:00",
      appliesTo: [],
      metadata: skippedSourceMetadata({ sessionId: SHARED_SESSION }),
      confidence: 70,
      body: "beta body",
    },
    {
      id: "k3",
      title: "Gamma",
      type: "rule",
      status: "active",
      scope: "repo",
      importance: 0.7,
      compileSelectCount: 0,
      lastVerifiedAt: "unix-ms:not-a-number",
      updatedAt: "unix-ms:1750000000000",
      appliesTo: "{not-json",
      metadata: JSON.stringify(
        skippedSourceMetadata({
          sourceSessionId: SHARED_SESSION,
          coverEvidenceResultId: "cover-3",
        }),
      ),
      confidence: 60,
      body: "gamma body",
    },
    {
      id: "p1",
      title: "Project One",
      type: "rule",
      status: "active",
      scope: "repo",
      importance: 40,
      compileSelectCount: 0,
      lastVerifiedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      appliesTo: { repoKey: "other-project" },
      metadata: { coverEvidenceResultId: "cover-p1" },
      confidence: 50,
      body: "project one",
    },
    {
      id: "p2",
      title: "Project Two",
      type: "procedure",
      status: "active",
      scope: "repo",
      importance: 30,
      compileSelectCount: 0,
      lastVerifiedAt: "2020-01-02T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
      appliesTo: { repoKey: "other-project" },
      metadata: JSON.stringify({ coverEvidenceResultId: "cover-p2", repoKey: "other-project" }),
      confidence: 40,
      body: "project two",
    },
    {
      id: "inv1",
      title: "Invalid timestamps",
      type: "rule",
      status: "active",
      scope: "repo",
      importance: 5,
      compileSelectCount: Number.NaN,
      lastVerifiedAt: new Date(Number.NaN),
      updatedAt: "totally-invalid",
      appliesTo: { repoPath: "/workspace/orphan" },
      metadata: "{oops",
      confidence: Number.NaN,
      body: "invalid",
    },
    {
      id: "d1",
      title: "Draft item",
      type: "rule",
      status: "draft",
      scope: "repo",
      importance: 20,
      compileSelectCount: 0,
      lastVerifiedAt: "unix-ms:1735689600000",
      updatedAt: "2026-02-02 08:00:00.123",
      appliesTo: "{}",
      metadata: { sourceProject: "draft-project" },
      confidence: 30,
      body: "draft",
    },
    {
      id: "dep1",
      title: "Deprecated item",
      type: "rule",
      status: "deprecated",
      scope: "repo",
      importance: 99,
      compileSelectCount: 9,
      lastVerifiedAt: null,
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      appliesTo: {},
      metadata: {},
      confidence: 10,
      body: "deprecated",
    },
  ];
}

function asPgDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value == null) return null;
  if (typeof value !== "string") return null;
  if (value.startsWith("unix-ms:")) {
    const millis = Number(value.slice("unix-ms:".length));
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value.trim())
    ? `${value.trim().replace(" ", "T")}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function postgresFixtureRows() {
  return sqliteFixtureRows().map((row) => ({
    ...row,
    embedded: row.id === "k1" || row.id === "k3",
    lastVerifiedAt: asPgDate(row.lastVerifiedAt),
    updatedAt: asPgDate(row.updatedAt) ?? new Date(0),
    compileSelectCount: Number.isFinite(Number(row.compileSelectCount))
      ? Number(row.compileSelectCount)
      : 0,
  }));
}

function seedSqliteGraph() {
  mocks.knowledgeRows = sqliteFixtureRows();
  mocks.embeddedRows = [{ knowledge_id: "k1" }, { knowledge_id: "k3" }];
  mocks.vibeRows = [
    { session_id: SHARED_SESSION, metadata: JSON.stringify({ projectRoot: PROJECT_ROOT }) },
    { session_id: SHARED_SESSION, metadata: JSON.stringify({ projectRoot: "/workspace/ignored" }) },
    { session_id: "no-project", metadata: "not-json" },
  ];
  mocks.sourceLinkRows = [
    { knowledge_id: "k1", source_id: "src-db" },
    { knowledge_id: "k2", source_id: "src-db" },
    { knowledge_id: "k3", source_id: "src-db" },
  ];
  mocks.evidenceRows = [
    {
      knowledge_id: "k1",
      source_id: "src-1",
      source_kind: "file",
      source_uri: "file:///a.md",
      source_title: "Alpha Source",
      link_count: 3,
    },
    {
      knowledge_id: "k2",
      source_id: "src-1",
      source_kind: "file",
      source_uri: "file:///a.md",
      source_title: "Alpha Source",
      link_count: "2",
    },
    {
      knowledge_id: "k1",
      source_id: "src-2",
      source_kind: "web",
      source_uri: "https://example.test/b",
      source_title: "  ",
      link_count: 1,
    },
    {
      knowledge_id: "k3",
      source_id: "src-2",
      source_kind: "web",
      source_uri: "https://example.test/b",
      source_title: null,
      link_count: 1,
    },
  ];
  mocks.communityLabelRows = [];
}

function seedPostgresGraph() {
  mocks.knowledgeRows = postgresFixtureRows();
  mocks.pgStatsRows = [{ totalKnowledgeCount: 8, embeddedKnowledgeCount: 2 }];
  mocks.pgSourceLinks = [
    { knowledgeId: "k1", sourceId: "src-db" },
    { knowledgeId: "k2", sourceId: "src-db" },
    { knowledgeId: "k3", sourceId: "src-db" },
  ];
  mocks.pgSourceRefCountRows = [{ sourceRefCount: 6 }];
  mocks.pgVibeRows = [
    { sessionId: SHARED_SESSION, metadata: { projectRoot: PROJECT_ROOT } },
    { sessionId: SHARED_SESSION, metadata: { projectRoot: "/workspace/ignored" } },
    { sessionId: "no-project", metadata: "{oops" },
  ];
  mocks.pgCommunityLabels = [
    {
      communityKey: communityKeyFor(["k1", "k2", "k3"]),
      label: "PG Cluster",
      note: "pg-note",
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  ];
  mocks.executeRows = [
    {
      knowledge_id: "k1",
      source_id: "src-1",
      source_kind: "file",
      source_uri: "file:///a.md",
      source_title: "Alpha Source",
      link_count: 3,
    },
    {
      knowledge_id: "k2",
      source_id: "src-1",
      source_kind: "file",
      source_uri: "file:///a.md",
      source_title: "Alpha Source",
      link_count: "2",
    },
    {
      knowledge_id: "k1",
      source_id: "src-2",
      source_kind: "web",
      source_uri: "https://example.test/b",
      source_title: null,
      link_count: 1,
    },
  ];
}

describe("graph.repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backendKind = "sqlite";
    mocks.knowledgeRows = [];
    mocks.detailRow = null;
    mocks.embeddedRows = [];
    mocks.vibeRows = [];
    mocks.communityLabelRows = [];
    mocks.sourceLinkRows = [];
    mocks.evidenceRows = [];
    mocks.lastInsertValues = null;
    mocks.lastConflictUpdate = null;
    mocks.pgStatsRows = [{ totalKnowledgeCount: 0, embeddedKnowledgeCount: 0 }];
    mocks.pgSourceLinks = [];
    mocks.pgSourceRefCountRows = [{ sourceRefCount: 0 }];
    mocks.pgVibeRows = [];
    mocks.pgCommunityLabels = [];
    mocks.throwCommunityLabels = false;
    mocks.executeRows = [];
    mocks.findFirst.mockImplementation(async () => mocks.detailRow);
  });

  describe("sqlite", () => {
    beforeEach(() => {
      mocks.backendKind = "sqlite";
      seedSqliteGraph();
    });

    test("buildGraphSnapshot returns empty collections for empty input", async () => {
      mocks.knowledgeRows = [];
      const snapshot = await buildGraphSnapshot({ limit: 10, status: "all" });
      expect(snapshot.nodes).toEqual([]);
      expect(snapshot.edges).toEqual([]);
      expect(snapshot.communities).toEqual([]);
      expect(snapshot.stats.visibleKnowledgeCount).toBe(0);
      expect(snapshot.stats.sessionEdgeCount).toBe(0);
    });

    test("relation view links shared session/project/source and skips cover/agent refs", async () => {
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        status: "current",
        view: "relation",
      });
      const sharedIds = new Set(["knowledge:k1", "knowledge:k2", "knowledge:k3"]);
      const sessionEdges = snapshot.edges.filter((edge) => edge.edgeKind === "session");
      expect(sessionEdges.length).toBeGreaterThan(0);
      expect(sessionEdges.every((edge) => edge.weight === 0.85)).toBe(true);
      expect(
        sessionEdges.every((edge) => sharedIds.has(edge.source) && sharedIds.has(edge.target)),
      ).toBe(true);
      expect(snapshot.nodes.some((node) => node.id === "knowledge:k1" && node.embedded)).toBe(true);
      expect(snapshot.nodes.some((node) => node.id === "knowledge:dep1")).toBe(false);
      expect(snapshot.stats.sourceRefCount).toBeGreaterThan(0);
      expect(snapshot.stats.relationEdgeCount).toBe(snapshot.edges.length);

      const sourceOnly = await buildGraphSnapshot({
        limit: 20,
        view: "relation",
        relationAxes: ["source"],
        status: "current",
      });
      expect(sourceOnly.edges.some((edge) => edge.edgeKind === "source")).toBe(true);

      const defaultAxes = await buildGraphSnapshot({
        limit: 20,
        view: "relation",
        relationAxes: [],
        status: "current",
      });
      expect(defaultAxes.edges.some((edge) => edge.edgeKind === "session")).toBe(true);
    });

    test("applies status filters including all, draft, deprecated, and active", async () => {
      const current = await buildGraphSnapshot({ limit: 30, status: "current" });
      expect(
        current.nodes.every((node) => node.status === "active" || node.status === "draft"),
      ).toBe(true);
      const active = await buildGraphSnapshot({ limit: 30, status: "active" });
      expect(active.nodes.every((node) => node.status === "active")).toBe(true);
      const draft = await buildGraphSnapshot({ limit: 30, status: "draft" });
      expect(draft.nodes.map((node) => node.id)).toEqual(["knowledge:d1"]);
      const deprecated = await buildGraphSnapshot({ limit: 30, status: "deprecated" });
      expect(deprecated.nodes.map((node) => node.id)).toEqual(["knowledge:dep1"]);
      const all = await buildGraphSnapshot({ limit: 30, status: "all" });
      expect(all.nodes.some((node) => node.id === "knowledge:dep1")).toBe(true);
      expect(all.nodes.some((node) => node.id === "knowledge:inv1")).toBe(true);
    });

    test("invalid timestamps still produce nodes and a single-item snapshot has no relation edges", async () => {
      const snapshot = await buildGraphSnapshot({ limit: 30, status: "active", view: "relation" });
      expect(snapshot.nodes.some((node) => node.id === "knowledge:inv1")).toBe(true);
      mocks.knowledgeRows = sqliteFixtureRows().filter((row) => row.id === "k1");
      const single = await buildGraphSnapshot({ limit: 5, view: "relation" });
      expect(single.nodes).toHaveLength(1);
      expect(single.edges).toEqual([]);
    });

    test("semantic view keeps knowledge nodes and does not emit relation edges", async () => {
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "semantic",
        status: "current",
      });
      expect(snapshot.nodes.length).toBeGreaterThan(0);
      expect(snapshot.edges).toEqual([]);
      expect(snapshot.stats.semanticEdgeCount).toBe(0);
      expect(snapshot.stats.relationEdgeCount).toBe(0);
    });

    test("evidence view builds source nodes, evidence edges, and truncation stats", async () => {
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "evidence",
        status: "current",
        sourceNodeLimit: 1,
      });
      const sourceNodes = snapshot.nodes.filter((node) => node.kind === "source");
      expect(sourceNodes).toHaveLength(1);
      expect(sourceNodes[0]?.id).toBe("source:src-1");
      expect(snapshot.edges.every((edge) => edge.edgeKind === "evidence")).toBe(true);
      expect(snapshot.edges.some((edge) => edge.id === "evidence:k1:src-1")).toBe(true);
      expect(snapshot.stats.truncatedSourceNodeCount).toBe(1);
      expect(snapshot.stats.evidenceEdgeCount).toBe(snapshot.edges.length);
      expect(snapshot.stats.sourceNodeCount).toBe(1);
    });

    test("community view assigns labels, health, supernodes, and listGraphCommunityLabels", async () => {
      const sharedKey = communityKeyFor(["k1", "k2", "k3"]);
      mocks.communityLabelRows = [
        {
          community_key: sharedKey,
          label: "Named Cluster",
          note: "sqlite-note",
          updated_at: "2026-09-01 00:00:00",
        },
      ];
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "community",
        status: "current",
      });
      const sharedNodes = snapshot.nodes.filter((node) =>
        ["knowledge:k1", "knowledge:k2", "knowledge:k3"].includes(node.id),
      );
      expect(sharedNodes.length).toBe(3);
      expect(new Set(sharedNodes.map((node) => node.communityId)).size).toBe(1);
      expect(sharedNodes[0]?.communityLabel).toBe("Named Cluster");
      expect(
        snapshot.communities.some((community) => community.communityLabel === "Named Cluster"),
      ).toBe(true);
      expect(snapshot.communities.some((community) => community.health.dead)).toBe(true);
      expect(snapshot.supernodes.length).toBe(snapshot.stats.communityCount);
      expect(snapshot.stats.orphanNodeCount).toBeGreaterThanOrEqual(1);

      const labels = await listGraphCommunityLabels({ limit: 20, status: "current" });
      expect(labels.some((label) => label.communityLabel === "Named Cluster")).toBe(true);
      expect(labels[0]?.size).toBeGreaterThanOrEqual(2);

      const oneItemLabels = await listGraphCommunityLabels({ limit: 0, status: "current" });
      expect(oneItemLabels.length).toBeGreaterThanOrEqual(1);
    });

    test("upsertGraphCommunityLabel writes sqlite conflict update and trims input", async () => {
      const saved = await upsertGraphCommunityLabel({
        communityKey: "  MixED-Key  ",
        label: "  Display  ",
        note: "  keep me  ",
      });
      expect(saved).toMatchObject({
        communityKey: "mixed-key",
        label: "Display",
        note: "keep me",
      });
      expect(saved.updatedAt).toBeInstanceOf(Date);
      expect(mocks.insertRun).toHaveBeenCalled();
      expect(mocks.lastInsertValues).toMatchObject({
        communityKey: "mixed-key",
        label: "Display",
        note: "keep me",
      });
      expect(mocks.lastConflictUpdate).toBeTruthy();

      const blankNote = await upsertGraphCommunityLabel({
        communityKey: "abc",
        label: "L",
        note: "   ",
      });
      expect(blankNote.note).toBeNull();
    });

    test("fetchGraphNodeDetail returns mapped detail, truncates body, and yields null", async () => {
      mocks.detailRow = {
        id: "k1",
        title: "Alpha",
        body: LONG_BODY,
        type: "rule",
        status: "active",
        confidence: 0.8,
        importance: 90,
      };
      const detail = await fetchGraphNodeDetail("k1");
      expect(detail).toMatchObject({
        id: "knowledge:k1",
        label: "Alpha",
        kind: "knowledge",
        group: "rule",
        detail: "rule / active",
        status: "active",
      });
      expect(detail?.bodyPreview.endsWith("...")).toBe(true);
      expect(detail?.bodyPreview.length).toBe(220);
      expect(detail?.confidence).toBe(80);

      mocks.detailRow = null;
      await expect(fetchGraphNodeDetail("missing")).resolves.toBeNull();
    });
  });

  describe("postgres", () => {
    beforeEach(() => {
      mocks.backendKind = "postgres";
      seedPostgresGraph();
    });

    test("buildGraphSnapshot returns empty collections for empty input", async () => {
      mocks.knowledgeRows = [];
      mocks.pgStatsRows = [{ totalKnowledgeCount: 0, embeddedKnowledgeCount: 0 }];
      const snapshot = await buildGraphSnapshot({ limit: 10, status: "all" });
      expect(snapshot.nodes).toEqual([]);
      expect(snapshot.edges).toEqual([]);
      expect(snapshot.stats.totalKnowledgeCount).toBe(0);
      expect(snapshot.stats.sourceRefCount).toBe(0);
    });

    test("relation view uses session lookup and forms session edges at 0.85", async () => {
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "relation",
        status: "current",
        relationAxes: ["session", "project", "source"],
      });
      const sessionEdges = snapshot.edges.filter((edge) => edge.edgeKind === "session");
      expect(sessionEdges.length).toBeGreaterThan(0);
      expect(sessionEdges.every((edge) => edge.weight === 0.85 && edge.derived)).toBe(true);
      expect(snapshot.stats.sessionEdgeCount).toBe(sessionEdges.length);

      const sessionOnly = await buildGraphSnapshot({
        limit: 20,
        view: "relation",
        relationAxes: ["session"],
        status: "current",
      });
      expect(sessionOnly.edges.every((edge) => edge.edgeKind === "session")).toBe(true);

      const projectOnly = await buildGraphSnapshot({
        limit: 20,
        view: "relation",
        relationAxes: ["project"],
        status: "current",
      });
      expect(projectOnly.edges.some((edge) => edge.edgeKind === "project")).toBe(true);

      const sourceOnly = await buildGraphSnapshot({
        limit: 20,
        view: "relation",
        relationAxes: ["source"],
        status: "current",
      });
      expect(sourceOnly.edges.some((edge) => edge.edgeKind === "source")).toBe(true);
    });

    test("status filters reach resolveStatusFilter branches without throwing", async () => {
      for (const status of ["current", "active", "draft", "deprecated", "all"] as const) {
        const snapshot = await buildGraphSnapshot({ limit: 5, status, view: "relation" });
        expect(snapshot.stats.visibleKnowledgeCount).toBeGreaterThanOrEqual(0);
      }
    });

    test("semantic view execute applies topK and invalid similarity fallback", async () => {
      mocks.executeRows = [
        { source_id: "k1", target_id: "k2", similarity: 0.95 },
        { source_id: "k1", target_id: "k3", similarity: 0.91 },
        { source_id: "k2", target_id: "k3", similarity: "0.88" },
        { source_id: "k1", target_id: "inv1", similarity: "nope" },
      ];
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "semantic",
        minSimilarity: 0.72,
        semanticTopK: 1,
        status: "current",
      });
      expect(snapshot.edges.every((edge) => edge.edgeKind === "semantic")).toBe(true);
      expect(snapshot.edges).toHaveLength(1);
      expect(snapshot.edges[0]).toMatchObject({
        source: "knowledge:k1",
        target: "knowledge:k2",
        weight: 0.95,
        relationType: "semantic_near",
      });
      expect(snapshot.stats.semanticEdgeCount).toBe(1);
      expect(snapshot.stats.relationEdgeCount).toBe(0);
    });

    test("evidence view execute builds source nodes and unlinked counts", async () => {
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "evidence",
        status: "current",
        sourceNodeLimit: 1,
      });
      expect(
        snapshot.nodes.some((node) => node.kind === "source" && node.sourceId === "src-1"),
      ).toBe(true);
      expect(snapshot.edges.every((edge) => edge.edgeKind === "evidence")).toBe(true);
      expect(snapshot.stats.truncatedSourceNodeCount).toBeGreaterThanOrEqual(1);
      expect(snapshot.stats.evidenceLinkedKnowledgeCount).toBeGreaterThan(0);
      expect(snapshot.stats.evidenceUnlinkedKnowledgeCount).toBeGreaterThanOrEqual(0);
    });

    test("community labels attach from select and thrown select yields empty label map", async () => {
      const snapshot = await buildGraphSnapshot({
        limit: 20,
        view: "community",
        status: "current",
      });
      expect(
        snapshot.communities.some((community) => community.communityLabel === "PG Cluster"),
      ).toBe(true);
      expect(snapshot.communities.some((community) => community.note === "pg-note")).toBe(true);
      expect(snapshot.supernodes.length).toBe(snapshot.stats.communityCount);
      const labels = await listGraphCommunityLabels({ limit: 20, status: "current" });
      expect(labels.some((label) => label.communityLabel === "PG Cluster")).toBe(true);

      mocks.throwCommunityLabels = true;
      const unlabeled = await buildGraphSnapshot({
        limit: 20,
        view: "community",
        status: "current",
      });
      expect(unlabeled.communities.length).toBeGreaterThan(0);
      expect(
        unlabeled.communities.every((community) =>
          community.communityLabel.startsWith("community:"),
        ),
      ).toBe(true);
      expect(unlabeled.communities.every((community) => community.note === undefined)).toBe(true);
    });

    test("upsertGraphCommunityLabel uses insert then select, including missing-row fallback", async () => {
      mocks.pgCommunityLabels = [
        {
          communityKey: "saved-key",
          label: "From DB",
          note: "db-note",
          updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ];
      const saved = await upsertGraphCommunityLabel({
        communityKey: "Saved-Key",
        label: "From DB",
        note: "db-note",
      });
      expect(saved).toMatchObject({
        communityKey: "saved-key",
        label: "From DB",
        note: "db-note",
      });
      expect(saved.updatedAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
      expect(mocks.lastInsertValues).toMatchObject({ communityKey: "saved-key", label: "From DB" });

      mocks.pgCommunityLabels = [];
      const fallback = await upsertGraphCommunityLabel({
        communityKey: "missing",
        label: "Fallback",
      });
      expect(fallback).toMatchObject({
        communityKey: "missing",
        label: "Fallback",
        note: null,
      });
      expect(fallback.updatedAt).toBeInstanceOf(Date);
    });

    test("fetchGraphNodeDetail maps found rows and returns null", async () => {
      mocks.detailRow = {
        id: "k2",
        title: "Beta",
        body: "short body",
        type: "procedure",
        status: "active",
        confidence: 70,
        importance: 80,
      };
      const detail = await fetchGraphNodeDetail("k2");
      expect(detail).toMatchObject({
        id: "knowledge:k2",
        label: "Beta",
        kind: "knowledge",
        group: "procedure",
        detail: "procedure / active",
        bodyPreview: "short body",
        embedded: false,
      });
      expect(mocks.findFirst).toHaveBeenCalled();

      mocks.detailRow = null;
      await expect(fetchGraphNodeDetail("missing")).resolves.toBeNull();
    });
  });
});
