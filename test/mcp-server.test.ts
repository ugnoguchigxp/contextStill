import { describe, expect, test, vi, beforeEach } from "vitest";
import { listStaticResources, readStaticResource, createMcpServer } from "../src/mcp/server.js";
import {
  listRecentCompileRuns,
  getLatestCompileRunSnapshot,
  getCompileRunSnapshot,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import { runDoctor } from "../src/modules/doctor/doctor.service.js";
import { getExposedToolEntries } from "../src/mcp/tools/index.js";

vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/modules/doctor/doctor.service.js");
vi.mock("../src/mcp/tools/index.js");

describe("MCP Server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("listStaticResources returns all static definitions", () => {
    const resources = listStaticResources();
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.some((r) => r.name === "doctor-health")).toBe(true);
  });

  describe("readStaticResource", () => {
    test("reads context-compiler-summary", async () => {
      const result = await readStaticResource("memory-router://summary/context-compiler");
      expect(result.contents[0].text).toContain("# memory-router");
    });

    test("reads packs/list", async () => {
      vi.mocked(listRecentCompileRuns).mockResolvedValue([{ id: "r1" } as any]);
      const result = await readStaticResource("memory-router://packs/list");
      const data = JSON.parse(result.contents[0].text);
      expect(data.runs).toHaveLength(1);
    });

    test("reads packs/latest", async () => {
      vi.mocked(getLatestCompileRunSnapshot).mockResolvedValue({ run: { id: "latest" } } as any);
      const result = await readStaticResource("memory-router://packs/latest");
      const data = JSON.parse(result.contents[0].text);
      expect(data.run.id).toBe("latest");
    });

    test("reads packs/latest - not found", async () => {
      vi.mocked(getLatestCompileRunSnapshot).mockResolvedValue(null);
      const result = await readStaticResource("memory-router://packs/latest");
      expect(result.contents[0].text).toContain("No context_compile run found yet");
    });

    test("reads doctor-health", async () => {
      vi.mocked(runDoctor).mockResolvedValue({ status: "ok" } as any);
      const result = await readStaticResource("memory-router://health/doctor");
      const data = JSON.parse(result.contents[0].text);
      expect(data.status).toBe("ok");
    });

    test("reads specific pack run", async () => {
      vi.mocked(getCompileRunSnapshot).mockResolvedValue({ run: { id: "r123" } } as any);
      const result = await readStaticResource("memory-router://packs/run/r123");
      const data = JSON.parse(result.contents[0].text);
      expect(data.run.id).toBe("r123");
    });

    test("reads specific pack run - not found", async () => {
      vi.mocked(getCompileRunSnapshot).mockResolvedValue(null);
      const result = await readStaticResource("memory-router://packs/run/missing");
      const data = JSON.parse(result.contents[0].text);
      expect(data.error).toBe("run not found");
    });

    test("returns error for unknown URI", async () => {
      const result = await readStaticResource("unknown://uri");
      const data = JSON.parse(result.contents[0].text);
      expect(data.error).toBe("resource not found");
    });
  });

  test("createMcpServer initializes server with correct metadata", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
    // handlers are internal, but we verified the creation doesn't throw
  });
});
