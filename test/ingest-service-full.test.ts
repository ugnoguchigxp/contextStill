import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestAntigravityLogs,
  ingestAntigravityLogsFromRoot,
  ingestAntigravityLogsFromRoots,
  ingestClaudeLogs,
  ingestClaudeLogsFromRoot,
  ingestClaudeLogsFromRoots,
  ingestCodexLogs,
  ingestCodexLogsFromRoots,
  normalizeIngestCursor,
} from "../src/modules/agent-log-sync/ingest.service.js";

// node:fs/promises モック用のモック関数
const mockFsReadFile = vi.fn();
const mockFsReaddir = vi.fn();
const mockFsRm = vi.fn();
const mockFsStat = vi.fn();

vi.mock("node:fs/promises", () => {
  return {
    default: {
      readFile: (...args: any[]) => mockFsReadFile(...args),
      readdir: (...args: any[]) => mockFsReaddir(...args),
      rm: (...args: any[]) => mockFsRm(...args),
      stat: (...args: any[]) => mockFsStat(...args),
    },
  };
});

// node:fs モック用のモック関数
const mockCreateReadStream = vi.fn();
vi.mock("node:fs", () => {
  return {
    createReadStream: (...args: any[]) => mockCreateReadStream(...args),
  };
});

// config モック
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    agentLogSync: {
      initialLookbackHours: 24,
    },
    antigravity: {
      initialLookbackHours: 24,
    },
  },
}));

// 外部パーサー／ヘルパーのモック関数
const mockParseAntigravityOverviewMessages = vi.fn();
const mockSessionIdFromFile = vi.fn();
const mockParseClaudeSessionLog = vi.fn();
const mockProcessCodexJsonlDelta = vi.fn();
const mockReadCodexFileContext = vi.fn();
const mockBuildAntigravityIngestRoots = vi.fn();
const mockBuildClaudeIngestRoots = vi.fn();
const mockBuildCodexIngestRoots = vi.fn();
const mockDecodeClaudeProjectPath = vi.fn();

vi.mock("../src/modules/agent-log-sync/antigravity-parser.js", () => ({
  parseAntigravityOverviewMessages: (...args: any[]) =>
    mockParseAntigravityOverviewMessages(...args),
  sessionIdFromFile: (...args: any[]) => mockSessionIdFromFile(...args),
}));

vi.mock("../src/modules/agent-log-sync/claude-parser.js", () => ({
  parseClaudeSessionLog: (...args: any[]) => mockParseClaudeSessionLog(...args),
}));

vi.mock("../src/modules/agent-log-sync/codex-parser.js", () => ({
  processCodexJsonlDelta: (...args: any[]) => mockProcessCodexJsonlDelta(...args),
  readCodexFileContext: (...args: any[]) => mockReadCodexFileContext(...args),
}));

vi.mock("../src/modules/agent-log-sync/ingest-roots.js", () => ({
  buildAntigravityIngestRoots: (...args: any[]) => mockBuildAntigravityIngestRoots(...args),
  buildClaudeIngestRoots: (...args: any[]) => mockBuildClaudeIngestRoots(...args),
  buildCodexIngestRoots: (...args: any[]) => mockBuildCodexIngestRoots(...args),
  decodeClaudeProjectPath: (...args: any[]) => mockDecodeClaudeProjectPath(...args),
}));

describe("IngestService logic", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("normalizeIngestCursor", () => {
    it("returns empty object for invalid inputs", () => {
      expect(normalizeIngestCursor(null)).toEqual({});
      expect(normalizeIngestCursor(undefined)).toEqual({});
      expect(normalizeIngestCursor("string")).toEqual({});
      expect(normalizeIngestCursor([])).toEqual({});
    });

    it("parses valid cursors and defaults invalid numeric fields", () => {
      const raw = {
        "file1.jsonl": { offset: 120, mtimeMs: 5000 },
        "file2.jsonl": { offset: "invalid", mtimeMs: -100 },
      };
      const result = normalizeIngestCursor(raw);
      expect(result).toEqual({
        "file1.jsonl": { offset: 120, mtimeMs: 5000 },
        "file2.jsonl": { offset: 0, mtimeMs: 0 },
      });
    });
  });

  describe("Codex Ingestion", () => {
    it("skips ingestion if roots is empty", async () => {
      mockBuildCodexIngestRoots.mockReturnValue([]);
      const result = await ingestCodexLogs();
      expect(result.skipped).toBe(true);
      expect(result.messages).toEqual([]);
    });

    it("records warnings if root list fails", async () => {
      const err = new Error("Permission denied");
      mockFsReaddir.mockRejectedValue(err);

      const result = await ingestCodexLogsFromRoots(["/mock/root"]);
      expect(result.warnings[0]).toContain("Codex root ingest failed");
      expect(result.messages).toEqual([]);
    });

    it("ingests changes from a jsonl file", async () => {
      // Readdir mock for listJsonlFilesRecursively
      mockFsReaddir.mockResolvedValueOnce([
        { name: "sub", isDirectory: () => true, isFile: () => false },
      ]);
      mockFsReaddir.mockResolvedValueOnce([
        { name: "file1.jsonl", isDirectory: () => false, isFile: () => true },
      ]);

      const now = Date.now();
      mockFsStat.mockResolvedValue({
        size: 200,
        mtimeMs: now,
        isFile: () => true,
      });

      // Stream mock for readTextDelta (startOffset > 0)
      const mockStream = {
        on: vi.fn((event, cb) => {
          if (event === "data") cb("chunk data");
          if (event === "end") cb();
          return mockStream;
        }),
      };
      mockCreateReadStream.mockReturnValue(mockStream);

      mockReadCodexFileContext.mockResolvedValue({ some: "context" });
      mockProcessCodexJsonlDelta.mockReturnValue({
        messages: [{ role: "user", content: "hello" }],
        nextOffset: 200,
      });

      const cursor = {
        "/mock/root/sub/file1.jsonl": { offset: 50, mtimeMs: now - 1000 },
      };

      const result = await ingestCodexLogsFromRoots(["/mock/root"], undefined, cursor);
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe("hello");
      expect(result.cursor["/mock/root/sub/file1.jsonl"]).toEqual({
        offset: 200,
        mtimeMs: now,
      });
    });

    it("skips file if its mtime is below threshold and cursor is not set", async () => {
      mockFsReaddir.mockResolvedValueOnce([
        { name: "old.jsonl", isDirectory: () => false, isFile: () => true },
      ]);

      const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
      mockFsStat.mockResolvedValue({
        size: 150,
        mtimeMs: oldTime,
        isFile: () => true,
      });

      // initialLookbackHours = 24h
      const result = await ingestCodexLogsFromRoots(["/mock/root"]);
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(0);
      expect(result.cursor["/mock/root/old.jsonl"]).toEqual({
        offset: 150,
        mtimeMs: oldTime,
      });
    });

    it("reads whole file with fs.readFile when startOffset <= 0 or reset", async () => {
      mockFsReaddir.mockResolvedValueOnce([
        { name: "file.jsonl", isDirectory: () => false, isFile: () => true },
      ]);

      const now = Date.now();
      mockFsStat.mockResolvedValue({
        size: 100,
        mtimeMs: now,
        isFile: () => true,
      });

      mockFsReadFile.mockResolvedValue("full content");
      mockProcessCodexJsonlDelta.mockReturnValue({
        messages: [{ role: "assistant", content: "res" }],
        nextOffset: 100,
      });

      // Cursor offset > stat.size triggers reset to 0
      const cursor = {
        "/mock/root/file.jsonl": { offset: 150, mtimeMs: now },
      };

      const result = await ingestCodexLogsFromRoots(["/mock/root"], undefined, cursor);
      expect(result.ok).toBe(true);
      expect(mockFsReadFile).toHaveBeenCalledWith("/mock/root/file.jsonl", "utf-8");
      expect(result.messages[0].content).toBe("res");
    });
  });

  describe("Antigravity Ingestion", () => {
    it("skips ingestion if root is empty", async () => {
      const result = await ingestAntigravityLogsFromRoot("");
      expect(result.skipped).toBe(true);
      expect(result.messages).toEqual([]);
    });

    it("returns errors when readdir fails unexpectedly", async () => {
      const err = new Error("FS Error");
      mockFsReaddir.mockRejectedValue(err);

      const result = await ingestAntigravityLogsFromRoot("/mock/root");
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("Antigravity logs root ingest failed");
    });

    it("returns empty result if readdir fails with ENOENT", async () => {
      const err = new Error("ENOENT") as any;
      err.code = "ENOENT";
      mockFsReaddir.mockRejectedValue(err);

      const result = await ingestAntigravityLogsFromRoot("/mock/root");
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it("ingests transcript.jsonl, cleans up overview.txt and legacy history", async () => {
      mockBuildAntigravityIngestRoots.mockReturnValue(["/mock/root"]);
      // 1st readdir: sessions in /mock/root
      mockFsReaddir.mockResolvedValueOnce(["session1"]);
      // rm check for cleanUpLegacyFiles
      mockFsStat.mockImplementation(async (filePath) => {
        if (filePath.endsWith("history.jsonl")) {
          return { isFile: () => true } as any;
        }
        return { size: 100, mtimeMs: Date.now(), isFile: () => true } as any;
      });
      mockFsRm.mockResolvedValue(undefined);

      // 2nd readdir: logs inside session1 logsDir (called with withFileTypes: true)
      mockFsReaddir.mockResolvedValueOnce([
        { name: "transcript.jsonl", isFile: () => true, isDirectory: () => false },
        { name: "overview.txt", isFile: () => true, isDirectory: () => false },
      ]);

      mockFsReadFile.mockResolvedValue('{"step_index": 1, "type": "USER_INPUT"}');
      mockParseAntigravityOverviewMessages.mockResolvedValue([{ role: "user", content: "hello" }]);

      const result = await ingestAntigravityLogs();
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(1);
      // Verify legacy overview.txt was deleted
      expect(mockFsRm).toHaveBeenCalledWith(expect.stringContaining("overview.txt"), {
        force: true,
      });
      // Verify legacy history.jsonl was cleaned up
      expect(mockFsRm).toHaveBeenCalledWith(expect.stringContaining("history.jsonl"), {
        force: true,
      });
    });
  });

  describe("Claude Ingestion", () => {
    it("skips ingestion if roots are empty", async () => {
      mockBuildClaudeIngestRoots.mockReturnValue([]);
      const result = await ingestClaudeLogs();
      expect(result.skipped).toBe(true);
      expect(result.messages).toEqual([]);
    });

    it("returns errors when readdir fails on root unexpectedly", async () => {
      mockFsReaddir.mockRejectedValue(new Error("Disk Read Error"));

      const result = await ingestClaudeLogsFromRoot("/mock/root");
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("Claude logs root ingest failed");
    });

    it("returns empty result if readdir fails with ENOTDIR", async () => {
      const err = new Error("ENOTDIR") as any;
      err.code = "ENOTDIR";
      mockFsReaddir.mockRejectedValue(err);

      const result = await ingestClaudeLogsFromRoot("/mock/root");
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it("ingests Claude session logs and adds projectName/projectRoot metadata", async () => {
      mockBuildClaudeIngestRoots.mockReturnValue(["/mock/root"]);
      // readdir for projectDirs
      mockFsReaddir.mockResolvedValueOnce(["project1"]);
      // stat for project1 directory
      mockFsStat.mockResolvedValueOnce({
        isDirectory: () => true,
        isFile: () => false,
      });

      mockDecodeClaudeProjectPath.mockReturnValue({
        projectName: "My Project",
        projectRoot: "/path/to/project",
      });

      // readdir for session files inside project1
      mockFsReaddir.mockResolvedValueOnce(["session1.jsonl", "other.txt"]);

      // stat for session1.jsonl
      mockFsStat.mockResolvedValueOnce({
        size: 50,
        mtimeMs: Date.now(),
        isFile: () => true,
        isDirectory: () => false,
      });

      mockFsReadFile.mockResolvedValue("mock log content");
      mockSessionIdFromFile.mockReturnValue("session-123");
      mockParseClaudeSessionLog.mockReturnValue([
        { role: "user", content: "claude user input", metadata: {} },
      ]);

      const result = await ingestClaudeLogs();
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].metadata).toEqual({
        projectName: "My Project",
        projectRoot: "/path/to/project",
      });
    });

    it("skips files/dirs when stat fails in loop", async () => {
      mockFsReaddir.mockResolvedValueOnce(["proj1"]);
      mockFsStat.mockRejectedValueOnce(new Error("Stat failure"));

      const result = await ingestClaudeLogsFromRoot("/mock/root");
      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(0);
    });
  });

  describe("ingestAntigravityLogsFromRoots error collection", () => {
    it("aggregates results from multiple roots", async () => {
      // 1st root success, 2nd root failure
      // Root 1
      mockFsReaddir.mockResolvedValueOnce([]); // no sessions
      // Root 2
      mockFsReaddir.mockRejectedValueOnce(new Error("Second root failed"));

      const result = await ingestAntigravityLogsFromRoots(["/root1", "/root2"]);
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Second root failed");
    });
  });

  describe("ingestClaudeLogsFromRoots error collection", () => {
    it("aggregates results from multiple roots", async () => {
      // Root 1
      mockFsReaddir.mockResolvedValueOnce([]);
      // Root 2
      mockFsReaddir.mockRejectedValueOnce(new Error("Claude root failed"));

      const result = await ingestClaudeLogsFromRoots(["/root1", "/root2"]);
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Claude root failed");
    });
  });
});
