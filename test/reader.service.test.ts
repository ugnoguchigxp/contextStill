import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { agentDiffEntries, vibeMemories } from "../src/db/schema.js";
import { readVibeMemoryByTokenWindow } from "../src/modules/memoryReader/reader.service.js";

const mockFrom = vi.fn();

// original Bun グローバルの退避
const originalBun = (globalThis as any).Bun;

vi.mock("../src/db/index.js", () => {
  return {
    db: {
      select: vi.fn(() => ({
        from: (table: any) => mockFrom(table),
      })),
    },
  };
});

describe("reader.service tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Node.js テスト環境用の Bun.markdown モックを注入
    (globalThis as any).Bun = {
      markdown: {
        render: vi.fn((markdown: string) => {
          // テストでは単に元のテキストをそのままプレーンテキストとしてシミュレートして返します
          return markdown;
        }),
      },
    };
  });

  afterEach(() => {
    (globalThis as any).Bun = originalBun;
  });

  test("throws error if vibeMemoryId is empty or whitespace", async () => {
    await expect(readVibeMemoryByTokenWindow({ vibeMemoryId: "" })).rejects.toThrow(
      "vibeMemoryId must be a non-empty string",
    );
    await expect(readVibeMemoryByTokenWindow({ vibeMemoryId: "   " })).rejects.toThrow(
      "vibeMemoryId must be a non-empty string",
    );
  });

  test("throws error if vibe memory is not found in database", async () => {
    mockFrom.mockImplementation((table) => {
      if (table === vibeMemories) {
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]), // Empty result
        };
      }
      return {};
    });

    await expect(readVibeMemoryByTokenWindow({ vibeMemoryId: "non-existent" })).rejects.toThrow(
      "vibe memory not found: non-existent",
    );
  });

  test("successfully reads vibe memory and slices it by token window (default mode)", async () => {
    mockFrom.mockImplementation((table) => {
      if (table === vibeMemories) {
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([
            {
              id: "m1",
              content: "This is some manual memory content.",
            },
          ]),
        };
      }
      if (table === agentDiffEntries) {
        return {
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([
            {
              id: "d1",
              diffHunk: "This is custom diff details.",
            },
          ]),
        };
      }
      return {};
    });

    const result = await readVibeMemoryByTokenWindow({
      vibeMemoryId: "m1",
      readTokens: 100,
    });

    expect(result.content).toBeDefined();
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.from).toBe(0);
  });

  test("successfully reads vibe memory with custom mode, fromToken, and deduplicates segment", async () => {
    mockFrom.mockImplementation((table) => {
      if (table === vibeMemories) {
        return {
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([
            {
              id: "m1",
              content: "Duplicate content",
            },
          ]),
        };
      }
      if (table === agentDiffEntries) {
        return {
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockResolvedValue([
            {
              id: "d1",
              diffHunk: "Duplicate content", // Duplicate segment to trigger dedupeSegments
            },
            {
              id: "d2",
              diffHunk: "   ", // Empty segment to be skipped
            },
          ]),
        };
      }
      return {};
    });

    // Run with compressed mode
    const resultCompressed = await readVibeMemoryByTokenWindow({
      vibeMemoryId: "m1",
      mode: "compressed",
      fromToken: 2,
      readTokens: 5,
    });

    expect(resultCompressed.content).toBeDefined();

    // Run with original mode
    const resultRaw = await readVibeMemoryByTokenWindow({
      vibeMemoryId: "m1",
      mode: "original",
      fromToken: 0,
      readTokens: 10,
    });

    expect(resultRaw.content).toBeDefined();
  });
});
