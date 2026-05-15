import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  upsertSourceDocument,
  searchSourceContent,
} from "../src/modules/sources/source.repository.js";
import { db } from "../src/db/index.js";

vi.mock("../src/modules/sources/source.repository.js", async (importOriginal) => {
  return {
    ...(await importOriginal<any>()),
  };
});

vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn(() => Promise.resolve(new Array(1536).fill(0.1))),
}));

vi.mock("../src/db/index.js", () => {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "sid" }])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
    query: {
      sources: {
        findFirst: vi.fn(),
      },
    },
  };
  return { db: chain };
});

describe("Source Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("upsertSourceDocument inserts and returns id", async () => {
    vi.mocked(db.query.sources.findFirst).mockResolvedValue(undefined as any);

    const id = await upsertSourceDocument({
      sourceKind: "wiki",
      uri: "test-uri",
      body: "content",
      metadata: {},
    });
    expect(id).toBe("sid");
    expect(db.insert).toHaveBeenCalled();
  });

  test("searchSourceContent calls select", async () => {
    await searchSourceContent("query", 10);
    expect(db.select).toHaveBeenCalled();
  });
});
