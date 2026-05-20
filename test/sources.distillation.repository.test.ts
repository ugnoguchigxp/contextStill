import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  listSourceFragmentsForDistillation,
  upsertSourceDistillationRun,
} from "../src/modules/sources/distillation.repository.js";
import { db } from "../src/db/client.js";

vi.mock("../src/db/client.js", () => {
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve([])),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "rid" }])),
        })),
        returning: vi.fn(() => Promise.resolve([{ id: "rid" }])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  };
  return { db: chain };
});

describe("Sources Distillation Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("listSourceFragmentsForDistillation calls select", async () => {
    await listSourceFragmentsForDistillation({ limit: 10, promptVersion: "v1" });
    expect(db.select).toHaveBeenCalled();
  });

  test("upsertSourceDistillationRun calls insert with onConflict", async () => {
    const run = await upsertSourceDistillationRun({
      sourceFragmentId: "fid",
      status: "ok",
      candidateCount: 1,
      knowledgeIds: ["k1"],
      promptVersion: "v1",
      model: "m1",
    });
    expect(run.id).toBe("rid");
    expect(db.insert).toHaveBeenCalled();
  });
});
