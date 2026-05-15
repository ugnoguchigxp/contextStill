import { describe, expect, test, vi, beforeEach } from "vitest";
import { runDoctor } from "../src/modules/doctor/doctor.service.js";
import { getDb } from "../src/db/index.js";
import { embeddingHealth } from "../src/modules/embedding/embedding.service.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";

vi.mock("../src/db/index.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("node:child_process");
vi.mock("node:fs/promises");
vi.mock("../src/mcp/tools/index.js", () => ({
  getExposedToolEntries: vi.fn(() => [
    { name: "initial_instructions" },
    { name: "context_compile" },
    { name: "search_knowledge" },
    { name: "register_knowledge" },
    { name: "memory_search" },
    { name: "memory_fetch" },
    { name: "doctor" },
  ]),
}));

const mockDb = {
  execute: vi.fn(),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
};

describe("Doctor Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue(mockDb as unknown as never);
    vi.mocked(embeddingHealth).mockResolvedValue({
      configured: true,
      provider: "daemon",
      dimension: 384,
      daemon: { reachable: true, url: "http://localhost" },
      cli: {
        python: "/usr/bin/python3",
        root: "/opt/embedding",
        modelDir: "/opt/embedding/models",
        usable: false,
      },
    } as unknown as never);
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(execFileSync).mockReturnValue("state = running");

    // Default successful DB responses
    vi.mocked(mockDb.execute).mockResolvedValue({
      rows: [{ ok: 1 }, { installed: true }, { table_name: "knowledge_items" }],
    } as unknown as never);
    vi.mocked(mockDb.limit).mockResolvedValue([]);
  });

  test("returns ok status when everything is healthy", async () => {
    vi.mocked(mockDb.execute).mockResolvedValue({
      rows: [
        {
          table_name: "knowledge_items",
          ok: 1,
          installed: true,
          count: 0,
          total_runs: 0,
          ok_runs: 0,
          skipped_runs: 0,
          failed_runs: 0,
          last_run_at: new Date().toISOString(),
        },
        { table_name: "sources" },
        { table_name: "source_fragments" },
        { table_name: "knowledge_source_links" },
        { table_name: "vibe_memories" },
        { table_name: "agent_diff_entries" },
        { table_name: "vibe_memory_distillation_runs" },
        { table_name: "source_distillation_runs" },
        { table_name: "source_distillation_evidence" },
        { table_name: "context_compile_runs" },
        { table_name: "context_pack_items" },
        { table_name: "sync_states" },
      ],
    } as unknown as never);

    const report = await runDoctor();
    expect(report.status).toBeDefined();
    expect(report.checkedAt).toBeDefined();
  });

  test("returns failed status when DB is unreachable", async () => {
    vi.mocked(mockDb.execute).mockRejectedValueOnce(new Error("Connection refused"));

    const report = await runDoctor();
    expect(report.status).toBe("failed");
    expect(report.reasons).toContain("DB_UNREACHABLE");
  });
});
