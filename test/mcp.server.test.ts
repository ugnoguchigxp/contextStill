import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMcpServer, listStaticResources, readStaticResource } from "../src/mcp/server.js";
import * as repository from "../src/modules/context-compiler/context-compiler.repository.js";
import * as doctorService from "../src/modules/doctor/doctor.service.js";

vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/modules/doctor/doctor.service.js");

describe("MCP server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("listStaticResources returns all resources", () => {
    const resources = listStaticResources();
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.some((r) => r.name === "context-compiler-summary")).toBe(true);
  });

  describe("readStaticResource", () => {
    test("returns summary text", async () => {
      const result = await readStaticResource("memory-router://summary/context-compiler");
      expect(result.contents[0].text).toContain("# memory-router context compiler");
    });

    test("returns recent runs from repository", async () => {
      vi.mocked(repository.listRecentCompileRuns).mockResolvedValue([
        { id: "run1" } as unknown as never,
      ]);
      const result = await readStaticResource("memory-router://packs/list");
      expect(result.contents[0].text).toContain("run1");
    });

    test("returns latest run snapshot", async () => {
      vi.mocked(repository.getLatestCompileRunSnapshot).mockResolvedValue({
        runId: "latest",
      } as unknown as never);
      const result = await readStaticResource("memory-router://packs/latest");
      expect(result.contents[0].text).toContain("latest");
    });

    test("returns health report", async () => {
      vi.mocked(doctorService.runDoctor).mockResolvedValue({ ok: true } as unknown as never);
      const result = await readStaticResource("memory-router://health/doctor");
      expect(result.contents[0].text).toContain('"ok": true');
    });

    test("returns specific run snapshot", async () => {
      vi.mocked(repository.getCompileRunSnapshot).mockResolvedValue({
        runId: "target-run",
      } as unknown as never);
      const result = await readStaticResource("memory-router://packs/run/target-run");
      expect(result.contents[0].text).toContain("target-run");
    });
  });

  test("createMcpServer returns a configured server", () => {
    const server = createMcpServer();
    expect(server).toBeDefined();
  });
});
