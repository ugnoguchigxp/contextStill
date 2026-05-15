import { describe, expect, test, vi, beforeEach } from "vitest";
import { embedOne, embeddingHealth } from "../src/modules/embedding/embedding.service.js";
import { config } from "../src/config.js";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

type ExecFileCallback = (error: Error | null, result?: { stdout: string }) => void;

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

describe("Embedding Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("embedOne", () => {
    test("calls daemon provider when configured", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: [new Array(384).fill(0.1)],
          dimension: 384,
        }),
      } as unknown as Response);

      const vector = await embedOne("test text", "query");
      expect(vector).toHaveLength(384);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/embed"),
        expect.objectContaining({ method: "POST" }),
      );
    });

    test("falls back to CLI when daemon fails", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Daemon down"));
      vi.mocked(execFile).mockImplementation(((
        _path: unknown,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ): void => {
        (callback as ExecFileCallback)(null, {
          stdout: JSON.stringify([{ embedding: new Array(384).fill(0.2) }]),
        });
      }) as unknown as typeof execFile);

      const vector = await embedOne("test text", "query");
      expect(vector[0]).toBe(0.2);
      expect(execFile).toHaveBeenCalled();
    });

    test("throws when both providers fail", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Daemon down"));
      vi.mocked(execFile).mockImplementation(((
        _path: unknown,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ): void => {
        (callback as ExecFileCallback)(new Error("CLI error"));
      }) as unknown as typeof execFile);

      await expect(embedOne("test text", "query")).rejects.toThrow("Daemon down; cli: CLI error");
    });
  });

  describe("embeddingHealth", () => {
    test("reports healthy status when daemon and cli are available", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as unknown as Response);
      vi.mocked(access).mockResolvedValue(undefined);

      const health = await embeddingHealth();
      expect(health.daemon.reachable).toBe(true);
      expect(health.cli.usable).toBe(true);
    });

    test("reports unhealthy status when both are down", async () => {
      vi.mocked(fetch).mockRejectedValue(new Error("Failed"));
      vi.mocked(access).mockRejectedValue(new Error("No access"));

      const health = await embeddingHealth();
      expect(health.daemon.reachable).toBe(false);
      expect(health.cli.usable).toBe(false);
    });
  });
});
