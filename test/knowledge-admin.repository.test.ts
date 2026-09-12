import { beforeEach, describe, expect, test, vi } from "vitest";
import { SqliteCoreRepository } from "../src/db/sqlite/core-repository.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  assertAuditedStoredProjectScopedIdentityCompatible,
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../src/modules/context-compiler/project-scoped-write.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import {
  bulkUpdateKnowledgeStatus,
  countKnowledgeItems,
  createKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeTagDefinitionsForApi,
  recordKnowledgeFeedback,
  updateKnowledgeItem,
} from "../src/modules/knowledge/knowledge-admin.repository.js";
import { listKnowledgeTagDefinitions } from "../src/modules/knowledge/knowledge-tags.repository.js";
import { linkKnowledgeFromMetadata } from "../src/modules/knowledge/source-linking.service.js";

const hoisted = vi.hoisted(() => {
  const backend = { kind: "postgres" as "postgres" | "sqlite" };
  const sqliteAll = vi.fn((..._args: any[]) => [] as any[]);
  const sqliteGet = vi.fn((..._args: any[]) => null as any);
  const sqliteRun = vi.fn();
  const sqliteQueryGet = vi.fn((..._args: any[]): { count: number } | undefined => ({ count: 0 }));
  const sqliteQueryRun = vi.fn();
  const sqliteQuery = vi.fn((..._args: any[]) => ({
    get: (...args: any[]) => sqliteQueryGet(...args),
    run: (...args: any[]) => sqliteQueryRun(...args),
  }));
  const sqliteOrm: any = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
    all: (...args: any[]) => sqliteAll(...args),
    get: (...args: any[]) => sqliteGet(...args),
    run: (...args: any[]) => sqliteRun(...args),
  };
  for (const key of [
    "select",
    "from",
    "where",
    "limit",
    "update",
    "set",
    "delete",
    "insert",
    "values",
  ]) {
    sqliteOrm[key].mockImplementation(() => sqliteOrm);
  }
  const upsertKnowledgeItem = vi.fn();
  const mockSelect = vi.fn();
  const mockInsert = vi.fn();
  const mockUpdate = vi.fn();
  const mockDelete = vi.fn();
  return {
    backend,
    sqliteAll,
    sqliteGet,
    sqliteRun,
    sqliteQuery,
    sqliteQueryGet,
    sqliteQueryRun,
    sqliteOrm,
    upsertKnowledgeItem,
    mockSelect,
    mockInsert,
    mockUpdate,
    mockDelete,
  };
});

function makeChain(result: unknown) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    offset: vi.fn(() => chain),
    set: vi.fn(() => chain),
    values: vi.fn(() => chain),
    returning: vi.fn(() => chain),
    then: (onfulfilled: any, onrejected?: any) =>
      Promise.resolve(result).then(onfulfilled, onrejected),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
}

function makeRejectingChain(error: unknown) {
  const chain = makeChain(undefined);
  chain.then = (onfulfilled: any, onrejected?: any) =>
    Promise.reject(error).then(onfulfilled, onrejected);
  return chain;
}

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: vi.fn(() => ({ kind: hoisted.backend.kind })),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => hoisted.mockSelect(...args),
    insert: (...args: any[]) => hoisted.mockInsert(...args),
    update: (...args: any[]) => hoisted.mockUpdate(...args),
    delete: (...args: any[]) => hoisted.mockDelete(...args),
  },
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: vi.fn(() =>
    Promise.resolve({
      db: { query: (...args: any[]) => hoisted.sqliteQuery(...args) },
      orm: hoisted.sqliteOrm,
      path: "/dummy/sqlite.db",
    }),
  ),
}));

vi.mock("../src/db/sqlite/core-repository.js", () => ({
  SqliteCoreRepository: class {
    upsertKnowledgeItem = hoisted.upsertKnowledgeItem;
  },
}));

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    knowledgeCreated: "KNOWLEDGE_CREATED",
    knowledgeUpdated: "KNOWLEDGE_UPDATED",
    knowledgeDeleted: "KNOWLEDGE_DELETED",
    knowledgeStatusChanged: "KNOWLEDGE_STATUS_CHANGED",
    knowledgeFeedbackRecorded: "KNOWLEDGE_FEEDBACK_RECORDED",
  },
  recordAuditLogSafe: vi.fn(async () => undefined),
}));

vi.mock("../src/modules/context-compiler/project-scoped-write.js", () => ({
  resolveAuditedProjectScopedWriteIdentity: vi.fn(async (input: any) => ({
    contractVersion: 1 as const,
    classificationStatus: "classified",
    scope: input.scope,
    scopeMode: input.scope === "global" ? "global_only" : "project",
    projectRef: input.projectRef ?? "proj",
    repoKey: input.repoKey ?? "repo-key",
    repoPath: input.repoPath ?? "/repo",
    matchBasis: "repo_key",
    identityFingerprint: "fp",
    bindingStatus: "verified",
  })),
  assertAuditedStoredProjectScopedIdentityCompatible: vi.fn(async () => undefined),
  recordProjectScopedWritePersisted: vi.fn(async () => undefined),
}));

vi.mock("../src/modules/knowledge/source-linking.service.js", () => ({
  linkKnowledgeFromMetadata: vi.fn(async () => undefined),
}));

vi.mock("../src/modules/knowledge/knowledge-tags.repository.js", () => ({
  listKnowledgeTagDefinitions: vi.fn(async () => [
    {
      id: "tag-1",
      kind: "technology",
      slug: "typescript",
      label: "TypeScript",
      description: "lang",
      aliases: ["ts"],
      status: "active",
      sortOrder: 10,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ]),
}));

const identity = {
  contractVersion: 1 as const,
  classificationStatus: "classified" as const,
  scope: "repo" as const,
  scopeMode: "project" as const,
  projectRef: "proj",
  repoKey: "repo-key",
  repoPath: "/repo",
  matchBasis: "repo_key" as const,
  identityFingerprint: "fp",
  bindingStatus: "verified" as const,
};

function sqliteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "k-active",
    type: "rule",
    status: "active",
    scope: "repo",
    classificationStatus: "classified",
    projectRef: "proj",
    repoKey: "repo-key",
    repoPath: "/repo",
    polarity: "positive",
    intentTags: ["release"],
    title: "Active rule",
    body: "Keep sqlite tests local",
    appliesTo: { repoKey: "repo-key" },
    confidence: 70,
    importance: 90,
    compileSelectCount: 2,
    lastCompiledAt: "2026-01-03T00:00:00.000Z",
    agenticAcceptCount: 1,
    explicitUpvoteCount: 1,
    explicitDownvoteCount: 0,
    dynamicScore: 12,
    metadata: {
      sourceRefs: ["file:///a.md#L1"],
      sourceUri: "vibe-memory://vm-1",
    },
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-04T00:00:00.000Z",
    lastVerifiedAt: "unix-ms:1735689600000",
    ...overrides,
  };
}

function postgresRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-02-01T00:00:00.000Z");
  return {
    id: "pg-1",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: "positive",
    intentTags: ["ops"],
    title: "Postgres rule",
    body: "Use drizzle chains",
    appliesTo: { technologies: ["postgres"] },
    metadata: { sourceUri: "file:///pg.md" },
    confidence: 0.8,
    importance: 85,
    compileSelectCount: 4,
    lastCompiledAt: now,
    agenticAcceptCount: 2,
    explicitUpvoteCount: 1,
    explicitDownvoteCount: 0,
    dynamicScore: 18,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    classificationStatus: "classified",
    projectRef: "proj",
    repoKey: "repo-key",
    repoPath: "/repo",
    ...overrides,
  };
}

const createInput = {
  type: "rule",
  status: "draft",
  scope: "repo" as const,
  title: "New knowledge",
  body: "Created from admin api",
  confidence: 70,
  importance: 80,
  projectRef: "proj",
  repoKey: "repo-key",
  repoPath: "/repo",
  metadata: { sourceUri: "file:///new.md" },
};

describe("knowledge-admin.repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.backend.kind = "postgres";
    hoisted.sqliteAll.mockReturnValue([]);
    hoisted.sqliteGet.mockReturnValue(null);
    hoisted.sqliteQueryGet.mockReturnValue({ count: 0 });
    hoisted.mockSelect.mockImplementation(() => makeChain([]));
    hoisted.mockInsert.mockImplementation(() => makeChain([]));
    hoisted.mockUpdate.mockImplementation(() => makeChain([]));
    hoisted.mockDelete.mockImplementation(() => makeChain([]));
    vi.mocked(embedOne).mockResolvedValue([0.1, 0.2, 0.3]);
    vi.mocked(resolveAuditedProjectScopedWriteIdentity).mockImplementation(async (input: any) => ({
      ...identity,
      scope: input.scope,
      projectRef: input.projectRef ?? identity.projectRef,
      repoKey: input.repoKey ?? identity.repoKey,
      repoPath: input.repoPath ?? identity.repoPath,
    }));
  });

  describe("countKnowledgeItems / listKnowledgeItems sqlite", () => {
    const rows = [
      sqliteRow({
        id: "draft-rule",
        status: "draft",
        title: "Alpha draft",
        body: "hello",
        importance: 50,
        confidence: 50,
        compileSelectCount: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      sqliteRow({
        id: "active-rule",
        status: "active",
        title: "Beta sqlite-query",
        body: "world",
        importance: 90,
        confidence: 40,
        compileSelectCount: 2,
        updatedAt: "2026-01-04T00:00:00.000Z",
      }),
      sqliteRow({
        id: "active-unused",
        status: "active",
        type: "procedure",
        title: "Gamma unused",
        body: "unused",
        importance: 30,
        confidence: 30,
        compileSelectCount: 0,
        updatedAt: "2026-01-03T00:00:00.000Z",
      }),
      sqliteRow({
        id: "deprecated-rule",
        status: "deprecated",
        title: "Delta old",
        body: "old",
        importance: 85,
        confidence: 85,
        compileSelectCount: 1,
        metadata: { secret: "needle" },
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ];

    beforeEach(() => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteAll.mockReturnValue(rows);
    });

    test("filters by status, type, displayFilter, query, minQuality and paginates", async () => {
      expect(await countKnowledgeItems({})).toBe(4);
      expect(await countKnowledgeItems({ status: "all", type: "all" })).toBe(4);
      expect(await countKnowledgeItems({ status: "  all  ", type: "  all  " })).toBe(4);
      expect(await countKnowledgeItems({ status: "active" })).toBe(2);
      expect(await countKnowledgeItems({ type: "procedure" })).toBe(1);
      expect(await countKnowledgeItems({ displayFilter: "draft" })).toBe(1);
      expect(await countKnowledgeItems({ displayFilter: "active" })).toBe(2);
      expect(await countKnowledgeItems({ displayFilter: "deprecated" })).toBe(1);
      expect(await countKnowledgeItems({ displayFilter: "unused-active" })).toBe(1);
      expect(await countKnowledgeItems({ displayFilter: "high-value" })).toBe(2);
      expect(await countKnowledgeItems({ minQuality: 80 })).toBe(2);
      expect(await countKnowledgeItems({ query: " sqlite-query " })).toBe(1);
      expect(await countKnowledgeItems({ query: "needle" })).toBe(1);
      expect(await countKnowledgeItems({ query: "missing" })).toBe(0);

      const page = await listKnowledgeItems({
        limit: 1,
        page: 2,
        sortBy: "title",
        sortDir: "asc",
      });
      expect(page.map((item) => item.id)).toEqual(["active-rule"]);

      const firstPage = await listKnowledgeItems({
        limit: 2,
        sortBy: "title",
        sortDir: "asc",
      });
      expect(firstPage.map((item) => item.id)).toEqual(["draft-rule", "active-rule"]);
    });

    test("sorts by quality, type, status, scope and updatedAt with tie-break", async () => {
      expect(
        (await listKnowledgeItems({ limit: 10, sortBy: "qualityScore", sortDir: "desc" })).map(
          (item) => item.id,
        ),
      ).toEqual(["active-rule", "deprecated-rule", "draft-rule", "active-unused"]);
      expect(
        (await listKnowledgeItems({ limit: 10, sortBy: "type", sortDir: "asc" })).map(
          (item) => item.id,
        ),
      ).toEqual(["active-unused", "active-rule", "deprecated-rule", "draft-rule"]);
      expect(
        (await listKnowledgeItems({ limit: 10, sortBy: "status", sortDir: "desc" })).map(
          (item) => item.id,
        ),
      ).toEqual(["draft-rule", "deprecated-rule", "active-rule", "active-unused"]);
      expect(
        (await listKnowledgeItems({ limit: 10, sortBy: "scope", sortDir: "asc" })).map(
          (item) => item.id,
        ),
      ).toHaveLength(4);
      expect(
        (await listKnowledgeItems({ limit: 10, sortBy: "updatedAt", sortDir: "desc" })).map(
          (item) => item.id,
        ),
      ).toEqual(["active-rule", "active-unused", "deprecated-rule", "draft-rule"]);

      hoisted.sqliteAll.mockReturnValue([
        sqliteRow({
          id: "older",
          title: "Same",
          importance: 50,
          confidence: 50,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        sqliteRow({
          id: "newer",
          title: "Same",
          importance: 50,
          confidence: 50,
          updatedAt: "2026-01-05T00:00:00.000Z",
        }),
      ]);
      expect(
        (await listKnowledgeItems({ limit: 10, sortBy: "title", sortDir: "asc" })).map(
          (item) => item.id,
        ),
      ).toEqual(["newer", "older"]);
      expect(
        (
          await listKnowledgeItems({
            limit: 10,
            sortBy: "unknown" as any,
            sortDir: "asc",
          })
        ).map((item) => item.id),
      ).toEqual(["older", "newer"]);
    });

    test("maps sqlite rows including date formats, source refs and defaults", async () => {
      hoisted.sqliteAll.mockReturnValue([
        sqliteRow({
          id: "mapped",
          type: "procedure",
          scope: "global",
          intentTags: "not-array",
          compileSelectCount: undefined,
          agenticAcceptCount: undefined,
          lastCompiledAt: "not-a-date",
          createdAt: "bad",
          updatedAt: new Date("2026-03-01T00:00:00.000Z"),
          lastVerifiedAt: null,
          metadata: { sourceDocumentUri: "file:///doc.md", sourceFragmentLocator: "L9" },
        }),
      ]);

      const [item] = await listKnowledgeItems({ limit: 10 });
      expect(item.id).toBe("mapped");
      expect(item.type).toBe("procedure");
      expect(item.scope).toBe("global");
      expect(item.intentTags).toEqual([]);
      expect(item.compileSelectCount).toBe(0);
      expect(item.lastCompiledAt).toBeNull();
      expect(item.createdAt.toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(item.sourceRefs).toEqual(["file:///doc.md#L9"]);
      expect(item.sourceVibeMemoryIds).toEqual([]);

      hoisted.sqliteAll.mockReturnValue([
        sqliteRow({
          id: "dates",
          lastCompiledAt: new Date("invalid"),
          lastVerifiedAt: "unix-ms:not-a-number",
          updatedAt: "",
          createdAt: `unix-ms:${Number.MAX_VALUE}`,
        }),
      ]);
      const [dates] = await listKnowledgeItems({ limit: 10 });
      expect(dates.lastCompiledAt).toBeNull();
      expect(dates.lastVerifiedAt).toBeNull();
      expect(dates.updatedAt.toISOString()).toBe("1970-01-01T00:00:00.000Z");
      expect(dates.createdAt.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    });
  });

  describe("countKnowledgeItems / listKnowledgeItems postgres", () => {
    test("returns the counted value and maps list rows", async () => {
      hoisted.mockSelect.mockReturnValueOnce(makeChain([{ count: 3 }]));
      expect(await countKnowledgeItems({ status: "active", query: "drizzle" })).toBe(3);

      hoisted.mockSelect.mockReturnValueOnce(makeChain([]));
      expect(await countKnowledgeItems({})).toBe(0);

      hoisted.mockSelect.mockReturnValueOnce(
        makeChain([
          postgresRow(),
          postgresRow({
            id: "pg-2",
            type: "procedure",
            scope: "global",
            intentTags: null,
            compileSelectCount: undefined,
            title: null,
            body: null,
            polarity: undefined,
            status: undefined,
          }),
        ]),
      );
      const items = await listKnowledgeItems({
        limit: 10,
        page: 1,
        polarities: ["positive"],
        intentTags: ["ops"],
        displayFilter: "high-value",
        minQuality: 60,
        sortBy: "qualityScore",
        sortDir: "desc",
      });
      expect(items).toHaveLength(2);
      expect(items[0].id).toBe("pg-1");
      expect(items[0].confidence).toBe(80);
      expect(items[0].sourceRefs).toEqual(["file:///pg.md#full"]);
      expect(items[1].type).toBe("procedure");
      expect(items[1].status).toBe("draft");
      expect(items[1].polarity).toBe("positive");
      expect(items[1].intentTags).toEqual([]);
      expect(items[1].compileSelectCount).toBe(0);
      expect(items[1].title).toBe("");
    });

    test("falls back when lifecycle columns are missing and rethrows other errors", async () => {
      const missing = new Error("column compile_select_count does not exist");
      hoisted.mockSelect.mockReturnValueOnce(makeRejectingChain(missing)).mockReturnValueOnce(
        makeChain([
          {
            id: "legacy",
            type: "rule",
            status: "draft",
            scope: "repo",
            polarity: "positive",
            intentTags: [],
            title: "Legacy",
            body: "no lifecycle",
            confidence: 70,
            importance: 70,
            appliesTo: {},
            metadata: {},
            lastVerifiedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]),
      );

      const items = await listKnowledgeItems({ limit: 5, displayFilter: "draft" });
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe("legacy");
      expect(items[0].dynamicScore).toBe(0);
      expect(items[0].lastCompiledAt).toBeNull();
      expect(hoisted.mockSelect).toHaveBeenCalledTimes(2);

      hoisted.mockSelect.mockReturnValueOnce(makeRejectingChain(new Error("connection lost")));
      await expect(listKnowledgeItems({ limit: 5 })).rejects.toThrow("connection lost");
    });
  });

  describe("createKnowledgeItem", () => {
    test("upserts on sqlite, links metadata and records audit", async () => {
      hoisted.backend.kind = "sqlite";
      const result = await createKnowledgeItem(createInput);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(hoisted.upsertKnowledgeItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "rule",
          status: "draft",
          title: "New knowledge",
          embedding: [0.1, 0.2, 0.3],
        }),
      );
      expect(hoisted.sqliteOrm.update).toHaveBeenCalled();
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_CREATED" }),
      );
      expect(linkKnowledgeFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeId: result.id,
          linkMetadataSource: "createKnowledgeItem",
        }),
      );
      expect(recordProjectScopedWritePersisted).toHaveBeenCalled();
      expect(new SqliteCoreRepository({} as any).upsertKnowledgeItem).toBe(
        hoisted.upsertKnowledgeItem,
      );

      await createKnowledgeItem({
        ...createInput,
        repoKey: undefined,
        repoPath: undefined,
        appliesTo: { repoKey: "from-applies", repoPath: "/from-applies" },
      });
      expect(resolveAuditedProjectScopedWriteIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          repoKey: "from-applies",
          repoPath: "/from-applies",
        }),
        expect.anything(),
      );
    });

    test("inserts on postgres even when embedding fails", async () => {
      vi.mocked(embedOne).mockRejectedValueOnce(new Error("embed down"));
      hoisted.mockInsert.mockReturnValueOnce(makeChain([{ id: "pg-created" }]));
      const result = await createKnowledgeItem({
        ...createInput,
        polarity: "negative",
        intentTags: ["release"],
      });
      expect(result).toEqual({ id: "pg-created" });
      expect(hoisted.mockInsert).toHaveBeenCalled();
      const values = hoisted.mockInsert.mock.results[0]?.value.values.mock.calls[0][0];
      expect(values.embedding).toBeUndefined();
      expect(values.polarity).toBe("negative");
      expect(linkKnowledgeFromMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeId: "pg-created" }),
      );
    });
  });

  describe("updateKnowledgeItem", () => {
    test("returns null when the item is missing on both backends", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteGet.mockReturnValue(null);
      expect(await updateKnowledgeItem("missing", { title: "x" })).toBeNull();

      hoisted.backend.kind = "postgres";
      hoisted.mockSelect.mockReturnValueOnce(makeChain([]));
      expect(await updateKnowledgeItem("missing", { title: "x" })).toBeNull();
    });

    test("updates sqlite with status change, embedding and lastVerifiedAt", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteGet.mockReturnValue(
        sqliteRow({
          id: "k-1",
          status: "draft",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          lastVerifiedAt: new Date("2026-01-02T00:00:00.000Z"),
        }),
      );
      const result = await updateKnowledgeItem("k-1", {
        status: "active",
        title: "Renamed",
        body: "Changed body",
        confidence: 91,
        importance: 92,
        metadata: { extra: true },
      });
      expect(result).toEqual({ id: "k-1" });
      expect(hoisted.upsertKnowledgeItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "k-1",
          status: "active",
          title: "Renamed",
          embedding: [0.1, 0.2, 0.3],
        }),
      );
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_UPDATED" }),
      );
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_STATUS_CHANGED",
          payload: expect.objectContaining({ fromStatus: "draft", toStatus: "active" }),
        }),
      );
      expect(assertAuditedStoredProjectScopedIdentityCompatible).toHaveBeenCalled();
    });

    test("keeps sqlite lastVerifiedAt and strips repo keys for global identity", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteGet.mockReturnValue(
        sqliteRow({
          id: "k-global",
          status: "active",
          appliesTo: { repoKey: "keep-me-not", repoPath: "/repo", extra: 1 },
          lastVerifiedAt: "2026-01-02T00:00:00.000Z",
        }),
      );
      vi.mocked(resolveAuditedProjectScopedWriteIdentity).mockResolvedValueOnce({
        ...identity,
        scope: "global",
        scopeMode: "global_only",
        repoKey: null,
        repoPath: null,
      });
      await updateKnowledgeItem("k-global", { scope: "global", polarity: "negative" });
      expect(hoisted.upsertKnowledgeItem).toHaveBeenCalledWith(
        expect.objectContaining({
          appliesTo: { extra: 1 },
          embedding: undefined,
        }),
      );
      expect(recordAuditLogSafe).not.toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_STATUS_CHANGED" }),
      );
    });

    test("merges applicability patches on sqlite", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteGet.mockReturnValue(
        sqliteRow({
          id: "k-app",
          appliesTo: { extra: true, technologies: ["old"] },
        }),
      );
      await updateKnowledgeItem("k-app", {
        appliesTo: { extra: 2, repoKey: 12 },
        general: true,
        technologies: ["typescript"],
        changeTypes: ["refactor"],
        domains: ["testing"],
        repoPath: "/repo",
        repoKey: "repo-key",
      });
      expect(hoisted.upsertKnowledgeItem).toHaveBeenCalledWith(
        expect.objectContaining({
          appliesTo: expect.objectContaining({ extra: 2, general: true }),
        }),
      );
    });

    test("updates postgres and returns null when returning is empty", async () => {
      hoisted.mockSelect.mockReturnValueOnce(
        makeChain([postgresRow({ id: "pg-1", status: "draft" })]),
      );
      hoisted.mockUpdate.mockReturnValueOnce(makeChain([{ id: "pg-1" }]));
      await expect(updateKnowledgeItem("pg-1", { status: "active" })).resolves.toEqual({
        id: "pg-1",
      });
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_STATUS_CHANGED" }),
      );

      hoisted.mockSelect.mockReturnValueOnce(makeChain([postgresRow({ id: "pg-2" })]));
      hoisted.mockUpdate.mockReturnValueOnce(makeChain([]));
      await expect(updateKnowledgeItem("pg-2", { title: "same" })).resolves.toBeNull();
    });
  });

  describe("deleteKnowledgeItem", () => {
    test("deletes sqlite rows including fts and skips missing ids", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteGet.mockReturnValueOnce(null);
      expect(await deleteKnowledgeItem("missing")).toBeNull();

      hoisted.sqliteGet.mockReturnValueOnce(sqliteRow({ id: "k-del" }));
      expect(await deleteKnowledgeItem("k-del")).toEqual({ id: "k-del" });
      expect(hoisted.sqliteQuery).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM knowledge_items_fts"),
      );
      expect(hoisted.sqliteQueryRun).toHaveBeenCalledWith("k-del");
      expect(hoisted.sqliteOrm.delete).toHaveBeenCalled();
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_DELETED" }),
      );
    });

    test("deletes postgres rows and returns null when nothing is deleted", async () => {
      hoisted.mockDelete.mockReturnValueOnce(makeChain([{ id: "pg-del" }]));
      expect(await deleteKnowledgeItem("pg-del")).toEqual({ id: "pg-del" });
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_DELETED",
          payload: { knowledgeId: "pg-del" },
        }),
      );

      hoisted.mockDelete.mockReturnValueOnce(makeChain([]));
      expect(await deleteKnowledgeItem("missing")).toBeNull();
    });
  });

  describe("bulkUpdateKnowledgeStatus", () => {
    test("returns empty buckets when no ids remain after trimming", async () => {
      const result = await bulkUpdateKnowledgeStatus({ ids: ["  ", ""], status: "active" });
      expect(result).toEqual({
        targetStatus: "active",
        requestedIds: [],
        updatedIds: [],
        unchangedIds: [],
        notFoundIds: [],
        invalidTransitionIds: [],
      });
    });

    test("classifies sqlite ids and promotes draft to active", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteAll.mockReturnValue([
        sqliteRow({ id: "d1", status: "draft" }),
        sqliteRow({ id: "a1", status: "active" }),
        sqliteRow({ id: "a2", status: "active" }),
      ]);
      const result = await bulkUpdateKnowledgeStatus({
        ids: ["d1", "a1", "missing", "d1"],
        status: "active",
      });
      expect(result.requestedIds).toEqual(["d1", "a1", "missing"]);
      expect(result.updatedIds).toEqual(["d1"]);
      expect(result.unchangedIds).toEqual(["a1"]);
      expect(result.notFoundIds).toEqual(["missing"]);
      expect(result.invalidTransitionIds).toEqual([]);
      expect(hoisted.sqliteOrm.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "active", lastVerifiedAt: expect.any(String) }),
      );
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_STATUS_CHANGED" }),
      );
    });

    test("resolves sqlite selection and records invalid transitions", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteAll.mockReturnValue([sqliteRow({ id: "a1", status: "active", title: "keep" })]);
      const result = await bulkUpdateKnowledgeStatus({
        selection: { query: "keep", status: "active" },
        status: "draft",
      });
      expect(result.invalidTransitionIds).toEqual([{ id: "a1", fromStatus: "active" }]);
      expect(result.updatedIds).toEqual([]);
      expect(hoisted.sqliteOrm.update).not.toHaveBeenCalled();
    });

    test("updates postgres by selection and promotes lastVerifiedAt", async () => {
      hoisted.mockSelect
        .mockReturnValueOnce(makeChain([{ id: "d1" }, { id: "a1" }]))
        .mockReturnValueOnce(
          makeChain([
            { id: "d1", status: "draft" },
            { id: "a1", status: "active" },
          ]),
        );
      hoisted.mockUpdate.mockReturnValue(makeChain(undefined));
      const result = await bulkUpdateKnowledgeStatus({
        selection: { status: "active" },
        status: "active",
      });
      expect(result.updatedIds).toEqual(["d1"]);
      expect(result.unchangedIds).toEqual(["a1"]);
      expect(hoisted.mockUpdate).toHaveBeenCalledTimes(2);
    });

    test("updates postgres without a second lastVerifiedAt write when not promoting", async () => {
      hoisted.mockSelect.mockReturnValueOnce(
        makeChain([
          { id: "a1", status: "active" },
          { id: "x1", status: "deprecated" },
        ]),
      );
      hoisted.mockUpdate.mockReturnValueOnce(makeChain(undefined));
      const result = await bulkUpdateKnowledgeStatus({
        ids: ["a1", "x1"],
        status: "deprecated",
      });
      expect(result.updatedIds).toEqual(["a1"]);
      expect(result.unchangedIds).toEqual(["x1"]);
      expect(hoisted.mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("recordKnowledgeFeedback", () => {
    test("records sqlite up/down votes and returns null when missing", async () => {
      hoisted.backend.kind = "sqlite";
      hoisted.sqliteGet.mockReturnValueOnce(null);
      expect(await recordKnowledgeFeedback({ id: "missing", direction: "up" })).toBeNull();

      hoisted.sqliteGet.mockReturnValue(
        sqliteRow({
          id: "k-fb",
          explicitUpvoteCount: 1,
          explicitDownvoteCount: 2,
          compileSelectCount: 3,
          agenticAcceptCount: 1,
          lastVerifiedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      hoisted.sqliteQueryGet.mockReturnValueOnce(undefined).mockReturnValue({ count: 4 });
      const up = await recordKnowledgeFeedback({
        id: "k-fb",
        direction: "up",
        reason: "  helpful  ",
      });
      expect(up?.id).toBe("k-fb");
      expect(up?.explicitUpvoteCount).toBe(2);
      expect(up?.explicitDownvoteCount).toBe(2);
      expect(up?.lastVerifiedAt).toBeInstanceOf(Date);
      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "KNOWLEDGE_FEEDBACK_RECORDED" }),
      );

      const down = await recordKnowledgeFeedback({ id: "k-fb", direction: "down" });
      expect(down?.explicitDownvoteCount).toBe(3);
      expect(hoisted.sqliteQuery).toHaveBeenCalledWith(
        expect.stringContaining("FROM context_pack_items"),
      );

      hoisted.sqliteGet.mockReturnValue(
        sqliteRow({
          id: "k-fb2",
          explicitUpvoteCount: undefined,
          explicitDownvoteCount: undefined,
          compileSelectCount: undefined,
          agenticAcceptCount: undefined,
          lastVerifiedAt: null,
        }),
      );
      const downUnset = await recordKnowledgeFeedback({ id: "k-fb2", direction: "down" });
      expect(downUnset?.explicitUpvoteCount).toBe(0);
      expect(downUnset?.explicitDownvoteCount).toBe(1);
      expect(downUnset?.lastVerifiedAt).toBeNull();
    });

    test("records postgres feedback and returns null when update misses", async () => {
      hoisted.mockSelect
        .mockReturnValueOnce(
          makeChain([
            postgresRow({
              id: "pg-fb",
              explicitUpvoteCount: 0,
              explicitDownvoteCount: 0,
            }),
          ]),
        )
        .mockReturnValueOnce(makeChain([{ count: 2 }]));
      hoisted.mockUpdate.mockReturnValueOnce(
        makeChain([
          {
            id: "pg-fb",
            explicitUpvoteCount: 1,
            explicitDownvoteCount: 0,
            dynamicScore: 11,
            lastVerifiedAt: new Date("2026-02-02T00:00:00.000Z"),
          },
        ]),
      );
      const result = await recordKnowledgeFeedback({ id: "pg-fb", direction: "up" });
      expect(result).toEqual({
        id: "pg-fb",
        direction: "up",
        explicitUpvoteCount: 1,
        explicitDownvoteCount: 0,
        dynamicScore: 11,
        lastVerifiedAt: new Date("2026-02-02T00:00:00.000Z"),
      });

      hoisted.mockSelect
        .mockReturnValueOnce(makeChain([postgresRow({ id: "pg-fb" })]))
        .mockReturnValueOnce(makeChain([]));
      hoisted.mockUpdate.mockReturnValueOnce(makeChain([]));
      expect(await recordKnowledgeFeedback({ id: "pg-fb", direction: "down" })).toBeNull();
    });
  });

  describe("listKnowledgeTagDefinitionsForApi", () => {
    test("maps definitions and forwards kind/status filters", async () => {
      const mapped = await listKnowledgeTagDefinitionsForApi();
      expect(mapped).toEqual([
        {
          id: "tag-1",
          kind: "technology",
          slug: "typescript",
          label: "TypeScript",
          description: "lang",
          aliases: ["ts"],
          status: "active",
          sortOrder: 10,
        },
      ]);
      expect(listKnowledgeTagDefinitions).toHaveBeenCalledWith({
        kinds: undefined,
        statuses: undefined,
      });

      await listKnowledgeTagDefinitionsForApi({ kind: "domain", status: "draft" });
      expect(listKnowledgeTagDefinitions).toHaveBeenCalledWith({
        kinds: ["domain"],
        statuses: ["draft"],
      });
    });
  });
});
