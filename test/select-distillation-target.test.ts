import { describe, expect, it } from "vitest";
import {
  selectDistillationTarget,
  type DistillationTargetCandidate,
} from "../src/modules/selectDistillationTarget/domain.js";

function wiki(
  targetKey: string,
  overrides: Partial<DistillationTargetCandidate> = {},
): DistillationTargetCandidate {
  return {
    targetKind: "wiki_file",
    targetKey,
    sourceUri: `/wiki/pages/${targetKey}`,
    inputHash: `hash-${targetKey}`,
    status: "pending",
    sortKey: targetKey.toLowerCase(),
    ...overrides,
  };
}

function vibe(
  targetKey: string,
  createdAt: string,
  overrides: Partial<DistillationTargetCandidate> = {},
): DistillationTargetCandidate {
  return {
    targetKind: "vibe_memory",
    targetKey,
    sourceUri: `vibe_memory:${targetKey}`,
    inputHash: `hash-${targetKey}`,
    status: "pending",
    createdAt: new Date(createdAt),
    ...overrides,
  };
}

describe("selectDistillationTarget", () => {
  it("selects the first pending wiki file alphabetically before vibe memory", () => {
    const selected = selectDistillationTarget([
      vibe("vibe-1", "2026-05-18T00:00:00.000Z"),
      wiki("best-practice/zod.md"),
      wiki("best-practice/hono.md"),
    ]);

    expect(selected?.targetKind).toBe("wiki_file");
    expect(selected?.targetKey).toBe("best-practice/hono.md");
  });

  it("skips completed wiki files", () => {
    const selected = selectDistillationTarget([
      wiki("best-practice/a.md", { status: "completed" }),
      wiki("best-practice/b.md"),
    ]);

    expect(selected?.targetKey).toBe("best-practice/b.md");
  });

  it("falls back to the oldest vibe memory when no wiki file is selectable", () => {
    const selected = selectDistillationTarget([
      wiki("best-practice/a.md", { status: "completed" }),
      vibe("vibe-new", "2026-05-19T00:00:00.000Z"),
      vibe("vibe-old", "2026-05-17T00:00:00.000Z"),
    ]);

    expect(selected?.targetKind).toBe("vibe_memory");
    expect(selected?.targetKey).toBe("vibe-old");
  });

  it("returns null if no target is selectable", () => {
    const selected = selectDistillationTarget([
      wiki("best-practice/a.md", { status: "completed" }),
      vibe("vibe-1", "2026-05-17T00:00:00.000Z", { status: "running" }),
    ]);

    expect(selected).toBeNull();
  });
});
